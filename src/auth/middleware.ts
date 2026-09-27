import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifySession } from './token';
import type { Session } from './token';
import { timingSafeEqualStr } from '../lib/signature';
import { ipIndicative, type SurveillanceOps } from '../ops/tentatives';
import { consommerAvecEntetes, type RateLimiter } from './rate-limit';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: Session;
  }
}

export type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
/** Une garde de route : un preHandler seul, ou une chaîne exécutée dans l'ordre (Fastify
 *  court-circuite dès qu'un maillon répond). Sert à composer [requireAuth, requireRole]. */
export type Guard = PreHandler | PreHandler[];

/** Relit l'état d'auth courant du compte en base. null = compte supprimé. `tenantStatus` (optionnel) porte le
 *  statut de l'espace pour le crochet de barrage (locked -> accès coupé). */
export type UserStateLoader = (userId: string, tenantId: string) => Promise<{ role: string; disabled: boolean; tenantStatus?: string } | null>;

/**
 * Garde de rôle à utiliser dans un handler déjà authentifié : rend true (et répond 403) si l'appelant n'est
 * pas admin.
 */
export function forbidNonAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.auth && req.auth.role !== 'admin') {
    void reply.code(403).send({ error: 'action réservée aux administrateurs' });
    return true;
  }
  return false;
}

/**
 * preHandler de groupe : exige que `req.auth.role` soit dans `roles`. À composer après `makeRequireAuth`,
 * dont il suppose `req.auth` ; 401 défensif si l'auth manque, 403 si le rôle n'est pas autorisé.
 */
export function makeRequireRole(roles: readonly string[]): PreHandler {
  const allowed = new Set(roles);
  return async function requireRole(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!req.auth) {
      await reply.code(401).send({ error: 'authentification requise' });
      return;
    }
    if (!allowed.has(req.auth.role)) {
      await reply.code(403).send({ error: 'action réservée aux administrateurs' });
      return;
    }
  };
}

/**
 * preHandler de `/ops` : exige le header `x-ops-token` égal (en temps constant) à `OPS_TOKEN`. 401 si le
 * jeton attendu est vide (surface désactivée par défaut), absent ou faux. 🔴 Autorité distincte du JWT
 * tenant : un admin d'espace n'atteint pas `/ops`, et réciproquement.
 */
export function makeRequireOps(opsToken: string, surveillance?: SurveillanceOps): PreHandler {
  return async function requireOps(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const raw = req.headers['x-ops-token'];
    const provided = Array.isArray(raw) ? raw[0] : raw;
    if (!opsToken || !provided || !timingSafeEqualStr(provided, opsToken)) {
      // Signalé avant de répondre, sans rien attendre : `/ops` ouvre la lecture de tous les clients. Le jeton
      // présenté n'est jamais transmis (voir `ops/tentatives.ts`).
      surveillance?.refus({ chemin: req.url, ip: ipIndicative(req) });
      await reply.code(401).send({ error: 'ops: non autorisé' });
      return;
    }
  };
}

/**
 * preHandler qui exige un Bearer JWT valide et pose `req.auth` ; 401 sinon. 🔴 Les routes dérivent le tenant
 * de `req.auth`, jamais de l'URL.
 *
 * `loadState` relit l'état du compte en base à chaque requête : compte supprimé ou révoqué, 401 immédiat ;
 * rôle rafraîchi (un changement prend effet tout de suite). Sans lui (tests sans base), vérification JWT
 * seule.
 */
export function makeRequireAuth(secret: string, loadState?: UserStateLoader, limiteur?: RateLimiter): PreHandler {
  return async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      await reply.code(401).send({ error: 'authentification requise' });
      return;
    }
    const session = await verifySession(token, secret);
    if (!session) {
      await reply.code(401).send({ error: 'token invalide ou expiré' });
      return;
    }
    // Le plafond se prend ici :
    //  - après `verifySession`, la clé étant `session.userId` : `req.ip` désigne le proxy (pas de
    //    `trustProxy`), un plafond sur lui serait global à la plateforme ;
    //  - avant `loadState` : un appelant qui martèle ne coûte pas une requête SQL par refus ;
    //  - avant la branche des sessions d'emprunt, qui sort par un `return` anticipé.
    if (limiteur && !(await consommerAvecEntetes(limiteur, session.userId, reply))) return;
    // 🔴 Session d'emprunt : lecture seule, quelle que soit la route. Une garde ici plutôt que route par route :
    // une route oubliée serait la faille. `GET` et `HEAD` seulement, une route d'écriture ajoutée demain comprise.
    if (session.impersonated === true) {
      const methode = req.method.toUpperCase();
      if (methode !== 'GET' && methode !== 'HEAD') {
        await reply.code(403).send({ error: 'session d’observation : lecture seule', code: 'impersonation_read_only' });
        return;
      }
      // Pas de relecture d'état : le porteur n'a pas de compte dans cet espace, le loader révoquerait la session.
      // Sa légitimité vient de sa signature, émise par `/ops`.
      req.auth = session;
      return;
    }
    if (loadState) {
      const state = await loadState(session.userId, session.tenantId);
      if (!state || state.disabled) {
        await reply.code(401).send({ error: 'session révoquée' });
        return;
      }
      // Barrage de paiement : un espace `locked` coupe l'accès à toutes les routes gardées ; on ne bloque que sur
      // 'locked' explicite.
      if (state.tenantStatus === 'locked') {
        await reply.code(403).send({ error: 'espace suspendu', code: 'tenant_locked' });
        return;
      }
      session.role = state.role; // rôle frais : les changements de rôle sont immédiats
    }
    req.auth = session;
  };
}

/**
 * preHandler des routes coûteuses (import CSV, action en masse, purge, export d'historique, lancement de
 * campagne), à composer après `makeRequireAuth`. La clé est le tenant, pas l'utilisateur : on borne la
 * charge qu'un espace envoie à Postgres, et un espace à dix comptes aurait sinon dix fois le plafond.
 * S'ajoute au plafond général sans le remplacer.
 */
export function makeLimiteParTenant(limiteur: RateLimiter, message?: string): PreHandler {
  return async function limiteParTenant(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    // 401 défensif : sans `req.auth`, la clé serait vide et tous les espaces partageraient le même compteur.
    if (!req.auth) {
      await reply.code(401).send({ error: 'authentification requise' });
      return;
    }
    await consommerAvecEntetes(limiteur, req.auth.tenantId, reply, message);
  };
}

/**
 * Options de route `{ preHandler }` : la garde, suivie de `extra` s'il est fourni. Aplatit la chaîne :
 * `[garde, extra]` avec une garde déjà en tableau donnerait un tableau imbriqué, que Fastify n'exécute pas,
 * en silence. 🔴 La garde est requise et `preHandler` toujours posé : jamais d'options de route sans garde.
 */
export function gardeEtendue(garde: Guard, extra?: PreHandler): { preHandler: Guard } {
  const base = Array.isArray(garde) ? garde : [garde];
  return { preHandler: extra ? [...base, extra] : base };
}
