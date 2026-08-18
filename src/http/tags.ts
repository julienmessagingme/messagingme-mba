import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import type { TagCount } from '../crm/tag-store.pg';
import { scopeTenant, nonEmpty } from './scope';

export interface TagsRouteDeps {
  listTags(tenantId: string): Promise<TagCount[]>;
  createTag(tenantId: string, name: string): Promise<boolean>;
  renameTag(tenantId: string, from: string, to: string): Promise<number>;
  removeTag(tenantId: string, tag: string): Promise<number>;
}

/** Gestion des tags (menu Contenu), admin-only. Modèle mixte : table `tags` (tags déclarés, créés à vide)
 *  + tags portés par les contacts (`contacts.tags`). listTags = union des deux (cf. PgTagStore). */
export function registerTags(app: FastifyInstance, deps: TagsRouteDeps, guard?: Guard): void {
  const opts = guard ? { preHandler: guard } : {};

  app.get('/tenants/:tenantId/tags', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    return reply.code(200).send({ tags: await deps.listTags(tenant) });
  });

  // Créer (déclarer) un tag réutilisable, même sans contact.
  app.post('/tenants/:tenantId/tags', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const b = (req.body ?? {}) as { name?: unknown };
    if (!nonEmpty(b.name)) return reply.code(400).send({ error: 'name requis' });
    const name = b.name.trim().slice(0, 64);
    const created = await deps.createTag(tenant, name);
    return reply.code(created ? 201 : 200).send({ name, created });
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
