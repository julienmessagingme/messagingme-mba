import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import type { TagCount } from '../crm/tag-store.pg';
import { espaceVerifie, nonEmpty } from './scope';
import { normaliserEtiquette } from '../crm/poser-etiquette';

export interface TagsRouteDeps {
  listDistinct(tenantId: string): Promise<TagCount[]>;
  create(tenantId: string, name: string): Promise<boolean>;
  rename(tenantId: string, from: string, to: string): Promise<number>;
  remove(tenantId: string, tag: string): Promise<number>;
}

/** Gestion des tags (menu Contenu), admin-only. Modèle mixte : table `tags` (tags déclarés, créés à vide)
 *  + tags portés par les contacts (`contacts.tags`). listDistinct = union des deux (cf. PgTagStore). */
export function registerTags(app: FastifyInstance, deps: TagsRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };

  app.get('/tenants/:tenantId/tags', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    return reply.code(200).send({ tags: await deps.listDistinct(tenant) });
  });

  // Créer (déclarer) un tag réutilisable, même sans contact.
  app.post('/tenants/:tenantId/tags', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const b = (req.body ?? {}) as { name?: unknown };
    if (!nonEmpty(b.name)) return reply.code(400).send({ error: 'name requis' });
    const name = normaliserEtiquette(b.name);
    const created = await deps.create(tenant, name);
    return reply.code(created ? 201 : 200).send({ name, created });
  });

  app.patch('/tenants/:tenantId/tags', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const b = (req.body ?? {}) as { from?: unknown; to?: unknown };
    if (!nonEmpty(b.from) || !nonEmpty(b.to)) return reply.code(400).send({ error: 'from et to requis' });
    const from = b.from.trim();
    const to = b.to.trim();
    if (from === to) return reply.code(400).send({ error: 'from et to identiques' });
    const renamed = await deps.rename(tenant, from, to);
    return reply.code(200).send({ renamed });
  });

  app.delete('/tenants/:tenantId/tags', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const tag = (req.query as { tag?: string }).tag;
    if (!nonEmpty(tag)) return reply.code(400).send({ error: 'tag requis' });
    const removed = await deps.remove(tenant, tag.trim());
    return reply.code(200).send({ removed });
  });
}
