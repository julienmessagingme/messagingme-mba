import type { FastifyRequest, FastifyReply } from 'fastify';
import type { PreHandler } from './middleware';
import type { ApiKeyLookup } from './api-key-store.pg';
import { API_KEY_PREFIX } from './api-key-store.pg';
import { sha256Hex } from '../lib/signature';
import type { RateLimiter } from './rate-limit';

declare module 'fastify' {
  interface FastifyRequest {
    apiScopes?: string[];
  }
}

/**
 * preHandler de la surface `/v1` : authentifie une CLÉ D'API (Bearer `mba_...`). Autorité SÉPARÉE du JWT
 * tenant (montée indépendamment, comme /ops). Sur succès, pose un `req.auth` SYNTHÉTIQUE avec le rôle
 * dédié `'api'` (JAMAIS 'admin' : les routes /v1 gate par SCOPE via requireScope, pas par rôle) et
 * `req.apiScopes`. Le tenant vient à 100% de la clé résolue (pas d'`:tenantId` dans l'URL /v1).
 * Rate limit applicatif par clé (en mémoire, par process, comme /auth/login). Headers x-ratelimit-* sur
 * toute réponse (succès et 429).
 */
export function makeRequireApiKey(store: ApiKeyLookup, limiter: RateLimiter): PreHandler {
  return async function requireApiKey(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = req.headers.authorization;
    const raw = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!raw || !raw.startsWith(API_KEY_PREFIX)) {
      await reply.code(401).send({ error: 'clé d’API requise' });
      return;
    }
    const found = await store.findActiveByHash(sha256Hex(raw));
    if (!found) {
      await reply.code(401).send({ error: 'clé d’API invalide ou révoquée' });
      return;
    }
    const rl = limiter.remaining(found.id);
    reply.header('x-ratelimit-limit', String(rl.limit));
    reply.header('x-ratelimit-remaining', String(Math.max(0, rl.remaining - 1)));
    reply.header('x-ratelimit-reset', String(Math.ceil(rl.resetAt / 1000)));
    if (!limiter.take(found.id)) {
      reply.header('x-ratelimit-remaining', '0');
      reply.header('retry-after', String(Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000))));
      await reply.code(429).send({ error: 'trop de requêtes' });
      return;
    }
    // Empreinte de dernier usage : best-effort, ne doit jamais bloquer/échouer la requête.
    void store.touchLastUsed(found.id).catch(() => { /* best-effort */ });
    req.auth = { userId: `apikey:${found.id}`, tenantId: found.tenantId, role: 'api' };
    req.apiScopes = found.scopes;
  };
}

/** preHandler à composer APRÈS makeRequireApiKey : exige un scope précis (403 sinon). */
export function requireScope(scope: string): PreHandler {
  return async function checkScope(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!req.apiScopes?.includes(scope)) {
      await reply.code(403).send({ error: `scope requis : ${scope}` });
    }
  };
}
