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

  async recordInbound(tenantId: string, m: InboundMessage): Promise<void> {
    const preview = m.body ?? m.buttonPayload ?? `[${m.type}]`;
    // Upsert la conversation ; lie le contact si un numéro correspond. Le wa_id est en chiffres
    // nus : on tente '+wa_id' (E.164 exact) PUIS une comparaison sur les seuls chiffres (tolère
    // les contacts stockés avec un formatage différent).
    const conv = await this.pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, contact_id, last_message_at, last_preview)
       values ($1, $2, (select id from contacts where tenant_id = $1
           and (phone_e164 = '+' || $2 or regexp_replace(phone_e164, '[^0-9]', '', 'g') = $2)
         order by (phone_e164 = '+' || $2) desc limit 1), now(), $3)
       on conflict (tenant_id, wa_id) do update set
         last_message_at = now(),
         last_preview = excluded.last_preview,
         contact_id = coalesce(conversations.contact_id, excluded.contact_id)
       returning id`,
      [tenantId, m.waId, preview],
    );
    const conversationId = conv.rows[0]!.id;
    await this.pool.query(
      `insert into conversation_messages (conversation_id, direction, type, body, button_payload, meta_message_id)
       values ($1, 'in', $2, $3, $4, $5)
       on conflict (meta_message_id) where meta_message_id is not null do nothing`,
      [conversationId, m.type, m.body, m.buttonPayload, m.messageId],
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

  async getMessages(conversationId: string): Promise<ConversationMessage[]> {
    const res = await this.pool.query<{
      id: string; direction: 'in' | 'out'; type: string | null; body: string | null; button_payload: string | null; created_at: Date;
    }>(
      `select id, direction, type, body, button_payload, created_at
       from conversation_messages where conversation_id = $1 order by created_at limit 500`,
      [conversationId],
    );
    return res.rows.map((r) => ({
      id: r.id,
      direction: r.direction,
      type: r.type,
      body: r.body,
      buttonPayload: r.button_payload,
      createdAt: r.created_at.toISOString(),
    }));
  }

  /** Journalise une réponse sortante de l'agent (texte libre ou template). */
  async recordOutbound(conversationId: string, body: string, messageId: string | null, type = 'text'): Promise<void> {
    await this.pool.query(`update conversations set last_message_at = now(), last_preview = $2 where id = $1`, [conversationId, body]);
    await this.pool.query(
      `insert into conversation_messages (conversation_id, direction, type, body, meta_message_id)
       values ($1, 'out', $4, $2, $3)`,
      [conversationId, body, messageId, type],
    );
  }
}
