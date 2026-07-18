import type { Pool } from 'pg';
import type { InboxStore, InboundMessage } from '../webhooks/inbound';

export interface ConversationSummary {
  id: string;
  waId: string;
  profileName: string | null;
  lastPreview: string | null;
  lastMessageAt: string;
}
export interface ConversationMessage {
  id: string;
  direction: 'in' | 'out';
  type: string | null;
  body: string | null;
  buttonPayload: string | null;
  createdAt: string;
  /** Auteur d'un message sortant (name sinon partie locale de l'email). null = pas d'auteur (legacy/auto).
   *  Optionnel : les mocks de test qui omettent le champ restent valides. */
  senderName?: string | null;
}

/** Store Postgres de la boîte de réception (conversations + messages). */
export class PgInboxStore implements InboxStore {
  constructor(private readonly pool: Pool) {}

  async phoneNumberTenant(phoneNumberId: string): Promise<string | null> {
    const res = await this.pool.query<{ tenant_id: string }>(
      `select tenant_id from phone_numbers where id = $1`,
      [phoneNumberId],
    );
    return res.rows[0]?.tenant_id ?? null;
  }

  /**
   * Upsert la conversation par (tenant, wa_id), lie le contact si son identité correspond, avance last_message_at +
   * last_preview, renvoie l'id. Le wa_id est en chiffres nus (numéro) OU un BSUID : on tente '+wa_id' (E.164 exact),
   * PUIS les seuls chiffres (tolère un formatage différent), PUIS le bsuid (contact sans numéro). Partagé par
   * l'inbound (webhook) et les envois sortants automatisés (campagne / workflow) -> même conversation, jamais de
   * doublon.
   */
  private async upsertConversationByWaId(tenantId: string, waId: string, preview: string): Promise<string> {
    const conv = await this.pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, contact_id, last_message_at, last_preview)
       values ($1, $2, (select id from contacts where tenant_id = $1
           and (phone_e164 = '+' || $2 or regexp_replace(phone_e164, '[^0-9]', '', 'g') = $2 or bsuid = $2)
         order by (phone_e164 = '+' || $2) desc limit 1), now(), $3)
       on conflict (tenant_id, wa_id) do update set
         last_message_at = now(),
         last_preview = excluded.last_preview,
         contact_id = coalesce(conversations.contact_id, excluded.contact_id),
         -- Un nouveau message ROUVRE l'analyse : une conversation déjà analysée (done/failed) qui reçoit un message
         -- redevient 'pending' -> ré-analysée à la prochaine inactivité (sinon un contact qui revient n'est jamais réanalysé).
         analysis_status = case when conversations.analysis_status in ('done', 'failed') then 'pending' else conversations.analysis_status end
       returning id`,
      [tenantId, waId, preview],
    );
    return conv.rows[0]!.id;
  }

  async recordInbound(tenantId: string, m: InboundMessage): Promise<void> {
    const preview = m.body ?? m.buttonPayload ?? `[${m.type}]`;
    const conversationId = await this.upsertConversationByWaId(tenantId, m.waId, preview);
    await this.pool.query(
      `insert into conversation_messages (conversation_id, direction, type, body, button_payload, meta_message_id)
       values ($1, 'in', $2, $3, $4, $5)
       on conflict (meta_message_id) where meta_message_id is not null do nothing`,
      [conversationId, m.type, m.body, m.buttonPayload, m.messageId],
    );
  }

  /**
   * Journalise un envoi sortant AUTOMATISÉ (template de campagne ou de workflow) par wa_id : upsert la conversation
   * + insère le message 'out' avec `sender_user_id = null` (pas un humain -> pas de pastille agent). Idempotent sur
   * `meta_message_id`. Sans ça, les envois campagne/workflow n'apparaissaient PAS dans le fil d'inbox et manquaient
   * au transcript d'analyse. À appeler en BEST-EFFORT côté appelant (un échec de log ne doit pas casser l'envoi Meta).
   */
  async recordOutboundByWaId(
    tenantId: string,
    waId: string,
    msg: { body: string; messageId: string | null; type?: string; templateCategory?: string | null; templateName?: string | null },
  ): Promise<void> {
    const conversationId = await this.upsertConversationByWaId(tenantId, waId, msg.body);
    await this.pool.query(
      `insert into conversation_messages (conversation_id, direction, type, body, meta_message_id, template_category, template_name, sender_user_id)
       values ($1, 'out', $2, $3, $4, $5, $6, null)
       on conflict (meta_message_id) where meta_message_id is not null do nothing`,
      [conversationId, msg.type ?? 'template', msg.body, msg.messageId, msg.templateCategory ?? null, msg.templateName ?? null],
    );
  }

  async listConversations(tenantId: string): Promise<ConversationSummary[]> {
    const res = await this.pool.query<{
      id: string; wa_id: string; profile_name: string | null; last_preview: string | null; last_message_at: Date;
    }>(
      `select c.id, c.wa_id, ct.profile_name, c.last_preview, c.last_message_at
       from conversations c
       left join contacts ct on ct.id = c.contact_id
       where c.tenant_id = $1
       order by c.last_message_at desc
       limit 100`,
      [tenantId],
    );
    return res.rows.map((r) => ({
      id: r.id,
      waId: r.wa_id,
      profileName: r.profile_name,
      lastPreview: r.last_preview,
      lastMessageAt: r.last_message_at.toISOString(),
    }));
  }

  /**
   * Contexte pour répondre : wa_id + état de la fenêtre de service 24 h. La fenêtre est ouverte
   * si le DERNIER message ENTRANT (du client) a moins de 24 h. Hors fenêtre -> texte libre
   * interdit par Meta (131047), il faut un template. null si conversation absente/autre tenant.
   */
  async getConversationContext(
    conversationId: string,
    tenantId: string,
  ): Promise<{ waId: string; lastInboundAt: string | null; windowOpen: boolean } | null> {
    const res = await this.pool.query<{ wa_id: string; last_in: Date | null }>(
      `select c.wa_id, max(m.created_at) filter (where m.direction = 'in') as last_in
       from conversations c
       left join conversation_messages m on m.conversation_id = c.id
       where c.id = $1 and c.tenant_id = $2
       group by c.wa_id`,
      [conversationId, tenantId],
    );
    const r = res.rows[0];
    if (!r) return null;
    const lastIn = r.last_in;
    const windowOpen = !!lastIn && Date.now() - lastIn.getTime() < 24 * 3600 * 1000;
    return { waId: r.wa_id, lastInboundAt: lastIn ? lastIn.toISOString() : null, windowOpen };
  }

  /**
   * Fenêtre de service 24 h pour un LOT de wa_id (cible node de /v1/sends, D-1). Même règle que
   * `getConversationContext` : dernier message ENTRANT strictement < 24 h. Un wa_id sans conversation, ou avec
   * une conversation mais aucun inbound, est ABSENT de la map -> l'appelant le traite comme fermé
   * (`.get()` -> undefined -> falsy). Une seule requête pour tout le lot (pas de N+1).
   */
  async getWindowOpenByWaIds(tenantId: string, waIds: string[]): Promise<Map<string, boolean>> {
    const out = new Map<string, boolean>();
    if (waIds.length === 0) return out;
    const res = await this.pool.query<{ wa_id: string; last_in: Date | null }>(
      `select c.wa_id, max(m.created_at) filter (where m.direction = 'in') as last_in
       from conversations c
       left join conversation_messages m on m.conversation_id = c.id
       where c.tenant_id = $1 and c.wa_id = any($2::text[])
       group by c.wa_id`,
      [tenantId, waIds],
    );
    for (const r of res.rows) {
      if (!r.last_in) continue; // aucun inbound -> fenêtre jamais ouverte, on laisse absent
      out.set(r.wa_id, Date.now() - r.last_in.getTime() < 24 * 3600 * 1000);
    }
    return out;
  }

  async getMessages(conversationId: string): Promise<ConversationMessage[]> {
    const res = await this.pool.query<{
      id: string; direction: 'in' | 'out'; type: string | null; body: string | null; button_payload: string | null; created_at: Date; sender_name: string | null;
    }>(
      // sender_name : name du user, sinon la partie locale de son email ; null si pas d'auteur (legacy/auto).
      `select m.id, m.direction, m.type, m.body, m.button_payload, m.created_at,
              coalesce(nullif(u.name, ''), split_part(u.email, '@', 1)) as sender_name
       from conversation_messages m
       left join users u on u.id = m.sender_user_id
       where m.conversation_id = $1 order by m.created_at limit 500`,
      [conversationId],
    );
    return res.rows.map((r) => ({
      id: r.id,
      direction: r.direction,
      type: r.type,
      body: r.body,
      buttonPayload: r.button_payload,
      createdAt: r.created_at.toISOString(),
      senderName: r.sender_name,
    }));
  }

  /** Journalise une réponse sortante de l'agent (texte libre ou template). Pour un template,
   *  `templateCategory` (marketing|utility) + `templateName` alimentent les stats du dashboard.
   *  `senderUserId` (EN FIN de signature) = auteur -> pastille dans l'inbox ; null pour les réponses auto. */
  async recordOutbound(
    conversationId: string,
    body: string,
    messageId: string | null,
    type = 'text',
    templateCategory: string | null = null,
    templateName: string | null = null,
    senderUserId: string | null = null,
  ): Promise<void> {
    await this.pool.query(
      `update conversations set last_message_at = now(), last_preview = $2,
         analysis_status = case when analysis_status in ('done', 'failed') then 'pending' else analysis_status end
       where id = $1`,
      [conversationId, body],
    );
    await this.pool.query(
      `insert into conversation_messages (conversation_id, direction, type, body, meta_message_id, template_category, template_name, sender_user_id)
       values ($1, 'out', $4, $2, $3, $5, $6, $7)`,
      [conversationId, body, messageId, type, templateCategory, templateName, senderUserId],
    );
  }
}
