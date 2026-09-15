import type { FastifyInstance } from 'fastify';
import { forbidNonAdmin } from '../auth/middleware';
import type { Guard } from '../auth/middleware';
import type { ApiKeyRow } from '../auth/api-key-store.pg';
import { scopeTenant, nonEmpty } from './scope';

/** Scopes d'API reconnus en V1. Une clé demande un sous-ensemble non vide. */
/**
 * Les droits qu'une clé d'API peut porter.
 *
 * `mcp:read` et `mcp:write` sont SÉPARÉS des deux autres, et c'est voulu : une clé donnée à un agent tiers
 * pour lire l'inbox ne doit pas emporter au passage le droit de créer des contacts ou de lancer un envoi.
 * Le serveur MCP ne liste même pas les outils hors des scopes de la clé, donc « lecture seule » veut dire
 * qu'un agent ne VOIT pas l'outil qui écrit.
 */
export const VALID_API_SCOPES = ['contacts:write', 'sends:create', 'mcp:read', 'mcp:write'] as const;

export interface ApiKeysRouteDeps {
  createKey(tenantId: string, name: string, scopes: string[]): Promise<{ id: string; key: string }>;
  listKeys(tenantId: string): Promise<ApiKeyRow[]>;
  revokeKey(tenantId: string, id: string): Promise<boolean>;
}

/**
 * CRUD des clés d'API (console admin, JWT). Admin-only via `garde` + forbidNonAdmin. Le tenant vient du JWT.
 * La création renvoie la clé EN CLAIR UNE SEULE FOIS (jamais re-affichable) ; la liste n'expose jamais le hash.
 */
export function registerApiKeys(app: FastifyInstance, deps: ApiKeysRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };

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
