import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import type { DashboardStats } from '../stats/store.pg';

export interface StatsRouteDeps {
  getDashboard(tenantId: string, days: number): Promise<DashboardStats>;
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
    const q = req.query as { days?: string };
    const parsed = q.days ? Number(q.days) : 30;
    const days = Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
    return reply.code(200).send(await deps.getDashboard(tenant, days));
  });
}
