import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import { RateLimiter } from '../auth/rate-limit';
import { scopeTenant } from './scope';
import { QUESTION_MAX_CARACTERES, type QuestionAide, type ReponseAide } from '../aide/repondre';

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
}

/**
 * Le plafond de débit de cette route.
 *
 * ⚠️ CLÉ = L'ESPACE, ET NON L'UTILISATEUR, contrairement au plafond ordinaire des routes authentifiées.
 * Chaque question coûte un appel de modèle sur NOTRE clé : ce qu'on protège, c'est notre facture, et c'est
 * l'espace qui la consomme. Vingt par minute laissent une équipe entière travailler et arrêtent une boucle.
 */
const PAR_MINUTE = 20;

export function registerAide(app: FastifyInstance, deps: AideRouteDeps, requireAuth?: Guard): void {
  const guard = requireAuth ? { preHandler: requireAuth } : {};
  const limiter = new RateLimiter(PAR_MINUTE, 60_000);

  app.post('/tenants/:tenantId/aide', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (!limiter.take(tenant)) {
      return reply.code(429).send({ error: 'trop de questions d’un coup, réessaie dans une minute' });
    }
    if (!deps.repondre) return reply.code(503).send({ error: 'aide indisponible (non configurée)' });

    const b = (req.body ?? {}) as { question?: unknown; ecranCourant?: unknown; langue?: unknown };
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

    try {
      const r = await deps.repondre({ question, role, langue, ecranCourant });
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
}
