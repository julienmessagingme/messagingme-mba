import type { FastifyInstance } from 'fastify';
import { parseRcsDlr, parseRcsMo, estDlr } from '../rcs/callback';
import type { RcsDlr, RcsMo } from '../rcs/callback';
import { consommerAvecEntetes, type RateLimiter } from '../auth/rate-limit';

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
 * comparer, et trois gardes remplacent la signature :
 *   1. le CODE de l'URL, opaque et propre à un workspace, qui porte le tenant (jamais le corps, jamais un
 *      identifiant deviné dans le JSON) ; il se traite comme un secret (jamais journalisé) ;
 *   2. un PLAFOND de requêtes par code EXISTANT : une adresse qui fuite ne devient pas un robinet d'écritures ;
 *   3. le `channelId` du corps, EXIGÉ, qui doit être l'agent de CE workspace.
 *
 * 🔴 LE `channelId` EST EXIGÉ DEPUIS LE 2026-09-21, et c'est ce qui rend la troisième garde vraie. Tant qu'il
 * était seulement vérifié QUAND il était présent, un corps FORGÉ n'avait qu'à omettre l'objet `channel` pour
 * être traité : une bulle dans le fil de n'importe quel numéro du workspace, un opt-out RCS, un parcours qui
 * avance (audit d'étanchéité du 2026-08-25). La décision a été prise sur les VRAIS rappels, comme cet en-tête
 * l'exigeait : les 11 reçus le 2026-09-21, dont 3 messages entrants, le portaient tous, comme le dernier corps
 * gardé en base. Un corps légitime qui ne le porterait pas est REFUSÉ (403, rejoué six fois par smsmode puis
 * abandonné), mais pas perdu de vue : `noterRappel` l'a gardé avant la garde, et il est journalisé ici.
 *
 * ⚠️ Ce qui reste vrai : le `channelId` d'un agent n'est pas un secret (il circule dans chaque corps). Le CODE
 * demeure l'authentification principale ; le `channelId` empêche seulement qu'un corps soit accepté sans
 * désigner explicitement l'agent de ce workspace.
 *
 * 🔴 CODES DE RETOUR. smsmode réessaie six fois sur tout ce qui n'est pas 2xx (30 s, 2 min, 10 min, 1 h, 5 h,
 * 24 h), puis abandonne. On répond donc :
 *   - 200 sur un corps qu'on ne sait pas exploiter : le rejouer six fois ne le rendra pas lisible ;
 *   - 404 sur un code inconnu : rien ne le rendra connu non plus, mais l'insistance doit rester visible ;
 *   - 429 au-delà du plafond du code : smsmode rejoue plus tard, un vrai accusé est retardé, pas perdu ;
 *   - et on LAISSE remonter une panne interne (500) pour qu'ils rejouent, plutôt que d'acquitter un
 *     événement qu'on n'a pas su traiter. Un accusé de livraison perdu, c'est une cascade de repli qui ne
 *     part jamais.
 */
export function registerRcsCallback(app: FastifyInstance, deps: RcsCallbackRouteDeps, limiteur: RateLimiter): void {
  app.post('/rcs/callback/:code', { bodyLimit: TAILLE_MAX_CORPS }, async (req, reply) => {
    const { code } = req.params as { code: string };
    const normalise = typeof code === 'string' ? code.trim().toLowerCase() : '';
    if (!CODE_RE.test(normalise)) return reply.code(404).send({ error: 'canal introuvable' });

    const canal = await deps.parCode(normalise);
    if (!canal) return reply.code(404).send({ error: 'canal introuvable' });

    /**
     * 🔴 LE PLAFOND NE COMPTE QUE DES CODES QUI EXISTENT, donc APRÈS la base, et c'est une correction de revue.
     * Posé d'abord AVANT la lecture, il comptait n'importe quel code bien formé : un robot qui tire plus de
     * codes inventés par minute que la table n'en retient la remplissait, et le VRAI code d'un client, dont
     * l'entrée expire à chaque fenêtre, se voyait alors refusé. La protection devenait un moyen de bloquer
     * les messages RCS entrants. Ici, la table ne contient que des codes réels, en nombre borné par celui des
     * agents : aucune éviction possible. Un code inventé coûte une lecture par clé, comme avant ce plafond ;
     * ce qu'on protège d'un code qui a FUITÉ, ce sont les écritures qui suivent.
     */
    if (!(await consommerAvecEntetes(limiteur, normalise, reply, 'trop de rappels, réessayez plus tard'))) return;

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

    // Garde d'isolation : le corps doit désigner l'agent de CE workspace. ABSENT -> refus (cf. en-tête : c'est
    // la forme d'un corps forgé), et le corps est journalisé, borné, pour qu'un rappel légitime refusé à tort se
    // voie tout de suite. Présent et différent -> refus net.
    if (evenement.channelId === null) {
      // eslint-disable-next-line no-console
      console.error(`rappel RCS REFUSÉ, sans channelId (workspace ${canal.tenantId}) : ${JSON.stringify(payload).slice(0, 1500)}`);
      return reply.code(403).send({ error: 'canal absent du rappel' });
    }
    if (evenement.channelId !== canal.agentId) {
      return reply.code(403).send({ error: 'canal étranger à ce workspace' });
    }

    if (estRapport) await deps.onDlr(canal.tenantId, evenement as RcsDlr);
    else await deps.onMo(canal.tenantId, evenement as RcsMo);
    return reply.code(200).send({ ok: true });
  });
}
