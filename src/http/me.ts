import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';

/** Profil de l'utilisateur COURANT (dérivé de req.auth.userId). Sert au « Bonjour {prénom} » de l'Accueil. */
export interface MeRouteDeps {
  getUser(userId: string): Promise<{ email: string; name: string | null; role: string } | null>;
}

function scopeTenant(req: { params: unknown; auth?: { tenantId: string } }): string | null {
  const { tenantId } = req.params as { tenantId: string };
  const authTenant = req.auth?.tenantId;
  if (authTenant !== undefined && authTenant !== tenantId) return null;
  return authTenant ?? tenantId;
}

export function registerMe(app: FastifyInstance, deps: MeRouteDeps, requireAuth?: Guard): void {
  const guard = requireAuth ? { preHandler: requireAuth } : {};

  app.get('/tenants/:tenantId/me', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const userId = req.auth?.userId;
    if (!userId) return reply.code(401).send({ error: 'authentification requise' });
    const u = await deps.getUser(userId);
    if (!u) return reply.code(404).send({ error: 'utilisateur inconnu' });
    return reply.code(200).send({ email: u.email, name: u.name, role: u.role });
  });
}
