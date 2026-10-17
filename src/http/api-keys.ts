import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import type { ApiKeyRow } from '../auth/api-key-store.pg';
import { creerCleApi, type DepsCreationCle } from '../auth/creer-cle';
import { espaceVerifie } from './scope';
import { makeJournal, type AuditSink } from '../audit/journal';
import { corpsDuRefus } from '../lib/issue';

export interface ApiKeysRouteDeps {
  /**
   * Journal d'audit (les fixtures qui ne l'observent pas passent `journalMuet`). Une clé d'API lit les contacts
   * sans compte : savoir qui l'a créée et quand est la seule trace de l'origine de l'accès.
   * 🔴 Le `detail` ne porte jamais la clé ni son empreinte, seulement les droits accordés (ce journal n'est pas purgé).
   */
  audit: AuditSink;
  cles: ClesApiDep;
  /** Les clés actives que l'offre de l'espace permet (spec offres v2) ; `null` = sans limite. */
  limiteCles: DepsCreationCle['limiteCles'];
}

export interface ClesApiDep {
  /** `null` = plafond atteint, rien n'est créé. La route n'a pas accès à une création hors plafond de l'offre. */
  creerSousPlafond: DepsCreationCle['cles']['creerSousPlafond'];
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
    const scopes = Array.isArray(b.scopes) ? b.scopes.map(String) : [];
    const r = await creerCleApi(deps, tenant, typeof b.name === 'string' ? b.name : '', scopes, { userId: req.auth?.userId ?? null, email: null });
    // `key` en clair, montrée une seule fois. L'audit porte les droits accordés, jamais la clé.
    return r.ok ? reply.code(201).send(r.valeur) : reply.code(r.statut).send(corpsDuRefus(r));
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
