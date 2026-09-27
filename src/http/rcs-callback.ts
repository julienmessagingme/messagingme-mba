import type { FastifyInstance } from 'fastify';
import { parseRcsDlr, parseRcsMo, estDlr } from '../rcs/callback';
import type { RcsDlr, RcsMo } from '../rcs/callback';
import { ClesResolues, avertissementBorne, consommerAvecEntetes, consommerEnSilence, type RateLimiter } from '../auth/rate-limit';
import { messageDe } from '../lib/erreur';

/** Corps d'un rappel : quelques kilo-octets au plus (un message et son statut). Un corps plus gros n'est pas
 *  un rappel smsmode, on refuse avant de l'avoir en mémoire. */
const TAILLE_MAX_CORPS = 64 * 1024;

/** Forme du code d'URL. Vérifiée avant la base : cette adresse reçoit des scans, aucune raison de leur offrir
*  une requête SQL par essai. */
const CODE_RE = /^rcs-[0-9a-f]{12,64}$/;

export interface RcsCallbackRouteDeps {
  /** Les canaux RCS des espaces. */
  agents: {
    /** Workspace et agent portés par le code d'URL. null = code inconnu. */
    parWebhookCode(code: string): Promise<{ tenantId: string; agentId: string } | null>;
    /**
     * Garde le dernier corps reçu, avant toute tentative de lecture. Au mieux : une trace ratée ne doit pas faire
     * perdre le rappel lui-même.
     */
    noterRappel(tenantId: string, corps: unknown): Promise<void>;
  };
  /** Rapport de livraison d'un message sortant. */
  onDlr(tenantId: string, dlr: RcsDlr): Promise<void>;
  /** Message entrant (texte, bouton tapé, position, fichier). */
  onMo(tenantId: string, mo: RcsMo): Promise<void>;
}

/**
 * Rappels smsmode du canal RCS : rapports de livraison (DLR) et messages entrants (MO), sur une seule adresse.
 *
 * 🔴 Ce qui autorise l'appel : smsmode ne signe pas ses rappels, trois gardes remplacent la signature (plus un
 * frein, avant la base, sur les codes jamais vus) :
 *   1. le code de l'URL, opaque et propre à un espace, qui porte l'espace (jamais le corps) ; c'est un secret,
 *      jamais journalisé ;
 *   2. un plafond de requêtes par code existant : une adresse qui fuite ne devient pas un robinet d'écritures ;
 *   3. le `channelId` du corps, exigé, qui doit être l'agent de cet espace : un corps forgé sans lui ferait
 *      écrire dans n'importe quel fil de l'espace. Il n'est pas secret, il empêche seulement un corps de ne
 *      désigner aucun agent. Un corps refusé ici reste lisible (`noterRappel` l'a gardé avant la garde).
 *
 * Codes de retour : smsmode réessaie six fois tout ce qui n'est pas 2xx, puis abandonne.
 *   - 200 sur un corps inexploitable (le rejouer ne le rendra pas lisible) ;
 *   - 404 sur un code inconnu ;
 *   - 429 au-delà du plafond du code ou du budget des codes jamais vus : rejoué plus tard, pas perdu ;
 *   - 500 laissé remonter sur une panne interne, pour qu'ils rejouent : un accusé perdu est une cascade de
 *     repli qui ne part jamais.
 */
export function registerRcsCallback(
  app: FastifyInstance,
  deps: RcsCallbackRouteDeps,
  limiteur: RateLimiter,
  /** Le budget commun des codes jamais vus, pris avant la base (`CODES_INCONNUS_PAR_MINUTE`). Requis. */
  budgetInconnus: RateLimiter,
): void {
  // Les codes déjà résolus par ce process : ils échappent au budget des codes jamais vus (`ClesResolues`).
  const connus = new ClesResolues(1000);
  const avertirBudget = avertissementBorne(
    'rappels RCS : budget des codes jamais vus épuisé (CODES_INCONNUS_PAR_MINUTE), des codes inconnus reçoivent 429',
  );
  app.post('/rcs/callback/:code', { bodyLimit: TAILLE_MAX_CORPS }, async (req, reply) => {
    const { code } = req.params as { code: string };
    const normalise = typeof code === 'string' ? code.trim().toLowerCase() : '';
    if (!CODE_RE.test(normalise)) return reply.code(404).send({ error: 'canal introuvable' });

    // Le frein des codes jamais vus, avant la base (même mécanique que `/w/:code`). Un code déjà résolu passe
    // toujours ; un refus est un 429, que smsmode rejoue ; un budget épuisé se journalise au plus une fois par minute.
    const connu = connus.connait(normalise);
    if (!connu && !(await consommerEnSilence(budgetInconnus, 'codes-inconnus', reply, 'trop de rappels, réessayez plus tard'))) {
      avertirBudget();
      return;
    }

    /**
     * Le plafond ne compte que des codes qui existent : compté avant la lecture pour tous, un robot tirant des codes
     * inventés remplirait la table et ferait refuser le vrai code d'un client. Il se prend donc avant la base pour un
     * code déjà résolu par ce process, après pour les autres (la table ne contient alors que des codes réels).
     */
    const plafond = (): Promise<boolean> => consommerAvecEntetes(limiteur, normalise, reply, 'trop de rappels, réessayez plus tard');
    if (connu && !(await plafond())) return;

    const canal = await deps.agents.parWebhookCode(normalise);
    if (!canal) {
      connus.oublier(normalise);
      return reply.code(404).send({ error: 'canal introuvable' });
    }
    connus.retenir(normalise);
    // Première résolution dans ce process : le plafond se prend ici, sur un code qui existe.
    if (!connu && !(await plafond())) return;

    const payload = req.body;
    // Tracé avant d'essayer de le comprendre : c'est ce corps qu'on voudra lire le jour où notre lecture se
    // trompe. Au mieux, jamais bloquant.
    await deps.agents.noterRappel(canal.tenantId, payload).catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error('trace du rappel RCS ignorée:', messageDe(err));
    });
    const estRapport = estDlr(payload);
    const evenement = estRapport ? parseRcsDlr(payload) : parseRcsMo(payload);
    // Corps illisible : 200 (cf. en-tête). On le journalise, sinon un rappel qui n'arrive « nulle part » est
    // indébogable, et c'est exactement le symptôme qu'on cherchera si un jour leur format bouge.
    if (!evenement) {
      // Le corps est journalisé, borné (une ligne « non exploitable » seule n'aide à rien) ; il est aussi gardé en
      // base par `noterRappel`, le log ne servant qu'à le voir tout de suite.
      // eslint-disable-next-line no-console
      console.error(`rappel RCS non exploitable pour ${canal.tenantId} : ${JSON.stringify(payload).slice(0, 1500)}`);
      return reply.code(200).send({ ok: true, ignore: 'corps non exploitable' });
    }

    // 🔴 Garde d'isolation : le corps doit désigner l'agent de cet espace. Absent -> refus (forme d'un corps
    // forgé), corps journalisé, borné, pour qu'un refus à tort se voie. Présent et différent -> refus net.
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
