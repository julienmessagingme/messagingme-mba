import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import type { ApiKeyRow, PlafondCles } from '../auth/api-key-store.pg';
import { API_SCOPES, DROIT_RELAIS, MAX_CLES_API_ACTIVES } from '../../web/lib/partage/droits-api';
import { espaceVerifie, nonEmpty } from './scope';
import { makeJournal, type AuditSink } from '../audit/journal';

/** Les droits et le plafond de clés actives sont partagés avec la console (`web/lib/partage/droits-api.ts`). */
const PLAFOND_CLES: PlafondCles = { max: MAX_CLES_API_ACTIVES, horsDroit: DROIT_RELAIS };

export interface ApiKeysRouteDeps {
  /**
   * Journal d'audit (les fixtures qui ne l'observent pas passent `journalMuet`). Une clé d'API lit les contacts
   * sans compte : savoir qui l'a créée et quand est la seule trace de l'origine de l'accès.
   * 🔴 Le `detail` ne porte jamais la clé ni son empreinte, seulement les droits accordés (ce journal n'est pas purgé).
   */
  audit: AuditSink;
  cles: ClesApiDep;
}

export interface ClesApiDep {
  /** `null` = plafond atteint, rien n'est créé. La route n'a pas accès à une création sans plafond. */
  creerSousPlafond(tenantId: string, name: string, scopes: string[], plafond: PlafondCles): Promise<{ id: string; key: string } | null>;
  listByTenant(tenantId: string): Promise<ApiKeyRow[]>;
  revoke(tenantId: string, id: string): Promise<boolean>;
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
    const invalid = scopes.filter((s) => !(API_SCOPES as readonly string[]).includes(s));
    if (invalid.length > 0) return reply.code(400).send({ error: `scope(s) inconnu(s) : ${invalid.join(', ')}` });
    const creee = await deps.cles.creerSousPlafond(tenant, b.name.trim().slice(0, 100), scopes, PLAFOND_CLES);
    if (!creee) {
      return reply.code(409).send({
        error: `${MAX_CLES_API_ACTIVES} clés actives au maximum par espace (la clé « Agent de Meta » ne compte pas) : révoquez-en une pour en créer une autre`,
      });
    }
    const { id, key } = creee;
    // `key` en clair, montrée une seule fois. L'audit porte les droits accordés, jamais la clé.
    await journal(tenant, req, 'cle_api.creee', { kind: 'api_key', id }, { scopes });
    return reply.code(201).send({ id, key, name: b.name.trim().slice(0, 100), scopes });
  });

  app.get('/tenants/:tenantId/api-keys', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    return reply.code(200).send({ keys: await deps.cles.listByTenant(tenant) });
  });

  app.delete('/tenants/:tenantId/api-keys/:id', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { id } = req.params as { id: string };
    const ok = await deps.cles.revoke(tenant, id);
    if (!ok) return reply.code(404).send({ error: 'clé inconnue ou déjà révoquée' });
    // Après le succès : une révocation refusée n'a rien révoqué.
    await journal(tenant, req, 'cle_api.revoquee', { kind: 'api_key', id });
    return reply.code(200).send({ id, revoked: true });
  });
}
