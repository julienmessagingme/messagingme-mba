import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import { ReconsentRequiredError } from '../crm/hubspot-import';
import type { HubspotList } from '../crm/hubspot-import';
import { listsGateOpen } from '../crm/lists-gate';
import type { ImportReport } from '../crm/types';
import { scopeTenant, nonEmpty } from './scope';

export interface HubspotImportRouteDeps {
  /**
   * État d'accès aux listes HubSpot pour ce tenant : `enabled` = réglage utilisateur « Campagnes via données
   * HubSpot » ; `paused` = un numéro du tenant est en pause (F3-b, la pause suspend AUSSI les campagnes via listes).
   * La route compose `available = enabled && !paused` (cf. `listsGateOpen`) et distingue les deux causes d'indispo
   * pour un message clair (« désactivé » vs « en pause »).
   */
  listsAccess(tenantId: string): Promise<{ enabled: boolean; paused: boolean }>;
  /** Liste les listes HubSpot du portail (peut lever ReconsentRequiredError). */
  fetchLists(tenantId: string, query?: string): Promise<HubspotList[]>;
  /** Importe une liste (opt-in TOUJOURS false, tag HubSpot). `tags` = tag(s) réellement posé(s). Peut lever ReconsentRequiredError. */
  importList(tenantId: string, listId: string, listName: string): Promise<{ report: ImportReport; truncated: boolean; skippedNoPhone: number; tags: string[] }>;
}

/**
 * Import de listes HubSpot comme destinataires (3e source de campagne). Admin-only via `guard`. Tenant du JWT.
 * Proxifie le connecteur mm-hubspot (canal service signé). Toggle OFF -> `available:false` SANS aucun appel réseau.
 */
export function registerHubspotImport(app: FastifyInstance, deps: HubspotImportRouteDeps, guard?: Guard): void {
  const opts = guard ? { preHandler: guard } : {};

  app.get('/tenants/:tenantId/hubspot/lists', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    // Indispo : on ne touche PAS le connecteur (zéro appel réseau, zéro scope sollicité). On distingue le toggle OFF
    // (available:false sec) de la PAUSE (available:false + reason:'paused') pour un message UI honnête (F3-b).
    const { enabled, paused } = await deps.listsAccess(tenant);
    if (!listsGateOpen(enabled, paused)) {
      return reply.code(200).send({ available: false, ...(enabled && paused ? { reason: 'paused' as const } : {}) });
    }
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
    const { enabled, paused } = await deps.listsAccess(tenant);
    if (!listsGateOpen(enabled, paused)) {
      return enabled && paused
        ? reply.code(409).send({ error: 'synchronisation HubSpot en pause', reason: 'paused' as const })
        : reply.code(409).send({ error: 'import HubSpot désactivé' });
    }
    const b = (req.body ?? {}) as { listId?: unknown; listName?: unknown };
    if (!nonEmpty(b.listId)) return reply.code(400).send({ error: 'listId requis' });
    const listName = nonEmpty(b.listName) ? b.listName.trim().slice(0, 120) : b.listId.trim();
    try {
      const { report, truncated, skippedNoPhone, tags } = await deps.importList(tenant, b.listId.trim(), listName);
      return reply.code(200).send({ ...report, truncated, skippedNoPhone, tags });
    } catch (err) {
      if (err instanceof ReconsentRequiredError) {
        return reply.code(409).send({ error: 'reconsent_required', reconsentUrl: err.reconsentUrl });
      }
      throw err;
    }
  });
}
