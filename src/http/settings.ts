import type { FastifyInstance } from 'fastify';
import { forbidNonAdmin } from '../auth/middleware';
import type { PreHandler } from '../auth/middleware';
import type { TenantSettings } from '../settings/store.pg';

export interface SettingsRouteDeps {
  getSettings(tenantId: string): Promise<TenantSettings>;
  setMbaEnabled(tenantId: string, enabled: boolean): Promise<void>;
}

function scopeTenant(req: { params: unknown; auth?: { tenantId: string } }): string | null {
  const { tenantId } = req.params as { tenantId: string };
  const authTenant = req.auth?.tenantId;
  if (authTenant !== undefined && authTenant !== tenantId) return null;
  return authTenant ?? tenantId;
}

/** Réglages tenant : GET ouvert (lecture), PUT admin-only (toggle MBA). */
export function registerSettings(app: FastifyInstance, deps: SettingsRouteDeps, requireAuth?: PreHandler): void {
  const guard = requireAuth ? { preHandler: requireAuth } : {};

  app.get('/tenants/:tenantId/settings', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    return reply.code(200).send(await deps.getSettings(tenant));
  });

  app.put('/tenants/:tenantId/settings', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const mbaEnabled = (req.body as { mbaEnabled?: unknown } | null)?.mbaEnabled;
    if (typeof mbaEnabled !== 'boolean') return reply.code(400).send({ error: 'mbaEnabled (booléen) requis' });
    await deps.setMbaEnabled(tenant, mbaEnabled);
    return reply.code(200).send({ mbaEnabled });
  });
}
