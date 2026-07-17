import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import { ReconsentRequiredError } from '../crm/hubspot-import';
import type { HubspotList } from '../crm/hubspot-import';
import type { ImportReport } from '../crm/types';

export interface HubspotImportRouteDeps {
  /** Le toggle « Campagnes via données HubSpot » est-il activé pour ce tenant ? OFF -> aucun appel connecteur. */
  isListsEnabled(tenantId: string): Promise<boolean>;
  /** Liste les listes HubSpot du portail (peut lever ReconsentRequiredError). */
  fetchLists(tenantId: string, query?: string): Promise<HubspotList[]>;
  /** Importe une liste (opt-in TOUJOURS false, tag HubSpot). Peut lever ReconsentRequiredError. */
  importList(tenantId: string, listId: string, listName: string): Promise<{ report: ImportReport; truncated: boolean; skippedNoPhone: number }>;
}

function scopeTenant(req: { params: unknown; auth?: { tenantId: string } }): string | null {
  const { tenantId } = req.params as { tenantId: string };
  const authTenant = req.auth?.tenantId;
  if (authTenant !== undefined && authTenant !== tenantId) return null;
  return authTenant ?? tenantId;
}
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/**
 * Import de listes HubSpot comme destinataires (3e source de campagne). Admin-only via `guard`. Tenant du JWT.
 * Proxifie le connecteur mm-hubspot (canal service signé). Toggle OFF -> `available:false` SANS aucun appel réseau.
 */
export function registerHubspotImport(app: FastifyInstance, deps: HubspotImportRouteDeps, guard?: Guard): void {
  const opts = guard ? { preHandler: guard } : {};

  app.get('/tenants/:tenantId/hubspot/lists', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    // Toggle OFF : on ne touche PAS le connecteur (zéro appel réseau, zéro scope sollicité).
    if (!(await deps.isListsEnabled(tenant))) return reply.code(200).send({ available: false });
    const q = (req.query as { query?: unknown }).query;
    try {
      const lists = await deps.fetchLists(tenant, nonEmpty(q) ? q.trim() : undefined);
      return reply.code(200).send({ available: true, lists });
    } catch (err) {
      if (err instanceof ReconsentRequiredError) {
        return reply.code(200).send({ available: true, reason: 'reconsent_required', reconsentUrl: err.reconsentUrl, lists: [] });
      }
      throw err;
    }
  });

  app.post('/tenants/:tenantId/hubspot/import', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (!(await deps.isListsEnabled(tenant))) return reply.code(409).send({ error: 'import HubSpot désactivé' });
    const b = (req.body ?? {}) as { listId?: unknown; listName?: unknown };
    if (!nonEmpty(b.listId)) return reply.code(400).send({ error: 'listId requis' });
    const listName = nonEmpty(b.listName) ? b.listName.trim().slice(0, 120) : b.listId.trim();
    try {
      const { report, truncated, skippedNoPhone } = await deps.importList(tenant, b.listId.trim(), listName);
      return reply.code(200).send({ ...report, truncated, skippedNoPhone });
    } catch (err) {
      if (err instanceof ReconsentRequiredError) {
        return reply.code(409).send({ error: 'reconsent_required', reconsentUrl: err.reconsentUrl });
      }
      throw err;
    }
  });
}
