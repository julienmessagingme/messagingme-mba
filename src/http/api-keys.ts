import type { FastifyInstance } from 'fastify';
import { forbidNonAdmin } from '../auth/middleware';
import type { Guard } from '../auth/middleware';
import type { ApiKeyRow } from '../auth/api-key-store.pg';

/** Scopes d'API reconnus en V1. Une clé demande un sous-ensemble non vide. */
export const VALID_API_SCOPES = ['contacts:write', 'sends:create'] as const;

export interface ApiKeysRouteDeps {
  createKey(tenantId: string, name: string, scopes: string[]): Promise<{ id: string; key: string }>;
  listKeys(tenantId: string): Promise<ApiKeyRow[]>;
  revokeKey(tenantId: string, id: string): Promise<boolean>;
}

function scopeTenant(req: { params: unknown; auth?: { tenantId: string } }): string | null {
  const { tenantId } = req.params as { tenantId: string };
  const authTenant = req.auth?.tenantId;
  if (authTenant !== undefined && authTenant !== tenantId) return null;
  return authTenant ?? tenantId;
}
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/**
 * CRUD des clés d'API (console admin, JWT). Admin-only via `guard` + forbidNonAdmin. Le tenant vient du JWT.
 * La création renvoie la clé EN CLAIR UNE SEULE FOIS (jamais re-affichable) ; la liste n'expose jamais le hash.
 */
export function registerApiKeys(app: FastifyInstance, deps: ApiKeysRouteDeps, guard?: Guard): void {
  const opts = guard ? { preHandler: guard } : {};

  app.post('/tenants/:tenantId/api-keys', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const b = (req.body ?? {}) as { name?: unknown; scopes?: unknown };
    if (!nonEmpty(b.name)) return reply.code(400).send({ error: 'name requis' });
    const scopes = Array.isArray(b.scopes) ? [...new Set(b.scopes.map(String))] : [];
    if (scopes.length === 0) return reply.code(400).send({ error: 'au moins un scope requis' });
    const invalid = scopes.filter((s) => !(VALID_API_SCOPES as readonly string[]).includes(s));
    if (invalid.length > 0) return reply.code(400).send({ error: `scope(s) inconnu(s) : ${invalid.join(', ')}` });
    const { id, key } = await deps.createKey(tenant, b.name.trim().slice(0, 100), scopes);
    // key = clair, montré UNE fois. Le client doit le stocker maintenant.
    return reply.code(201).send({ id, key, name: b.name.trim().slice(0, 100), scopes });
  });

  app.get('/tenants/:tenantId/api-keys', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    return reply.code(200).send({ keys: await deps.listKeys(tenant) });
  });

  app.delete('/tenants/:tenantId/api-keys/:id', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const ok = await deps.revokeKey(tenant, id);
    if (!ok) return reply.code(404).send({ error: 'clé inconnue ou déjà révoquée' });
    return reply.code(200).send({ id, revoked: true });
  });
}
