import type { FastifyInstance } from 'fastify';
import { gardeEtendue, makeRequireRole, type Guard } from '../auth/middleware';
import { RateLimiter } from '../auth/rate-limit';
import { scopeTenant } from './scope';
import { QUESTION_MAX_CARACTERES, type QuestionAide, type ReponseAide } from '../aide/repondre';
import { creerCacheRecap } from '../aide/recap-cache';
import type { RecapTexte } from '../aide/recap-rendu';
import { resoudre } from '../aide/carte';
import { addDays, todayParis } from '../stats/range';

/**
 * LE BOT D'AIDE DE LA CONSOLE : une route, synchrone.
 *
 * 🔴 SYNCHRONE ET PAS UNE FILE, contrairement à tout ce qui envoie des messages dans ce dépôt : la personne
 * attend devant son écran. Un travail de file lui ferait regarder une bulle qui tourne pendant qu'un worker
 * prend le job, pour un gain nul.
 *
 * 🔴 IL N'ÉCRIT RIEN, JAMAIS. Il répond et il pose des liens vers des écrans. C'est le périmètre tranché par
 * Julien le 2026-09-11, et c'est le seul où une réponse fausse ne coûte qu'un aller-retour.
 *
 * ⚠️ LES TOKENS SONT À NOTRE CHARGE (décision du 2026-09-11) : le répondeur utilise la clé MAISON, pas le
 * crédit prépayé du client. Facturer quelqu'un pour apprendre à se servir du produit se retourne contre
 * nous, celui qui hésite à poser une question étant celui qui abandonne. Le plafond d'équipe posé chez
 * Vercel borne la dépense globale ; le plafond de débit ci-dessous empêche un seul espace de la consommer
 * pour tout le monde.
 */
export interface AideRouteDeps {
  /** Absent = l'aide n'est pas configurée (clé du Gateway ou modèle manquant) -> 503, jamais un repli muet. */
  repondre?(q: QuestionAide): Promise<ReponseAide>;
  /** Absent = le récap n'est pas branché (pas de base) -> 503. Voir `RecapRouteDeps`. */
  recap?: RecapRouteDeps;
}

export interface RecapRouteDeps {
  /**
   * Calcule ET rédige le récap d'un jour, pour un espace.
   *
   * 🔴 LE JOUR EST CHOISI PAR LA ROUTE, JAMAIS PAR LE CLIENT. Le récap porte sur la veille et rien d'autre :
   * pas d'historique, pas de choix de date, pas de relecture d'avant-hier (décision de Julien du 2026-09-12,
   * « sinon trop compliqué »). Laisser le client nommer le jour rouvrirait une lecture de toute l'histoire
   * de l'espace depuis un bouton d'aide, ce qui n'est pas ce qu'on a construit.
   */
  calculer(tenantId: string, jour: string, langue: 'fr' | 'en'): Promise<RecapTexte>;
  /** Le jour civil courant dans le fuseau des stats. Injectable : c'est ce qui rend le cache testable. */
  aujourdhui?(): string;
}

/**
 * Où le récap emmène.
 *
 * ⚠️ RÉSOLU DANS LA ROUTE ET PAS DANS LE TEXTE MIS EN CACHE, parce qu'il dépend du RÔLE : le tableau
 * qualitatif est marqué `adminOnly` dans la carte, donc un manager n'y a pas de lien. Mettre les écrans dans
 * ce qu'on met en cache ferait servir à tout l'espace les liens du premier qui a cliqué.
 */
const ECRANS_RECAP = ['dashboard-quali'];

/**
 * Qui a droit au récap.
 *
 * 🔴 LA GARDE EST CÔTÉ SERVEUR, et masquer le bouton n'est pas un contrôle d'accès. Le récap est un artefact
 * de PILOTAGE, pas un outil de traitement : un opérateur (rôle `agent`, qui ne voit que l'Inbox) n'y a pas
 * droit, et c'est la première fois que le rôle décide de ce qu'on a le droit de LIRE et pas seulement des
 * écrans qu'on a le droit de montrer.
 *
 * ⚠️ Le message de refus de `makeRequireRole` parle d'administrateurs alors que les managers passent aussi.
 * C'est le message commun à toutes les routes de rôle du dépôt, et il reste juste pour qui le reçoit : un
 * opérateur refusé apprend que c'est réservé à l'encadrement, ce qui est exactement le cas.
 */
const ROLES_RECAP = ['admin', 'manager'] as const;

/**
 * Le plafond de débit de cette route.
 *
 * ⚠️ CLÉ = L'ESPACE, ET NON L'UTILISATEUR, contrairement au plafond ordinaire des routes authentifiées.
 * Chaque question coûte un appel de modèle sur NOTRE clé : ce qu'on protège, c'est notre facture, et c'est
 * l'espace qui la consomme. Vingt par minute laissent une équipe entière travailler et arrêtent une boucle.
 */
const PAR_MINUTE = 20;

/** Combien d'échanges passés la route accepte. Le moteur en garde autant, ce plafond-ci borne la REQUÊTE. */
const MAX_ECHANGES_RECUS = 4;
/** Une réponse du bot tient largement là-dedans ; au-delà, c'est un appelant qui gonfle le prompt. */
const REPONSE_MAX_CARACTERES = 4_000;

export function registerAide(app: FastifyInstance, deps: AideRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };
  const limiter = new RateLimiter(PAR_MINUTE, 60_000);
  const cacheRecap = creerCacheRecap<RecapTexte>();

  app.post('/tenants/:tenantId/aide', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (!limiter.take(tenant)) {
      return reply.code(429).send({ error: 'trop de questions d’un coup, réessaie dans une minute' });
    }
    if (!deps.repondre) return reply.code(503).send({ error: 'aide indisponible (non configurée)' });

    const b = (req.body ?? {}) as { question?: unknown; ecranCourant?: unknown; langue?: unknown; historique?: unknown };
    const question = typeof b.question === 'string' ? b.question.trim() : '';
    if (question === '') return reply.code(400).send({ error: 'question requise' });
    // 4xx et pas 5xx : Cloudflare remplace le corps de toute réponse 5xx par sa page d'erreur, et le client
    // ne lirait jamais la raison.
    if (question.length > QUESTION_MAX_CARACTERES) {
      return reply.code(400).send({ error: `question trop longue (${QUESTION_MAX_CARACTERES} caractères maximum)` });
    }

    // 🔴 LE RÔLE VIENT DU JETON, JAMAIS DU CORPS. C'est lui qui décide des écrans qu'on a le droit de
    // montrer : le lire dans la requête laisserait n'importe qui se déclarer administrateur pour obtenir la
    // carte complète de la console.
    const role = req.auth?.role ?? 'agent';
    const ecranCourant = typeof b.ecranCourant === 'string' && b.ecranCourant.trim() !== ''
      ? b.ecranCourant.trim().slice(0, 60) : null;
    const langue = b.langue === 'en' ? 'en' : 'fr';

    /**
     * L'historique de la conversation, envoyé par l'écran.
     *
     * ⚠️ IL VIENT DU CLIENT, donc il est BORNÉ ici et pas seulement dans le moteur : un appelant qui pousse
     * mille échanges ferait grossir le prompt, donc NOTRE facture, sans qu'aucune garde ne l'arrête. Quatre
     * échanges, chacun aux mêmes bornes qu'une question et qu'une réponse.
     *
     * ⚠️ Et il est VALIDÉ forme par forme plutôt que pris tel quel : une entrée dont un champ n'est pas une
     * chaîne est ignorée, pas devinée.
     */
    const brut = Array.isArray(b.historique) ? b.historique : [];
    const historique = brut
      .filter((e): e is { question: string; reponse: string } => typeof e === 'object' && e !== null
        && typeof (e as { question?: unknown }).question === 'string'
        && typeof (e as { reponse?: unknown }).reponse === 'string')
      .slice(-MAX_ECHANGES_RECUS)
      .map((e) => ({
        question: e.question.slice(0, QUESTION_MAX_CARACTERES),
        reponse: e.reponse.slice(0, REPONSE_MAX_CARACTERES),
      }));

    try {
      const r = await deps.repondre({ question, role, langue, ecranCourant, historique });
      return reply.code(200).send(r);
    } catch (err) {
      // JOURNALISER AVANT DE MASQUER, comme le formulaire de support. Un `catch` nu avalerait aussi bien une
      // panne du Gateway qu'une faute de programmation, et les deux rendraient le même message pendant que
      // la personne réessaierait indéfiniment.
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({
        lvl: 'error',
        msg: 'aide_echec',
        tenant,
        err: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      }));
      return reply.code(502).send({ error: 'aide indisponible pour le moment' });
    }
  });

  /**
   * LE RÉCAP DE LA VEILLE.
   *
   * ⚠️ IL PARTAGE LE PLAFOND DE DÉBIT DE LA QUESTION, ET C'EST VOULU. Un récap coûte plus cher qu'une
   * question, mais il n'est calculé qu'UNE FOIS par espace et par jour : les appels suivants lisent le
   * cache, y compris ceux qui arrivent pendant que le premier calcule. Ce qu'il faut borner, c'est donc
   * l'entrée commune vers notre clé, pas ce chemin-ci en particulier.
   */
  app.post('/tenants/:tenantId/aide/recap', gardeEtendue(garde, makeRequireRole(ROLES_RECAP)), async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (!limiter.take(tenant)) {
      return reply.code(429).send({ error: 'trop de demandes d’un coup, réessaie dans une minute' });
    }
    const recap = deps.recap;
    if (!recap) return reply.code(503).send({ error: 'récap indisponible (non configuré)' });

    // LA VEILLE, calculée ici et jamais reçue du client. `todayParis` est le jour civil du fuseau des stats,
    // celui dans lequel le SQL du récap borne ses journées : les deux doivent parler du même jour.
    const jour = addDays((recap.aujourdhui ?? todayParis)(), -1);
    const langue = ((req.body ?? {}) as { langue?: unknown }).langue === 'en' ? 'en' : 'fr';
    const role = req.auth?.role ?? 'agent';
    try {
      const t = await cacheRecap.lire(tenant, jour, langue, () => recap.calculer(tenant, jour, langue));
      // La même forme qu'une réponse d'aide : le fil de la console l'affiche sans chemin de rendu à part.
      return reply.code(200).send({
        sait: true, texte: t.texte, sources: [], ecrans: resoudre(ECRANS_RECAP, role),
      } satisfies ReponseAide);
    } catch (err) {
      // Journaliser avant de masquer, comme la question juste au-dessus.
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({
        lvl: 'error',
        msg: 'aide_recap_echec',
        tenant,
        jour,
        err: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      }));
      return reply.code(502).send({ error: 'récap indisponible pour le moment' });
    }
  });
}
