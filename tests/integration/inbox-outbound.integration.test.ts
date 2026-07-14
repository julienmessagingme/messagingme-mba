import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgInboxStore } from '../../src/inbox/store.pg';
import { PgStatsStore } from '../../src/stats/store.pg';

const url = process.env.DATABASE_URL ?? '';

// Pièce 0 : les envois campagne/workflow doivent atterrir dans conversation_messages (fil inbox + transcript).
describe.skipIf(!url)('PgInboxStore.recordOutboundByWaId (Supabase)', () => {
  let pool: Pool;
  let tenantId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-inbox-out') returning id`)).rows[0]!.id;
  });
  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  const countMessages = async (convId: string): Promise<number> =>
    Number((await pool.query<{ n: string }>(`select count(*)::int as n from conversation_messages where conversation_id = $1`, [convId])).rows[0]!.n);
  const conversationId = async (waId: string): Promise<string[]> =>
    (await pool.query<{ id: string }>(`select id from conversations where tenant_id = $1 and wa_id = $2`, [tenantId, waId])).rows.map((r) => r.id);

  it('crée la conversation par wa_id + insère le message out (sender_user_id null)', async () => {
    const store = new PgInboxStore(pool);
    const waId = '33600000123';
    await store.recordOutboundByWaId(tenantId, waId, { body: 'Template « promo » (Léa)', messageId: 'wamid-A', type: 'template', templateCategory: 'marketing', templateName: 'promo' });
    const convs = await conversationId(waId);
    expect(convs).toHaveLength(1);
    const msg = (await pool.query<{ direction: string; type: string; template_name: string; template_category: string; sender_user_id: string | null }>(
      `select direction, type, template_name, template_category, sender_user_id from conversation_messages where conversation_id = $1`,
      [convs[0]!],
    )).rows[0]!;
    expect(msg).toMatchObject({ direction: 'out', type: 'template', template_name: 'promo', template_category: 'marketing', sender_user_id: null });
  });

  it('même wa_id, 2e envoi -> même conversation, 2 messages (jamais de conversation en double)', async () => {
    const store = new PgInboxStore(pool);
    const waId = '33600000456';
    await store.recordOutboundByWaId(tenantId, waId, { body: 'A', messageId: 'wamid-B1', templateName: 'promo' });
    await store.recordOutboundByWaId(tenantId, waId, { body: 'B', messageId: 'wamid-B2', templateName: 'promo' });
    const convs = await conversationId(waId);
    expect(convs).toHaveLength(1);
    expect(await countMessages(convs[0]!)).toBe(2);
  });

  it('idempotent sur meta_message_id : même messageId 2x -> un seul message', async () => {
    const store = new PgInboxStore(pool);
    const waId = '33600000789';
    await store.recordOutboundByWaId(tenantId, waId, { body: 'A', messageId: 'wamid-DUP', templateName: 'promo' });
    await store.recordOutboundByWaId(tenantId, waId, { body: 'A', messageId: 'wamid-DUP', templateName: 'promo' });
    const convs = await conversationId(waId);
    expect(await countMessages(convs[0]!)).toBe(1);
  });

  it('inbound PUIS outbound sur le même wa_id -> une seule conversation, les deux messages', async () => {
    const store = new PgInboxStore(pool);
    const waId = '33600000999';
    await store.recordInbound(tenantId, { waId, phoneNumberId: 'pn-test', body: 'Bonjour', type: 'text', buttonPayload: null, messageId: 'wamid-IN', profileName: null });
    await store.recordOutboundByWaId(tenantId, waId, { body: 'Template « promo »', messageId: 'wamid-OUT', templateName: 'promo' });
    const convs = await conversationId(waId);
    expect(convs).toHaveLength(1); // pas de doublon : outbound tombe sur la conversation de l'inbound
    expect(await countMessages(convs[0]!)).toBe(2);
  });

  // Garde-fou du 🔴 de la revue : un template de campagne DIRECTE est dans campaign_recipients ET (Pièce 0)
  // conversation_messages -> les stats l'unionnent, il doit être compté UNE seule fois (même wamid).
  it('stats getTemplateBreakdown : template de campagne directe compté UNE fois (pas de double-compte)', async () => {
    const store = new PgInboxStore(pool);
    const stats = new PgStatsStore(pool);
    const waId = '33600011111';
    const wamid = 'wamid-STAT-1';
    const contact = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164, opt_in_status) values ($1, '+33600011111', 'opted_in') returning id`, [tenantId])).rows[0]!.id;
    const camp = (await pool.query<{ id: string }>(
      `insert into campaigns (tenant_id, phone_number_id, name, category, template_name, template_language, status)
       values ($1, 'pn1', 'promo-camp', 'marketing', 'promo_stat', 'fr', 'completed') returning id`, [tenantId])).rows[0]!.id;
    await pool.query(
      `insert into campaign_recipients (campaign_id, contact_id, to_e164, status, message_id, sent_at)
       values ($1, $2, '+33600011111', 'sent', $3, now())`, [camp, contact, wamid]);
    // Pièce 0 logge le MÊME envoi dans conversation_messages (même wamid).
    await store.recordOutboundByWaId(tenantId, waId, { body: 'Template « promo_stat »', messageId: wamid, type: 'template', templateCategory: 'marketing', templateName: 'promo_stat' });

    const d = (o: number): string => new Date(Date.now() + o * 86_400_000).toISOString().slice(0, 10);
    const rows = await stats.getTemplateBreakdown(tenantId, { from: d(-1), to: d(1) });
    expect(rows.find((r) => r.name === 'promo_stat')?.count).toBe(1); // une fois, pas deux
  });
});
