import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import type { TagCount } from '../crm/tag-store.pg';

export interface TagsRouteDeps {
  listTags(tenantId: string): Promise<TagCount[]>;
  renameTag(tenantId: string, from: string, to: string): Promise<number>;
  removeTag(tenantId: string, tag: string): Promise<number>;
}

function scopeTenant(req: { params: unknown; auth?: { tenantId: string } }): string | null {
  const { tenantId } = req.params as { tenantId: string };
  const authTenant = req.auth?.tenantId;
  if (authTenant !== undefined && authTenant !== tenantId) return null;
  return authTenant ?? tenantId;
}
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** Gestion des tags (menu Contenu), admin-only. Les tags vivent sur les contacts (pas de table dédiée). */
export function registerTags(app: FastifyInstance, deps: TagsRouteDeps, guard?: Guard): void {
  const opts = guard ? { preHandler: guard } : {};

  app.get('/tenants/:tenantId/tags', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    return reply.code(200).send({ tags: await deps.listTags(tenant) });
  });

  app.patch('/tenants/:tenantId/tags', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const b = (req.body ?? {}) as { from?: unknown; to?: unknown };
    if (!nonEmpty(b.from) || !nonEmpty(b.to)) return reply.code(400).send({ error: 'from et to requis' });
    const from = b.from.trim();
    const to = b.to.trim();
    if (from === to) return reply.code(400).send({ error: 'from et to identiques' });
    const renamed = await deps.renameTag(tenant, from, to);
    return reply.code(200).send({ renamed });
  });

  app.delete('/tenants/:tenantId/tags', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const tag = (req.query as { tag?: string }).tag;
    if (!nonEmpty(tag)) return reply.code(400).send({ error: 'tag requis' });
    const removed = await deps.removeTag(tenant, tag.trim());
    return reply.code(200).send({ removed });
  });
}
