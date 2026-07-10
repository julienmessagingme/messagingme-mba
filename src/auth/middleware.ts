import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifySession } from './token';
import type { Session } from './token';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: Session;
  }
}

export type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
/** Une garde de route : un preHandler seul, ou une chaîne exécutée dans l'ordre (Fastify
 *  court-circuite dès qu'un maillon répond). Sert à composer [requireAuth, requireRole]. */
export type Guard = PreHandler | PreHandler[];

/** Relit l'état d'auth courant du compte en base. null = compte supprimé. */
export type UserStateLoader = (userId: string, tenantId: string) => Promise<{ role: string; disabled: boolean } | null>;

/**
 * Garde de rôle à utiliser DANS un handler déjà authentifié : renvoie true (et répond 403)
 * si l'appelant n'est pas admin. Les actions à impact (créer/lancer campagne, import) sont
 * réservées aux admins ; les lectures restent ouvertes à tout compte authentifié.
 */
export function forbidNonAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.auth && req.auth.role !== 'admin') {
    void reply.code(403).send({ error: 'action réservée aux administrateurs' });
    return true;
  }
  return false;
}

/**
 * preHandler de groupe : exige que `req.auth.role` soit dans `roles`. À composer APRÈS
 * `makeRequireAuth` (`preHandler: [requireAuth, makeRequireRole(['admin'])]`) — il suppose
 * `req.auth` déjà posé. 401 défensif si l'auth manque, 403 si le rôle n'est pas autorisé.
 * C'est la barrière serveur qui réserve tout sauf l'inbox aux admins (agent = inbox only).
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
 * Construit un preHandler Fastify qui exige un Bearer JWT valide et pose `req.auth`.
 * 401 si absent/invalide. Les routes DÉRIVENT le tenant de `req.auth`, jamais de l'URL.
 *
 * `loadState` (optionnel) relit l'état du compte EN BASE à chaque requête : compte supprimé ou
 * révoqué -> 401 immédiat (le JWT ne fait plus foi seul), et le rôle est rafraîchi depuis la base
 * (un changement de rôle prend effet tout de suite). Ferme la fenêtre de staleness du token de 12 h.
 * Sans `loadState` (tests DB-free), on retombe sur la vérification JWT seule.
 */
export function makeRequireAuth(secret: string, loadState?: UserStateLoader): PreHandler {
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
    if (loadState) {
      const state = await loadState(session.userId, session.tenantId);
      if (!state || state.disabled) {
        await reply.code(401).send({ error: 'session révoquée' });
        return;
      }
      session.role = state.role; // rôle frais : les changements de rôle sont immédiats
    }
    req.auth = session;
  };
}
