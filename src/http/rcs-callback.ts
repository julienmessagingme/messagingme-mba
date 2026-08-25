import type { FastifyInstance } from 'fastify';
import { parseRcsDlr, parseRcsMo, estDlr } from '../rcs/callback';
import type { RcsDlr, RcsMo } from '../rcs/callback';

/** Corps d'un rappel : quelques kilo-octets au plus (un message et son statut). Un corps plus gros n'est pas
 *  un rappel smsmode, on refuse avant de l'avoir en mémoire. */
const TAILLE_MAX_CORPS = 64 * 1024;

/** Forme du code d'URL. Vérifiée AVANT la base : cette adresse reçoit des scans, aucune raison de leur offrir
 *  une requête SQL par essai. */
const CODE_RE = /^rcs-[0-9a-f]{12,64}$/;

export interface RcsCallbackRouteDeps {
  /** Workspace et agent portés par le code d'URL. null = code inconnu. */
  parCode(code: string): Promise<{ tenantId: string; agentId: string } | null>;
  /** Rapport de livraison d'un message sortant. */
  onDlr(tenantId: string, dlr: RcsDlr): Promise<void>;
  /** Message entrant (texte, bouton tapé, position, fichier). */
  onMo(tenantId: string, mo: RcsMo): Promise<void>;
  /**
   * Garde le dernier corps reçu, AVANT toute tentative de lecture. Best-effort : une trace ratée ne doit pas
   * faire perdre le rappel lui-même. Optionnelle (câblages de test).
   */
  noterRappel?(tenantId: string, corps: unknown): Promise<void>;
}

/**
 * Rappels smsmode du canal RCS : rapports de livraison (DLR) et messages entrants (MO), sur une seule adresse.
 *
 * URL publique : `https://mba.messagingme.app/api/backend/rcs/callback/<code>` (même chemin d'exposition que
 * les webhooks entrants, via la réécriture de mba-web : l'API n'a aucun port publié).
 *
 * 🔴 CE QUI AUTORISE L'APPEL. smsmode NE SIGNE PAS ses rappels. Il n'y a donc ni HMAC à vérifier ni jeton à
 * comparer, et deux gardes remplacent la signature :
 *   1. le CODE de l'URL, opaque et propre à un workspace, qui porte le tenant (jamais le corps, jamais un
 *      identifiant deviné dans le JSON) ;
 *   2. le `channelId` du corps, qui doit être l'agent de CE workspace, QUAND il est présent.
 *
 * ⚠️ Ne pas se tromper sur la portée de la deuxième garde. Elle arrête un corps HONNÊTE destiné à un autre
 * client. Elle n'arrête PAS un corps FORGÉ : il suffit d'omettre l'objet `channel` pour qu'elle ne se
 * déclenche pas. Le code de l'URL est donc la SEULE authentification réelle de cette route, qui reste la
 * seule écriture non signée du produit : il se traite comme un secret (jamais journalisé, rotation possible).
 *
 * Exiger `channelId` rendrait la garde vraie, mais un seul corps réel est capturé en production à ce jour
 * (`rcs_agents.last_callback`, un rapport de livraison, qui le porte bien) : trop peu pour risquer de jeter
 * de vraies réponses clientes sur un canal LIVE. On JOURNALISE donc les corps sans `channelId`, et le
 * passage en exigence stricte se décidera sur ces journaux, pas sur une intuition.
 *
 * 🔴 CODES DE RETOUR. smsmode réessaie six fois sur tout ce qui n'est pas 2xx (30 s, 2 min, 10 min, 1 h, 5 h,
 * 24 h), puis abandonne. On répond donc :
 *   - 200 sur un corps qu'on ne sait pas exploiter : le rejouer six fois ne le rendra pas lisible ;
 *   - 404 sur un code inconnu : rien ne le rendra connu non plus, mais l'insistance doit rester visible ;
 *   - et on LAISSE remonter une panne interne (500) pour qu'ils rejouent, plutôt que d'acquitter un
 *     événement qu'on n'a pas su traiter. Un accusé de livraison perdu, c'est une cascade de repli qui ne
 *     part jamais.
 */
export function registerRcsCallback(app: FastifyInstance, deps: RcsCallbackRouteDeps): void {
  app.post('/rcs/callback/:code', { bodyLimit: TAILLE_MAX_CORPS }, async (req, reply) => {
    const { code } = req.params as { code: string };
    const normalise = typeof code === 'string' ? code.trim().toLowerCase() : '';
    if (!CODE_RE.test(normalise)) return reply.code(404).send({ error: 'canal introuvable' });

    const canal = await deps.parCode(normalise);
    if (!canal) return reply.code(404).send({ error: 'canal introuvable' });

    const payload = req.body;
    // Tracé AVANT d'essayer de le comprendre : c'est ce corps-là qu'on voudra lire le jour où notre lecture
    // se trompe, et c'est exactement ce qui a manqué le 2026-08-24. Best-effort, jamais bloquant.
    if (deps.noterRappel) {
      await deps.noterRappel(canal.tenantId, payload).catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error('trace du rappel RCS ignorée:', err instanceof Error ? err.message : err);
      });
    }
    const estRapport = estDlr(payload);
    const evenement = estRapport ? parseRcsDlr(payload) : parseRcsMo(payload);
    // Corps illisible : 200 (cf. en-tête). On le journalise, sinon un rappel qui n'arrive « nulle part » est
    // indébogable, et c'est exactement le symptôme qu'on cherchera si un jour leur format bouge.
    if (!evenement) {
      // Le CORPS est journalisé, borné. Une ligne qui dit seulement « non exploitable » ne permet de rien
      // comprendre : c'est la leçon du 2026-08-24. Il est aussi gardé en base (`noterRappel`), le log ne
      // servant qu'à le voir tout de suite.
      // eslint-disable-next-line no-console
      console.error(`rappel RCS non exploitable pour ${canal.tenantId} : ${JSON.stringify(payload).slice(0, 1500)}`);
      return reply.code(200).send({ ok: true, ignore: 'corps non exploitable' });
    }

    // Garde d'isolation : le canal du corps doit être celui de l'agent du workspace. PRÉSENT et différent
    // -> refus net. ABSENT -> on accepte, mais on le DIT : c'est ce compteur qui dira si l'on peut un jour
    // exiger le champ (et fermer la porte au corps forgé) sans jeter de vraies réponses clientes.
    if (evenement.channelId === null) {
      // eslint-disable-next-line no-console
      console.warn(`rappel RCS sans channelId (workspace ${canal.tenantId}) : garde d'isolation inopérante sur ce corps`);
    } else if (evenement.channelId !== canal.agentId) {
      return reply.code(403).send({ error: 'canal étranger à ce workspace' });
    }

    if (estRapport) await deps.onDlr(canal.tenantId, evenement as RcsDlr);
    else await deps.onMo(canal.tenantId, evenement as RcsMo);
    return reply.code(200).send({ ok: true });
  });
}
