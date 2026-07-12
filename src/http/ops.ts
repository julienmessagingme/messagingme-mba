import type { FastifyInstance } from 'fastify';
import { makeRequireOps } from '../auth/middleware';
import type { TenantOverviewRow, QueueLoadRow, GlobalDailyPoint } from '../ops/store.pg';

/** Surface d'exploitation cross-tenant, LECTURE SEULE. Aucune méthode de mutation ici, par conception. */
export interface OpsRouteDeps {
  getTenantOverview(): Promise<TenantOverviewRow[]>;
  getGlobalDaily(days: number): Promise<GlobalDailyPoint[]>;
  getQueueLoad(): Promise<QueueLoadRow[]>;
}

/**
 * Monte `/ops/overview` (GET seul). Protégé par `x-ops-token` == `opsToken` (constant-time). Si `opsToken`
 * est vide, la route répond 401 (surface désactivée par défaut). N'utilise jamais `req.auth` : c'est une
 * autorité SÉPARÉE du JWT tenant. Cross-tenant en LECTURE uniquement (aucune écriture n'est exposée).
 */
export function registerOps(app: FastifyInstance, deps: OpsRouteDeps, opsToken: string): void {
  const guard = { preHandler: makeRequireOps(opsToken) };

  app.get('/ops/overview', guard, async (_req, reply) => {
    const [tenants, daily, queues] = await Promise.all([
      deps.getTenantOverview(),
      deps.getGlobalDaily(14),
      deps.getQueueLoad(),
    ]);
    return reply.code(200).send({ tenants, daily, queues });
  });
}
