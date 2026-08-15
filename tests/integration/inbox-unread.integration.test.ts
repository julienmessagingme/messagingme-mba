import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgInboxStore } from '../../src/inbox/store.pg';
import { PgWorkflowRunStore } from '../../src/workflow/run-store.pg';

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

/**
 * Lancement MANUEL d'un scénario depuis l'Inbox : le parcours déjà en cours sur le contact doit être clos,
 * sinon les deux vivent en parallèle (le contact reçoit les messages des deux) et le plus ancien devient
 * orphelin pour toujours, `findWaitingByWaId` ne rendant que le plus récent.
 */
describe.skipIf(!url)('PgWorkflowRunStore.closeActiveByWaId (Supabase)', () => {
  let pool: Pool;
  let tenantId: string;
  let autreTenant: string;
  let workflowId: string;
  let store: PgWorkflowRunStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-close-runs') returning id`)).rows[0]!.id;
    autreTenant = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-close-runs-voisin') returning id`)).rows[0]!.id;
    workflowId = (await pool.query<{ id: string }>(
      `insert into workflows (tenant_id, name, graph) values ($1, 'itest', '{"nodes":[],"edges":[]}'::jsonb) returning id`,
      [tenantId],
    )).rows[0]!.id;
    store = new PgWorkflowRunStore(pool);
  });
  afterAll(async () => {
    for (const t of [tenantId, autreTenant]) if (t) await pool.query('delete from tenants where id = $1', [t]);
    await pool.end();
  });

  const statuts = async (tenant: string, waId: string): Promise<string[]> =>
    (await pool.query<{ status: string }>(
      `select status from workflow_runs where tenant_id = $1 and wa_id = $2 order by created_at`, [tenant, waId],
    )).rows.map((r) => r.status);

  it('clôt les parcours en attente ET endormis, et rend leur nombre', async () => {
    await store.start(tenantId, workflowId, '33600000010', null, { currentNode: 'n1', status: 'waiting' });
    await store.start(tenantId, workflowId, '33600000010', null, { currentNode: 'n2', status: 'sleeping', resumeAt: new Date(Date.now() + 3_600_000) });
    expect(await store.closeActiveByWaId(tenantId, '33600000010')).toBe(2);
    expect(await statuts(tenantId, '33600000010')).toEqual(['done', 'done']);
  });

  it('efface aussi l’échéance de réveil (sinon le balayage reprendrait un run clos)', async () => {
    await store.start(tenantId, workflowId, '33600000011', null, { currentNode: 'n1', status: 'sleeping', resumeAt: new Date(Date.now() + 3_600_000) });
    await store.closeActiveByWaId(tenantId, '33600000011');
    const { rows } = await pool.query<{ resume_at: Date | null }>(
      `select resume_at from workflow_runs where tenant_id = $1 and wa_id = $2`, [tenantId, '33600000011'],
    );
    expect(rows[0]?.resume_at).toBeNull();
  });

  it('ne touche PAS les parcours d’un autre tenant, ni ceux déjà clos', async () => {
    await store.start(tenantId, workflowId, '33600000012', null, { currentNode: null, status: 'done' });
    const wfVoisin = (await pool.query<{ id: string }>(
      `insert into workflows (tenant_id, name, graph) values ($1, 'itest-voisin', '{"nodes":[],"edges":[]}'::jsonb) returning id`,
      [autreTenant],
    )).rows[0]!.id;
    await store.start(autreTenant, wfVoisin, '33600000012', null, { currentNode: 'n1', status: 'waiting' });

    expect(await store.closeActiveByWaId(tenantId, '33600000012')).toBe(0); // le sien était déjà clos
    expect(await statuts(autreTenant, '33600000012')).toEqual(['waiting']); // le voisin est intact
  });

  it('aucun parcours actif -> 0, sans erreur', async () => {
    expect(await store.closeActiveByWaId(tenantId, '33699999998')).toBe(0);
  });
});
