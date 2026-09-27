import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Helpers partagés par toutes les routes de la console. `scopeTenant` n'a qu'un appelant, `etapeEspace` : le
 * contrôle d'espace est une étape posée au montage sur chaque route `:tenantId` des modules `acces: 'tenant'`,
 * et le handler lit l'espace vérifié par `espaceVerifie`, qui échoue fermé si l'étape manque.
 */

/**
 * Espace effectif = celui du JWT ; l'URL doit correspondre. `null` si interdit.
 * 🔴 Elle échoue fermé : sans `req.auth`, elle rend `null`, jamais l'espace de l'URL. Sinon elle ne serait un
 * contrôle que tant qu'une garde d'authentification a été posée ailleurs, et un montage sans garde distribuerait
 * à chacun l'espace qu'il demande. Une route à `:tenantId` qui doit être publique ne passe pas par ici.
 * `tests/scope-tenant.test.ts` vérifie, route par route, que toute route `:tenantId` d'un module `tenant` finit
 * par `etapeEspace` derrière une garde, et qu'une session d'un autre espace y est refusée.
 */
export function scopeTenant(req: { params: unknown; auth?: { tenantId: string } }): string | null {
  const { tenantId } = req.params as { tenantId: string };
  const authTenant = req.auth?.tenantId;
  if (authTenant === undefined) return null;
  return authTenant === tenantId ? authTenant : null;
}

/**
 * L'espace vérifié de chaque requête, posé par `etapeEspace` et lu par `espaceVerifie`. Une `WeakMap` privée et
 * non une propriété de la requête : rien d'autre que l'étape ne peut y écrire, et l'entrée meurt avec la requête.
 */
const espacesVerifies = new WeakMap<object, string>();

/**
 * 🔴 L'étape d'espace : le contrôle d'isolation entre clients, posé au montage. Même règle (`scopeTenant`), même
 * refus (403, `{ error: 'tenant interdit' }`). Ajoutée en dernier à la chaîne `preHandler` de la route, donc
 * après la garde d'authentification (qui pose `req.auth`), la garde de rôle et le plafond coûteux. Un
 * `addHook('preHandler')` de contexte tournerait avant les gardes de route (Fastify 5), sans `req.auth`, et
 * refuserait toute la console. `await` sur l'envoi : une réponse envoyée arrête la chaîne.
 */
export async function etapeEspace(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const tenant = scopeTenant(req);
  if (tenant === null) {
    await reply.code(403).send({ error: 'tenant interdit' });
    return;
  }
  espacesVerifies.set(req, tenant);
}

/**
 * L'espace de la requête, vérifié par `etapeEspace` : ce que lit chaque handler d'une route `:tenantId`.
 * 🔴 Il échoue fermé : si l'étape n'a pas tourné, il lève (500 opaque, `unhandled_route_error`), et ne rend
 * jamais l'espace de l'URL ni celui de la session sans les avoir comparés.
 */
export function espaceVerifie(req: object): string {
  const tenant = espacesVerifies.get(req);
  if (tenant === undefined) throw new Error('espaceVerifie : aucune étape d’espace n’a vérifié cette requête');
  return tenant;
}

/** L'état du poseur, un par instance Fastify : un seul hook `onRoute`, allumé le temps d'un montage. */
const poseurs = new WeakMap<FastifyInstance, { actif: boolean }>();

/**
 * Monte des routes en posant `etapeEspace` à la fin de la chaîne de chaque route dont l'adresse porte
 * `:tenantId`. Seul point de passage, en production (`entree` dans `src/server.ts`, modules `acces: 'tenant'`)
 * comme dans les tests.
 * 🔴 Le critère est la classe du module, puis le chemin, jamais le chemin seul : les routes `jeton-ops` portent
 * aussi `:tenantId` (`/ops/credits/:tenantId`), sans session, et l'étape les refuserait.
 * Toujours un nouveau tableau, jamais un `push` : la chaîne reçue est souvent partagée (`requireAdmin`), et un
 * `push` y empilerait l'étape pour toutes les routes de tous les modules.
 * `onRoute` est synchrone, d'où le drapeau allumé autour de `monter` : une route enregistrée plus tard (dans un
 * `app.register`) n'aurait pas l'étape et échouerait fermé. La route HEAD engendrée par un GET reçoit l'étape
 * une seule fois.
 */
export function monterAvecEtapeEspace(app: FastifyInstance, monter: () => void): void {
  let etat = poseurs.get(app);
  if (etat === undefined) {
    const nouveau = { actif: false };
    app.addHook('onRoute', (r) => {
      if (!nouveau.actif || !r.path.includes(':tenantId')) return;
      const chaine = r.preHandler === undefined ? [] : Array.isArray(r.preHandler) ? r.preHandler : [r.preHandler];
      r.preHandler = [...chaine, etapeEspace];
    });
    poseurs.set(app, nouveau);
    etat = nouveau;
  }
  const avant = etat.actif;
  etat.actif = true;
  try {
    monter();
  } finally {
    etat.actif = avant;
  }
}

/** Chaîne réellement renseignée (une chaîne d'espaces ne compte pas). */
export function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * Identifiant qui a la forme d'un uuid. Un identifiant de chemin part tel quel dans un `where id = $1` sur une
 * colonne `uuid` : mal formé, il fait lever Postgres (`22P02`), donc un 500. Une adresse tapée de travers doit
 * rendre 404.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function estUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}
