import type { FastifyInstance } from 'fastify';
import type { PreHandler } from '../auth/middleware';
import type { ConversationSummary, ConversationMessage } from '../inbox/store.pg';

export interface InboxRouteDeps {
  listConversations(tenantId: string): Promise<ConversationSummary[]>;
  getConversationWaId(conversationId: string, tenantId: string): Promise<string | null>;
  getMessages(conversationId: string): Promise<ConversationMessage[]>;
  recordOutbound(conversationId: string, body: string, messageId: string | null): Promise<void>;
  /** Numéro du tenant depuis lequel répondre. */
  getTenantPhoneNumberId(tenantId: string): Promise<string | null>;
  /** Envoie une réponse texte (fenêtre de service 24 h). Retourne le message_id. */
  sendReply(phoneNumberId: string, to: string, text: string): Promise<string>;
}

function scopeTenant(req: { params: unknown; auth?: { tenantId: string } }): string | null {
  const { tenantId } = req.params as { tenantId: string };
  const authTenant = req.auth?.tenantId;
  if (authTenant !== undefined && authTenant !== tenantId) return null;
  return authTenant ?? tenantId;
}

/**
 * Boîte de réception : lister les conversations, lire une conversation, répondre.
 * Les lectures + la réponse sont ouvertes à tout compte authentifié (les agents répondent).
 */
export function registerInbox(app: FastifyInstance, deps: InboxRouteDeps, requireAuth?: PreHandler): void {
  const guard = requireAuth ? { preHandler: requireAuth } : {};

  app.get('/tenants/:tenantId/conversations', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    return reply.code(200).send({ conversations: await deps.listConversations(tenant) });
  });

  app.get('/tenants/:tenantId/conversations/:conversationId/messages', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { conversationId } = req.params as { conversationId: string };
    const waId = await deps.getConversationWaId(conversationId, tenant);
    if (waId === null) return reply.code(404).send({ error: 'conversation inconnue' });
    return reply.code(200).send({ waId, messages: await deps.getMessages(conversationId) });
  });

  app.post('/tenants/:tenantId/conversations/:conversationId/reply', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { conversationId } = req.params as { conversationId: string };
    const text = (req.body as { text?: unknown } | null)?.text;
    if (typeof text !== 'string' || text.trim() === '') return reply.code(400).send({ error: 'text requis' });

    const waId = await deps.getConversationWaId(conversationId, tenant);
    if (waId === null) return reply.code(404).send({ error: 'conversation inconnue' });
    const phoneNumberId = await deps.getTenantPhoneNumberId(tenant);
    if (!phoneNumberId) return reply.code(400).send({ error: 'aucun numéro pour ce tenant' });

    const messageId = await deps.sendReply(phoneNumberId, waId, text);
    await deps.recordOutbound(conversationId, text, messageId);
    return reply.code(200).send({ messageId });
  });
}
