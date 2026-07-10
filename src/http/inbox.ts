import type { FastifyInstance } from 'fastify';
import type { PreHandler } from '../auth/middleware';
import type { ConversationSummary, ConversationMessage } from '../inbox/store.pg';

/** Template à envoyer dans une conversation (hors fenêtre 24 h). */
export interface OutboundTemplate {
  name: string;
  language: string;
  /** Valeurs des variables du corps {{1}}, {{2}}... dans l'ordre. */
  bodyParams: string[];
  /** URL publique du média de header (image/vidéo/document), si le template en a un. */
  headerMediaUrl?: string;
  /** Format du header média, pour construire le bon type de paramètre côté Meta. */
  headerFormat?: 'IMAGE' | 'VIDEO' | 'DOCUMENT';
}

export interface InboxRouteDeps {
  listConversations(tenantId: string): Promise<ConversationSummary[]>;
  /** wa_id + état de la fenêtre de service 24 h. null si conversation absente/autre tenant. */
  getConversationContext(
    conversationId: string,
    tenantId: string,
  ): Promise<{ waId: string; lastInboundAt: string | null; windowOpen: boolean } | null>;
  getMessages(conversationId: string): Promise<ConversationMessage[]>;
  recordOutbound(
    conversationId: string,
    body: string,
    messageId: string | null,
    type?: string,
    templateCategory?: string | null,
    templateName?: string | null,
  ): Promise<void>;
  /** Numéro du tenant depuis lequel répondre. */
  getTenantPhoneNumberId(tenantId: string): Promise<string | null>;
  /** Envoie une réponse texte (fenêtre de service 24 h). Retourne le message_id. */
  sendReply(phoneNumberId: string, to: string, text: string): Promise<string>;
  /** Envoie un template (autorisé hors fenêtre). Retourne le message_id. */
  sendTemplateMessage(phoneNumberId: string, to: string, tpl: OutboundTemplate): Promise<string>;
}

function scopeTenant(req: { params: unknown; auth?: { tenantId: string } }): string | null {
  const { tenantId } = req.params as { tenantId: string };
  const authTenant = req.auth?.tenantId;
  if (authTenant !== undefined && authTenant !== tenantId) return null;
  return authTenant ?? tenantId;
}

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * Boîte de réception : lister/lire une conversation, répondre (texte dans la fenêtre 24 h,
 * template hors fenêtre). Lectures + réponse ouvertes à tout compte authentifié.
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
    const ctx = await deps.getConversationContext(conversationId, tenant);
    if (ctx === null) return reply.code(404).send({ error: 'conversation inconnue' });
    return reply.code(200).send({
      waId: ctx.waId,
      windowOpen: ctx.windowOpen,
      lastInboundAt: ctx.lastInboundAt,
      messages: await deps.getMessages(conversationId),
    });
  });

  app.post('/tenants/:tenantId/conversations/:conversationId/reply', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { conversationId } = req.params as { conversationId: string };
    const text = (req.body as { text?: unknown } | null)?.text;
    if (!nonEmpty(text)) return reply.code(400).send({ error: 'text requis' });

    const ctx = await deps.getConversationContext(conversationId, tenant);
    if (ctx === null) return reply.code(404).send({ error: 'conversation inconnue' });
    // Hors fenêtre 24 h : Meta refuse le texte libre. On bloque et on invite à un template.
    if (!ctx.windowOpen) {
      return reply.code(422).send({ error: 'Fenêtre de 24 h fermée : envoie un template.', code: 'window_closed' });
    }
    const phoneNumberId = await deps.getTenantPhoneNumberId(tenant);
    if (!phoneNumberId) return reply.code(400).send({ error: 'aucun numéro pour ce tenant' });

    const messageId = await deps.sendReply(phoneNumberId, ctx.waId, text);
    await deps.recordOutbound(conversationId, text, messageId, 'text');
    return reply.code(200).send({ messageId });
  });

  // Envoi d'un template dans une conversation (le seul moyen de ré-engager hors fenêtre 24 h).
  app.post('/tenants/:tenantId/conversations/:conversationId/send-template', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { conversationId } = req.params as { conversationId: string };
    const b = (req.body ?? {}) as Partial<{
      templateName: string;
      language: string;
      bodyParams: unknown;
      headerMediaUrl: unknown;
      headerFormat: unknown;
      templateCategory: unknown;
    }>;
    if (!nonEmpty(b.templateName)) return reply.code(400).send({ error: 'templateName requis' });
    if (!nonEmpty(b.language)) return reply.code(400).send({ error: 'language requis' });
    let bodyParams: string[] = [];
    if (b.bodyParams !== undefined) {
      if (!Array.isArray(b.bodyParams) || !b.bodyParams.every((x) => typeof x === 'string')) {
        return reply.code(400).send({ error: 'bodyParams invalide (tableau de chaînes)' });
      }
      bodyParams = b.bodyParams as string[];
    }
    const headerMediaUrl = nonEmpty(b.headerMediaUrl) ? b.headerMediaUrl : undefined;
    const headerFormat =
      b.headerFormat === 'IMAGE' || b.headerFormat === 'VIDEO' || b.headerFormat === 'DOCUMENT' ? b.headerFormat : undefined;
    // Catégorie du template (pour les stats) : normalisée en minuscules marketing|utility.
    const catRaw = typeof b.templateCategory === 'string' ? b.templateCategory.toLowerCase() : '';
    const templateCategory = catRaw === 'marketing' || catRaw === 'utility' ? catRaw : null;

    const ctx = await deps.getConversationContext(conversationId, tenant);
    if (ctx === null) return reply.code(404).send({ error: 'conversation inconnue' });
    const phoneNumberId = await deps.getTenantPhoneNumberId(tenant);
    if (!phoneNumberId) return reply.code(400).send({ error: 'aucun numéro pour ce tenant' });

    const messageId = await deps.sendTemplateMessage(phoneNumberId, ctx.waId, {
      name: b.templateName,
      language: b.language,
      bodyParams,
      ...(headerMediaUrl ? { headerMediaUrl } : {}),
      ...(headerFormat ? { headerFormat } : {}),
    });
    await deps.recordOutbound(conversationId, `[template] ${b.templateName}`, messageId, 'template', templateCategory, b.templateName);
    return reply.code(200).send({ messageId });
  });
}
