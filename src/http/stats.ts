import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import type { DashboardStats, TemplateBreakdownRow } from '../stats/store.pg';
import type { PricingSummary } from '../meta/pricing';

export interface StatsRouteDeps {
  getDashboard(tenantId: string, days: number): Promise<DashboardStats>;
  /** Volume par template envoyé (dropdown dashboard). */
  getTemplateBreakdown(tenantId: string, days: number): Promise<TemplateBreakdownRow[]>;
  /** Prix Meta (pricing_analytics) par catégorie ; null si indisponible (le front affiche le volume seul). */
  getPricing(tenantId: string, days: number): Promise<PricingSummary | null>;
}

function scopeTenant(req: { params: unknown; auth?: { tenantId: string } }): string | null {
  const { tenantId } = req.params as { tenantId: string };
  const authTenant = req.auth?.tenantId;
  if (authTenant !== undefined && authTenant !== tenantId) return null;
  return authTenant ?? tenantId;
}

/** Stats du dashboard (séries 1 pt/jour). Lecture ouverte à tout compte authentifié. */
export function registerStats(app: FastifyInstance, deps: StatsRouteDeps, requireAuth?: Guard): void {
  const guard = requireAuth ? { preHandler: requireAuth } : {};

  app.get('/tenants/:tenantId/stats', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    return reply.code(200).send(await deps.getDashboard(tenant, parseDays(req)));
  });

  // Breakdown par template + prix Meta (pricing_analytics). Séparé de /stats : peut appeler Meta
  // (plus lent) et n'est chargé que par la section « Templates envoyés » du dashboard.
  app.get('/tenants/:tenantId/stats/templates', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const days = parseDays(req);
    const [breakdown, pricing] = await Promise.all([deps.getTemplateBreakdown(tenant, days), deps.getPricing(tenant, days)]);
    return reply.code(200).send({ breakdown, pricing });
  });
}

function parseDays(req: { query: unknown }): number {
  const q = req.query as { days?: string };
  const parsed = q.days ? Number(q.days) : 30;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
}
