import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgInboxStore } from '../../src/inbox/store.pg';
import { PgCampaignRepo } from '../../src/campaign/store.pg';
import { PgWorkflowStore } from '../../src/workflow/store.pg';

const url = process.env.DATABASE_URL ?? '';

/**
 * Palier 3 B2 (cible node de /v1/sends) : les deux morceaux qui touchent VRAIMENT la base.
 *  - `getWindowOpenByWaIds` : la fenêtre de service 24 h en lot (c'est elle qui empêche un envoi hors fenêtre) ;
 *  - `campaigns.start_node_id` : round-trip du bloc de départ (colonne créée par la migration 0035).
 */
describe.skipIf(!url)('Cible node (Supabase)', () => {
  let pool: Pool;
  let tenantId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-node-send') returning id`)).rows[0]!.id;
  });
  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  /** Crée une conversation et, si `inboundAgeHours` est fourni, un message ENTRANT daté de cet âge. */
  async function seedConversation(waId: string, inboundAgeHours?: number): Promise<void> {
    const conv = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id) values ($1, $2) returning id`,
      [tenantId, waId],
    )).rows[0]!.id;
    if (inboundAgeHours === undefined) return;
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, body, created_at)
       values ($1, 'in', 'text', 'coucou', now() - ($2 || ' hours')::interval)`,
      [conv, String(inboundAgeHours)],
    );
  }

  it('getWindowOpenByWaIds : inbound < 24 h -> true ; > 24 h -> false ; sans conversation -> absent', async () => {
    const store = new PgInboxStore(pool);
    await seedConversation('33610000001', 2); // fenêtre ouverte
    await seedConversation('33610000002', 30); // fenêtre fermée (inbound trop vieux)
    const map = await store.getWindowOpenByWaIds(tenantId, ['33610000001', '33610000002', '33610000003']);
    expect(map.get('33610000001')).toBe(true);
    expect(map.get('33610000002')).toBe(false);
    expect(map.has('33610000003')).toBe(false); // aucune conversation -> absent -> traité fermé par l'appelant
  });

  it('getWindowOpenByWaIds : conversation SANS inbound (que du sortant) -> absent (jamais ouverte)', async () => {
    const store = new PgInboxStore(pool);
    const conv = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id) values ($1, '33610000004') returning id`,
      [tenantId],
    )).rows[0]!.id;
    await pool.query(`insert into conversation_messages (conversation_id, direction, body) values ($1, 'out', 'template')`, [conv]);
    const map = await store.getWindowOpenByWaIds(tenantId, ['33610000004']);
    expect(map.has('33610000004')).toBe(false);
  });

  it('getWindowOpenByWaIds : la conversation d’un AUTRE tenant n’est jamais vue', async () => {
    const store = new PgInboxStore(pool);
    const other = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-node-send-other') returning id`)).rows[0]!.id;
    const conv = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id) values ($1, '33610000005') returning id`,
      [other],
    )).rows[0]!.id;
    await pool.query(`insert into conversation_messages (conversation_id, direction, body) values ($1, 'in', 'coucou')`, [conv]);
    const map = await store.getWindowOpenByWaIds(tenantId, ['33610000005']);
    expect(map.has('33610000005')).toBe(false);
    await pool.query('delete from tenants where id = $1', [other]);
  });

  it('getWindowOpenByWaIds : lot vide -> map vide, aucune requête cassée', async () => {
    const store = new PgInboxStore(pool);
    expect((await store.getWindowOpenByWaIds(tenantId, [])).size).toBe(0);
  });

  it('campaigns.start_node_id : round-trip via createWithRecipients (aucune migration neuve)', async () => {
    const repo = new PgCampaignRepo(pool);
    const wfStore = new PgWorkflowStore(pool);
    const { id: wfId } = await wfStore.insert(tenantId, 'WF node', { nodes: [], edges: [] });
    const { campaignId } = await repo.createWithRecipients({
      tenantId, phoneNumberId: 'pn-node', name: 'Camp node', category: 'utility',
      templateName: '', templateLanguage: '', paramMapping: [], workflowId: wfId, startNodeId: 'n5',
    }, []);
    expect(await repo.getCampaign(campaignId)).toMatchObject({ workflowId: wfId, startNodeId: 'n5' });
  });

  it('campaigns.start_node_id : round-trip via insertCampaign', async () => {
    const repo = new PgCampaignRepo(pool);
    const wfStore = new PgWorkflowStore(pool);
    const { id: wfId } = await wfStore.insert(tenantId, 'WF node 2', { nodes: [], edges: [] });
    const campaignId = await repo.insertCampaign({
      tenantId, phoneNumberId: 'pn-node2', name: 'Camp node 2', category: 'utility',
      templateName: '', templateLanguage: '', paramMapping: [], workflowId: wfId, startNodeId: 'n9',
    });
    expect(await repo.getCampaign(campaignId)).toMatchObject({ startNodeId: 'n9' });
  });

  it('campagne SANS workflow : start_node_id forcé à null (pas de campagne bâtarde)', async () => {
    const repo = new PgCampaignRepo(pool);
    const { campaignId } = await repo.createWithRecipients({
      tenantId, phoneNumberId: 'pn-node3', name: 'Camp template', category: 'utility',
      templateName: 'promo', templateLanguage: 'fr', paramMapping: [], startNodeId: 'n-ignoré',
    }, []);
    expect(await repo.getCampaign(campaignId)).toMatchObject({ workflowId: null, startNodeId: null });
  });

  it('campagne workflow SANS startNodeId : start_node_id null (non-régression)', async () => {
    const repo = new PgCampaignRepo(pool);
    const wfStore = new PgWorkflowStore(pool);
    const { id: wfId } = await wfStore.insert(tenantId, 'WF sans node', { nodes: [], edges: [] });
    const { campaignId } = await repo.createWithRecipients({
      tenantId, phoneNumberId: 'pn-node4', name: 'Camp WF', category: 'utility',
      templateName: '', templateLanguage: '', paramMapping: [], workflowId: wfId,
    }, []);
    expect(await repo.getCampaign(campaignId)).toMatchObject({ workflowId: wfId, startNodeId: null });
  });
});
