import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import type { ApiKeyRow } from '../auth/api-key-store.pg';
import { espaceVerifie, nonEmpty } from './scope';
import { makeJournal, type AuditSink } from '../audit/journal';

/**
 * Les droits qu'une clé d'API peut porter (sous-ensemble non vide). `mcp:read` et `mcp:write` sont séparés des
 * autres : une clé donnée à un agent tiers pour lire l'Inbox n'emporte pas le droit d'écrire, et le serveur MCP
 * ne liste même pas les outils hors des scopes de la clé.
 */
export const VALID_API_SCOPES = ['contacts:write', 'contacts:read', 'sends:create', 'mcp:read', 'mcp:write'] as const;

export interface ApiKeysRouteDeps {
  /**
   * Journal d'audit (les fixtures qui ne l'observent pas passent `journalMuet`). Une clé d'API lit les contacts
   * sans compte : savoir qui l'a créée et quand est la seule trace de l'origine de l'accès.
   * 🔴 Le `detail` ne porte jamais la clé ni son empreinte, seulement les droits accordés (ce journal n'est pas purgé).
   */
  audit: AuditSink;
  createKey(tenantId: string, name: string, scopes: string[]): Promise<{ id: string; key: string }>;
  listKeys(tenantId: string): Promise<ApiKeyRow[]>;
  revokeKey(tenantId: string, id: string): Promise<boolean>;
}

/**
 * CRUD des clés d'API (console, admin par la garde de montage `g.admin`). L'espace vient du JWT. La création rend
 * la clé en clair une seule fois ; la liste n'expose jamais le hash.
 */
export function registerApiKeys(app: FastifyInstance, deps: ApiKeysRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };
  const journal = makeJournal(deps.audit);

  app.post('/tenants/:tenantId/api-keys', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const b = (req.body ?? {}) as { name?: unknown; scopes?: unknown };
    if (!nonEmpty(b.name)) return reply.code(400).send({ error: 'name requis' });
    const scopes = Array.isArray(b.scopes) ? [...new Set(b.scopes.map(String))] : [];
    if (scopes.length === 0) return reply.code(400).send({ error: 'au moins un scope requis' });
    const invalid = scopes.filter((s) => !(VALID_API_SCOPES as readonly string[]).includes(s));
    if (invalid.length > 0) return reply.code(400).send({ error: `scope(s) inconnu(s) : ${invalid.join(', ')}` });
    const { id, key } = await deps.createKey(tenant, b.name.trim().slice(0, 100), scopes);
    // `key` en clair, montrée une seule fois. L'audit porte les droits accordés, jamais la clé.
    await journal(tenant, req, 'cle_api.creee', { kind: 'api_key', id }, { scopes });
    return reply.code(201).send({ id, key, name: b.name.trim().slice(0, 100), scopes });
  });

  app.get('/tenants/:tenantId/api-keys', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    return reply.code(200).send({ keys: await deps.listKeys(tenant) });
  });

  app.delete('/tenants/:tenantId/api-keys/:id', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { id } = req.params as { id: string };
    const ok = await deps.revokeKey(tenant, id);
    if (!ok) return reply.code(404).send({ error: 'clé inconnue ou déjà révoquée' });
    // Après le succès : une révocation refusée n'a rien révoqué.
    await journal(tenant, req, 'cle_api.revoquee', { kind: 'api_key', id });
    return reply.code(200).send({ id, revoked: true });
  });
}
