import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgInboxStore } from '../../src/inbox/store.pg';

const url = process.env.DATABASE_URL ?? '';

/**
 * Conversations NON LUES : le SQL, contre une vraie base (migration 0055).
 *
 * Pourquoi en intégration et pas en unitaire : le calcul vit ENTIÈREMENT dans une requête (un `exists` sur
 * `conversation_messages` comparé à `conversations.last_read_at`). Un faux store dirait toujours ce qu'on
 * lui fait dire. C'est le même angle mort qui avait laissé passer un `resume_at` jamais écrit, le 2026-08-15.
 */
describe.skipIf(!url)('PgInboxStore : conversations non lues (Supabase)', () => {
  let pool: Pool;
  let tenantId: string;
  let store: PgInboxStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-unread') returning id`)).rows[0]!.id;
    store = new PgInboxStore(pool);
  });
  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  /** Crée une conversation et y pose un message, dans la direction demandée. Rend l'id de conversation. */
  async function conversationAvec(waId: string, direction: 'in' | 'out'): Promise<string> {
    const conv = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id) values ($1, $2) returning id`,
      [tenantId, waId],
    )).rows[0]!.id;
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, body) values ($1, $2, 'text', 'coucou')`,
      [conv, direction],
    );
    return conv;
  }

  it('un message ENTRANT sur un fil jamais ouvert -> non lu', async () => {
    await conversationAvec('33600000001', 'in');
    expect(await store.countUnread(tenantId)).toBe(1);
    const liste = await store.listConversations(tenantId);
    expect(liste.find((c) => c.waId === '33600000001')?.unread).toBe(true);
  });

  it('nos propres envois ne rendent PAS un fil non lu (sinon toute campagne allumerait le compteur)', async () => {
    await conversationAvec('33600000002', 'out');
    // Toujours 1 : seule la conversation entrante du test précédent compte.
    expect(await store.countUnread(tenantId)).toBe(1);
    const liste = await store.listConversations(tenantId);
    expect(liste.find((c) => c.waId === '33600000002')?.unread).toBe(false);
  });

  it('marquer lu éteint le compteur', async () => {
    const conv = (await pool.query<{ id: string }>(
      `select id from conversations where tenant_id = $1 and wa_id = '33600000001'`, [tenantId],
    )).rows[0]!.id;
    await store.markConversationRead(tenantId, conv);
    expect(await store.countUnread(tenantId)).toBe(0);
  });

  it('un NOUVEAU message entrant après lecture rallume le compteur', async () => {
    const conv = (await pool.query<{ id: string }>(
      `select id from conversations where tenant_id = $1 and wa_id = '33600000001'`, [tenantId],
    )).rows[0]!.id;
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, body) values ($1, 'in', 'text', 'encore')`,
      [conv],
    );
    expect(await store.countUnread(tenantId)).toBe(1);
  });

  it('marquer lu depuis un AUTRE tenant ne touche rien (isolation)', async () => {
    const autre = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-unread-autre') returning id`)).rows[0]!.id;
    try {
      const conv = (await pool.query<{ id: string }>(
        `select id from conversations where tenant_id = $1 and wa_id = '33600000001'`, [tenantId],
      )).rows[0]!.id;
      await store.markConversationRead(autre, conv);
      expect(await store.countUnread(tenantId)).toBe(1); // toujours non lu : le tenant ne correspondait pas
    } finally {
      await pool.query('delete from tenants where id = $1', [autre]);
    }
  });

  it('le compteur ne voit QUE son tenant', async () => {
    const autre = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-unread-voisin') returning id`)).rows[0]!.id;
    try {
      const conv = (await pool.query<{ id: string }>(
        `insert into conversations (tenant_id, wa_id) values ($1, '33699999999') returning id`, [autre],
      )).rows[0]!.id;
      await pool.query(`insert into conversation_messages (conversation_id, direction, type, body) values ($1, 'in', 'text', 'chez le voisin')`, [conv]);
      expect(await store.countUnread(tenantId)).toBe(1); // inchangé
      expect(await store.countUnread(autre)).toBe(1);
    } finally {
      await pool.query('delete from tenants where id = $1', [autre]);
    }
  });
});
