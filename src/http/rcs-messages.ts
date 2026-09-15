import type { FastifyInstance } from 'fastify';
import { rcsOutboundSchema } from '../rcs/schema';
import type { RcsMessage } from '../rcs/message-store.pg';
import type { RcsOutbound } from '../rcs/types';
import { forbidNonAdmin } from '../auth/middleware';
import type { Guard } from '../auth/middleware';
import { scopeTenant, nonEmpty } from './scope';

export interface RcsMessageRouteDeps {
  list(tenantId: string): Promise<RcsMessage[]>;
  create(tenantId: string, name: string, content: RcsOutbound): Promise<RcsMessage>;
  update(tenantId: string, id: string, name: string, content: RcsOutbound): Promise<boolean>;
  remove(tenantId: string, id: string): Promise<boolean>;
}

/** Nom d'un message : non vide, borné, jamais interprété (simple étiquette de bibliothèque). */
function lireNom(body: unknown): string | null {
  const n = (body as { name?: unknown } | null)?.name;
  if (!nonEmpty(n)) return null;
  const nom = (n as string).trim();
  return nom.length <= 120 ? nom : null;
}

/**
 * Bibliothèque de messages RCS. Lecture ouverte à tout utilisateur du tenant (l'inbox et les scénarios en ont
 * besoin), écritures réservées aux admins comme partout ailleurs dans ce projet.
 *
 * Le contenu est validé en `safeParse` À CHAQUE écriture : c'est la frontière où un message malformé doit être
 * refusé, pas au moment de l'envoi devant un client.
 */
export function registerRcsMessages(app: FastifyInstance, deps: RcsMessageRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };

  app.get('/tenants/:tenantId/rcs-messages', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    return reply.code(200).send({ messages: await deps.list(tenant) });
  });

  app.post('/tenants/:tenantId/rcs-messages', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const nom = lireNom(req.body);
    if (nom === null) return reply.code(400).send({ error: 'name requis (texte non vide, 120 caractères max)' });
    const contenu = rcsOutboundSchema.safeParse((req.body as { content?: unknown } | null)?.content);
    if (!contenu.success) return reply.code(400).send({ error: 'content invalide' });
    return reply.code(201).send({ message: await deps.create(tenant, nom, contenu.data) });
  });

  app.patch('/tenants/:tenantId/rcs-messages/:id', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const nom = lireNom(req.body);
    if (nom === null) return reply.code(400).send({ error: 'name requis (texte non vide, 120 caractères max)' });
    const contenu = rcsOutboundSchema.safeParse((req.body as { content?: unknown } | null)?.content);
    if (!contenu.success) return reply.code(400).send({ error: 'content invalide' });
    const ok = await deps.update(tenant, id, nom, contenu.data);
    if (!ok) return reply.code(404).send({ error: 'message inconnu' });
    return reply.code(200).send({ ok: true });
  });

  app.delete('/tenants/:tenantId/rcs-messages/:id', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const ok = await deps.remove(tenant, id);
    if (!ok) return reply.code(404).send({ error: 'message inconnu' });
    return reply.code(200).send({ ok: true });
  });
}
