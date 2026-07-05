import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifySession } from './token';
import type { Session } from './token';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: Session;
  }
}

export type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

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
 * Construit un preHandler Fastify qui exige un Bearer JWT valide et pose `req.auth`.
 * 401 si absent/invalide. Les routes DÉRIVENT le tenant de `req.auth`, jamais de l'URL.
 */
export function makeRequireAuth(secret: string): PreHandler {
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
    req.auth = session;
  };
}
