import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import type { DashboardStats, TemplateBreakdownRow, CampaignFunnel, ErrorBreakdownRow, CostFilter } from '../stats/store.pg';
import type { CostSeries } from '../stats/cost';
import type { PricingSummary } from '../meta/pricing';
import { parseRange } from '../stats/range';
import type { DateRange } from '../stats/range';

export interface StatsRouteDeps {
  getDashboard(tenantId: string, range: DateRange): Promise<DashboardStats>;
  /** Volume par template envoyé (dropdown dashboard). */
  getTemplateBreakdown(tenantId: string, range: DateRange): Promise<TemplateBreakdownRow[]>;
  /** Prix Meta (pricing_analytics) par catégorie ; null si indisponible (le front affiche le volume seul). */
  getPricing(tenantId: string, range: DateRange): Promise<PricingSummary | null>;
  /** Funnel d'UNE campagne : envoyés -> délivrés -> lus -> répondus + échecs. */
  getCampaignFunnel(tenantId: string, campaignId: string): Promise<CampaignFunnel>;
  /** Breakdown des codes d'erreur Meta sur la plage (campagnes du tenant). */
  getErrorBreakdown(tenantId: string, range: DateRange): Promise<ErrorBreakdownRow[]>;
  /** Série de coût estimé/jour, filtrable par campagne ou template. */
  getCostSeries(tenantId: string, range: DateRange, filter: CostFilter): Promise<CostSeries>;
}

function scopeTenant(req: { params: unknown; auth?: { tenantId: string } }): string | null {
  const { tenantId } = req.params as { tenantId: string };
  const authTenant = req.auth?.tenantId;
  if (authTenant !== undefined && authTenant !== tenantId) return null;
  return authTenant ?? tenantId;
}

/** Stats du dashboard (séries 1 pt/jour). Groupe admin-only (guard passé par server.ts). Plage de dates
 *  via ?from&?to (YYYY-MM-DD, Europe/Paris) ou repli ?days= ; invalide/futur/span>366 -> 400. */
export function registerStats(app: FastifyInstance, deps: StatsRouteDeps, requireAuth?: Guard): void {
  const guard = requireAuth ? { preHandler: requireAuth } : {};

  app.get('/tenants/:tenantId/stats', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const r = parseRange(req.query as Record<string, unknown>);
    if ('error' in r) return reply.code(400).send({ error: r.error });
    return reply.code(200).send(await deps.getDashboard(tenant, r.range));
  });

  // Breakdown par template + prix Meta (pricing_analytics). Séparé de /stats : peut appeler Meta
  // (plus lent) et n'est chargé que par la section « Templates envoyés » du dashboard.
  app.get('/tenants/:tenantId/stats/templates', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const r = parseRange(req.query as Record<string, unknown>);
    if ('error' in r) return reply.code(400).send({ error: r.error });
    const [breakdown, pricing] = await Promise.all([deps.getTemplateBreakdown(tenant, r.range), deps.getPricing(tenant, r.range)]);
    return reply.code(200).send({ breakdown, pricing });
  });

  // Funnel d'UNE campagne (envoyés/délivrés/lus/répondus). ?campaignId=... requis. Pas de plage
  // (le funnel porte sur toute la campagne). Le scope tenant est aussi appliqué en SQL (pas de fuite).
  app.get('/tenants/:tenantId/stats/campaign-funnel', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const campaignId = (req.query as Record<string, unknown>).campaignId;
    if (typeof campaignId !== 'string' || campaignId === '') return reply.code(400).send({ error: 'campaignId requis' });
    return reply.code(200).send(await deps.getCampaignFunnel(tenant, campaignId));
  });

  // Breakdown des codes d'erreur Meta sur la plage.
  app.get('/tenants/:tenantId/stats/errors', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const r = parseRange(req.query as Record<string, unknown>);
    if ('error' in r) return reply.code(400).send({ error: r.error });
    return reply.code(200).send({ errors: await deps.getErrorBreakdown(tenant, r.range) });
  });

  // Graphe de coût estimé/jour, filtrable ?campaignId= / ?templateName= (peut appeler Meta pour le tarif).
  app.get('/tenants/:tenantId/stats/cost', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const q = req.query as Record<string, unknown>;
    const r = parseRange(q);
    if ('error' in r) return reply.code(400).send({ error: r.error });
    const filter: CostFilter = {
      ...(typeof q.campaignId === 'string' && q.campaignId !== '' ? { campaignId: q.campaignId } : {}),
      ...(typeof q.templateName === 'string' && q.templateName !== '' ? { templateName: q.templateName } : {}),
    };
    return reply.code(200).send(await deps.getCostSeries(tenant, r.range, filter));
  });
}
