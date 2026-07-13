import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgContactStore } from '../../src/crm/contact-store.pg';
import { PgUserFieldStore } from '../../src/crm/field-store.pg';
import { PgTagStore } from '../../src/crm/tag-store.pg';
import {
  PgCampaignRepo,
  PgCampaignStore,
  PgRecipientStore,
  PgFrequencyStore,
  PgQualityProvider,
} from '../../src/campaign/store.pg';
import { PgStatsStore } from '../../src/stats/store.pg';
import { PgOpsStore } from '../../src/ops/store.pg';
import { PgWorkflowStore } from '../../src/workflow/store.pg';

const url = process.env.DATABASE_URL ?? '';

describe.skipIf(!url)('adaptateurs Postgres (Supabase)', () => {
  let pool: Pool;
  let tenantId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    const res = await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-stores') returning id`,
    );
    tenantId = res.rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  it('PgContactStore.upsertByPhone : create puis update fusionne fields, opt-in ne régresse pas', async () => {
    const store = new PgContactStore(pool);
    const phone = '+33600000001';
    const c1 = await store.upsertByPhone({ tenantId, phoneE164: phone, profileName: 'Julie', fields: { ville: 'Lyon' }, optInStatus: 'unknown' });
    expect(c1).toBe('created');
    const c2 = await store.upsertByPhone({ tenantId, phoneE164: phone, profileName: null, fields: { age: '30' }, optInStatus: 'opted_in', optInSource: 'csv_import' });
    expect(c2).toBe('updated');

    const row = (await pool.query<{ fields: Record<string, unknown>; profile_name: string; opt_in_status: string }>(
      `select fields, profile_name, opt_in_status from contacts where tenant_id = $1 and phone_e164 = $2`,
      [tenantId, phone],
    )).rows[0]!;
    expect(row.fields).toMatchObject({ ville: 'Lyon', age: '30' }); // MERGE, pas replace
    expect(row.profile_name).toBe('Julie'); // coalesce : non écrasé par null
    expect(row.opt_in_status).toBe('opted_in'); // promu, ne régresse pas
  });

  it('PgContactStore.upsertByPhone : tags fusionnés (union dédup), jamais écrasés', async () => {
    const store = new PgContactStore(pool);
    const phone = '+33600000009';
    await store.upsertByPhone({ tenantId, phoneE164: phone, profileName: 'Léa', fields: {}, optInStatus: 'opted_in', tags: ['salon-2026', 'prospect'] });
    // Ré-import avec un tag en commun + un nouveau -> union dédupliquée.
    await store.upsertByPhone({ tenantId, phoneE164: phone, profileName: null, fields: {}, optInStatus: 'unknown', tags: ['prospect', 'vip'] });
    // Ré-import SANS tags -> les tags existants sont préservés (pas d'écrasement).
    await store.upsertByPhone({ tenantId, phoneE164: phone, profileName: null, fields: { ville: 'Nice' }, optInStatus: 'unknown' });

    const rows = await store.list(tenantId);
    const lea = rows.find((r) => r.phoneE164 === phone)!;
    expect([...lea.tags].sort()).toEqual(['prospect', 'salon-2026', 'vip']); // union, aucun doublon, rien perdu
    expect(lea.fields).toMatchObject({ ville: 'Nice' }); // le 3e import a bien mergé les fields

    // Filtre par tag (clic sur le nombre dans l'onglet Tags) : $4 = any(tags).
    const bySalon = await store.list(tenantId, 500, 0, 'salon-2026');
    expect(bySalon.some((r) => r.phoneE164 === phone)).toBe(true);
    const byVip = await store.list(tenantId, 500, 0, 'vip');
    expect(byVip.some((r) => r.phoneE164 === phone)).toBe(true);
    const byNone = await store.list(tenantId, 500, 0, 'tag-inexistant-xyz');
    expect(byNone.some((r) => r.phoneE164 === phone)).toBe(false);
  });

  it('PgContactStore.applyEdits : MERGE fields + tags add/remove en transaction, scoping tenant', async () => {
    const store = new PgContactStore(pool);
    const contactId = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164, opt_in_status, fields, tags)
       values ($1, $2, 'opted_in', '{"ville":"Lyon"}'::jsonb, array['vip']) returning id`,
      [tenantId, '+33600000010'],
    )).rows[0]!.id;

    // MERGE fields (garde ville, ajoute age) + addTags dédup (vip déjà là).
    const c1 = await store.applyEdits(tenantId, contactId, { fields: { age: '42' }, addTags: ['prospect', 'vip'], removeTags: [] });
    expect(c1!.fields).toMatchObject({ ville: 'Lyon', age: '42' });
    expect([...c1!.tags].sort()).toEqual(['prospect', 'vip']); // union dédup

    // removeTags : retire tous les tags -> '{}' (pas NULL) ; fields intacts.
    const c2 = await store.applyEdits(tenantId, contactId, { fields: {}, addTags: [], removeTags: ['vip', 'prospect'] });
    expect(c2!.tags).toEqual([]);
    expect(c2!.fields).toMatchObject({ ville: 'Lyon', age: '42' });

    // Contact inexistant -> null (=> 404 amont), aucune écriture.
    expect(await store.applyEdits(tenantId, '00000000-0000-0000-0000-000000000000', { fields: { age: '1' }, addTags: [], removeTags: [] })).toBeNull();

    // getById scopé tenant.
    expect(await store.getById(tenantId, contactId)).not.toBeNull();
    expect(await store.getById('00000000-0000-0000-0000-000000000000', contactId)).toBeNull();
  });

  it('PgUserFieldStore : upsert idempotent + list', async () => {
    const store = new PgUserFieldStore(pool);
    await store.upsert(tenantId, { key: 'ville', label: 'Ville', type: 'text' });
    await store.upsert(tenantId, { key: 'ville', label: 'AUTRE', type: 'text' }); // do nothing
    const list = await store.list(tenantId);
    const ville = list.filter((f) => f.key === 'ville');
    expect(ville).toHaveLength(1);
    expect(ville[0]?.label).toBe('Ville');
  });

  it('PgUserFieldStore.create : created puis exists (pas d’écrasement)', async () => {
    const store = new PgUserFieldStore(pool);
    expect(await store.create(tenantId, { key: 'newf', label: 'New', type: 'text' })).toBe('created');
    expect(await store.create(tenantId, { key: 'newf', label: 'Autre', type: 'number' })).toBe('exists');
    expect((await store.list(tenantId)).find((f) => f.key === 'newf')?.label).toBe('New'); // pas écrasé
  });

  it('PgTagStore : create idempotent, listDistinct union (déclaré 0 + utilisé), rename/remove transactionnels', async () => {
    const store = new PgTagStore(pool);
    expect(await store.create(tenantId, 'declared-only')).toBe(true);
    expect(await store.create(tenantId, 'declared-only')).toBe(false); // idempotent

    await pool.query(`insert into contacts (tenant_id, phone_e164, opt_in_status, tags) values ($1, $2, 'opted_in', array['used-only'])`, [tenantId, '+33600000020']);
    const before = new Map((await store.listDistinct(tenantId)).map((t) => [t.tag, t.count]));
    expect(before.get('declared-only')).toBe(0); // déclaré, non utilisé
    expect(before.get('used-only')).toBe(1); // utilisé

    expect(await store.rename(tenantId, 'used-only', 'renamed')).toBe(1);
    const after = new Map((await store.listDistinct(tenantId)).map((t) => [t.tag, t.count]));
    expect(after.has('used-only')).toBe(false);
    expect(after.get('renamed')).toBe(1);

    // rename d'un `from` inconnu -> ne déclare PAS 'ghost-to'.
    await store.rename(tenantId, 'inconnu-xyz', 'ghost-to');
    expect((await store.listDistinct(tenantId)).some((t) => t.tag === 'ghost-to')).toBe(false);

    // remove d'un tag déclaré -> disparaît de la table.
    await store.remove(tenantId, 'declared-only');
    expect((await store.listDistinct(tenantId)).some((t) => t.tag === 'declared-only')).toBe(false);
  });

  it('PgCampaignRepo + stores : insert, listPending, markResult, setStatus, lastSentAt', async () => {
    const repo = new PgCampaignRepo(pool);
    const recipients = new PgRecipientStore(pool);
    const campaignsStore = new PgCampaignStore(pool);
    const frequency = new PgFrequencyStore(pool);

    const contactId = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164, opt_in_status) values ($1, $2, 'opted_in') returning id`,
      [tenantId, '+33600000002'],
    )).rows[0]!.id;

    const campaignId = await repo.insertCampaign({
      tenantId, phoneNumberId: 'pn-itest', name: 'c', category: 'marketing',
      templateName: 't', templateLanguage: 'fr', paramMapping: [],
    });
    const n = await repo.insertRecipients(campaignId, [{ contactId, toE164: '+33600000002', resolvedParams: ['X'] }]);
    expect(n).toBe(1);

    const pending = await recipients.listPending(campaignId);
    expect(pending).toHaveLength(1);
    const rid = pending[0]!.id;

    // Claim atomique : le 1er réserve (pending -> sending), le 2e échoue (déjà pris).
    expect(await recipients.claim(rid)).toBe(true);
    expect(await recipients.claim(rid)).toBe(false);
    expect(await recipients.listPending(campaignId)).toHaveLength(0); // 'sending' exclu

    const at = 1_700_000_000_000;
    await recipients.markResult(rid, { status: 'sent', messageId: 'm-1', sentAt: at });
    const rrow = (await pool.query<{ status: string; message_id: string; sent_at: Date }>(
      `select status, message_id, sent_at from campaign_recipients where id = $1`, [rid],
    )).rows[0]!;
    expect(rrow.status).toBe('sent');
    expect(rrow.message_id).toBe('m-1');
    expect(rrow.sent_at).not.toBeNull();

    await campaignsStore.setStatus(campaignId, 'completed');
    const status = (await pool.query<{ status: string }>(`select status from campaigns where id = $1`, [campaignId])).rows[0]!.status;
    expect(status).toBe('completed');

    // lastSentAt cross-campagne lit max(sent_at) du numéro.
    const last = await frequency.lastSentAt(tenantId, '+33600000002');
    expect(last).toBe(at);
    expect(await frequency.lastSentAt(tenantId, '+33699999999')).toBeNull();

    // Suivi de livraison (par message_id 'm-1'), monotone.
    expect(await recipients.updateDeliveryByMessageId('m-1', 'sent', null, null)).toBe(1);
    expect(await recipients.updateDeliveryByMessageId('m-1', 'read', null, null)).toBe(1);
    expect(await recipients.updateDeliveryByMessageId('m-1', 'delivered', null, null)).toBe(0); // read ne régresse pas
    const dstatus = (await pool.query<{ delivery_status: string }>(`select delivery_status from campaign_recipients where id = $1`, [rid])).rows[0]?.delivery_status;
    expect(dstatus).toBe('read');
    expect(await recipients.updateDeliveryByMessageId('m-inconnu', 'sent', null, null)).toBe(0); // wamid pas à nous

    // error_code : un 'failed' avec code le persiste (breakdown analytics).
    expect(await recipients.updateDeliveryByMessageId('m-1', 'failed', '131049 blocked', 131049)).toBe(1);
    const ec = (await pool.query<{ error_code: number | null }>(`select error_code from campaign_recipients where id = $1`, [rid])).rows[0]?.error_code;
    expect(ec).toBe(131049);
  });

  it('PgStatsStore : campaign funnel (répondu=inbound après envoi), error breakdown, cost volume', async () => {
    const repo = new PgCampaignRepo(pool);
    const recipients = new PgRecipientStore(pool);
    const stats = new PgStatsStore(pool);

    const mk = async (phone: string) => (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164, opt_in_status) values ($1, $2, 'opted_in') returning id`, [tenantId, phone],
    )).rows[0]!.id;
    const [c1, c2, c3] = [await mk('+33600000050'), await mk('+33600000051'), await mk('+33600000052')];
    const { campaignId } = await repo.createWithRecipients(
      { tenantId, phoneNumberId: 'pn-st', name: 'Funnel', category: 'marketing', templateName: 'te', templateLanguage: 'fr', paramMapping: [] },
      [
        { contactId: c1, toE164: '+33600000050', resolvedParams: [] },
        { contactId: c2, toE164: '+33600000051', resolvedParams: [] },
        { contactId: c3, toE164: '+33600000052', resolvedParams: [] },
      ],
    );
    const byPhone = new Map((await recipients.listPending(campaignId)).map((p) => [p.toE164, p.id]));
    const r1 = byPhone.get('+33600000050')!, r2 = byPhone.get('+33600000051')!, r3 = byPhone.get('+33600000052')!;
    const at = Date.now() - 5000;

    // r1 envoyé + lu + répond ; r2 envoyé + délivré ; r3 échec d'envoi (code 131026).
    await recipients.claim(r1); await recipients.markResult(r1, { status: 'sent', messageId: 'ms-1', sentAt: at });
    await recipients.claim(r2); await recipients.markResult(r2, { status: 'sent', messageId: 'ms-2', sentAt: at });
    await recipients.claim(r3); await recipients.markResult(r3, { status: 'failed', error: '131026 x', errorCode: 131026 });
    await recipients.updateDeliveryByMessageId('ms-1', 'read', null, null);
    await recipients.updateDeliveryByMessageId('ms-2', 'delivered', null, null);

    // r1 répond : conversation + message ENTRANT après l'envoi (created_at defaut now() > at).
    const convId = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id) values ($1, '33600000050') returning id`, [tenantId],
    )).rows[0]!.id;
    await pool.query(`insert into conversation_messages (conversation_id, direction, type, body) values ($1, 'in', 'text', 'oui')`, [convId]);

    const funnel = await stats.getCampaignFunnel(tenantId, campaignId);
    expect(funnel).toEqual({ sent: 2, delivered: 2, read: 1, replied: 1, failed: 1 });

    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
    const range = { from: today, to: today };
    const errors = await stats.getErrorBreakdown(tenantId, range);
    expect(errors.find((e) => e.code === 131026)?.count).toBe(1);

    const vol = await stats.getCostVolume(tenantId, range, {});
    expect(vol.find((v) => v.category === 'marketing' && v.date === today)?.count).toBe(2); // r1 + r2 (r3 échec exclu)
    // Filtre par template inexistant -> aucun volume.
    expect(await stats.getCostVolume(tenantId, range, { templateName: 'inconnu' })).toHaveLength(0);
  });

  it('getCampaignFunnel : une réponse est attribuée à la DERNIÈRE campagne (pas de double-comptage)', async () => {
    const repo = new PgCampaignRepo(pool);
    const recipients = new PgRecipientStore(pool);
    const stats = new PgStatsStore(pool);
    const phone = '+33600000060';
    const contactId = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164, opt_in_status) values ($1, $2, 'opted_in') returning id`, [tenantId, phone],
    )).rows[0]!.id;
    const mkCampaign = async (name: string, sentAt: number): Promise<string> => {
      const { campaignId } = await repo.createWithRecipients(
        { tenantId, phoneNumberId: 'pn-a', name, category: 'marketing', templateName: 'tt', templateLanguage: 'fr', paramMapping: [] },
        [{ contactId, toE164: phone, resolvedParams: [] }],
      );
      const rid = (await recipients.listPending(campaignId))[0]!.id;
      await recipients.claim(rid);
      await recipients.markResult(rid, { status: 'sent', messageId: `mm-${name}`, sentAt });
      return campaignId;
    };
    const base = Date.now() - 20_000;
    const campA = await mkCampaign('A', base);
    const campB = await mkCampaign('B', base + 5_000); // envoi ultérieur au MÊME numéro
    // Réponse APRÈS les deux envois -> attribuée à B (le dernier envoi avant la réponse), pas à A.
    const convId = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id) values ($1, '33600000060') returning id`, [tenantId],
    )).rows[0]!.id;
    await pool.query(`insert into conversation_messages (conversation_id, direction, type, body) values ($1, 'in', 'text', 'oui')`, [convId]);

    expect((await stats.getCampaignFunnel(tenantId, campA)).replied).toBe(0); // volée par B
    expect((await stats.getCampaignFunnel(tenantId, campB)).replied).toBe(1);
  });

  it('PgOpsStore : rollup cross-tenant (le tenant de test apparaît, agrégats cohérents) + queue load', async () => {
    const ops = new PgOpsStore(pool, 'pgboss');
    const overview = await ops.getTenantOverview();
    const mine = overview.find((t) => t.id === tenantId);
    expect(mine).toBeDefined();
    // Les tests précédents ont créé contacts + campagnes + envois pour CE tenant.
    expect(mine!.contacts).toBeGreaterThan(0);
    expect(mine!.templatesUsed).toBeGreaterThan(0);
    expect(typeof mine!.mbaEnabled).toBe('boolean');

    const daily = await ops.getGlobalDaily(14);
    expect(Array.isArray(daily)).toBe(true);

    // Queue load : tolère l'absence de pg-boss, sinon renvoie les 4 files avec des compteurs >= 0.
    const queues = await ops.getQueueLoad();
    expect(queues.map((q) => q.queue)).toEqual(['webhook', 'campaign-run', 'webhook-dlq', 'campaign-run-dlq']);
    for (const q of queues) {
      expect(q.backlog).toBeGreaterThanOrEqual(0);
      expect(q.active).toBeGreaterThanOrEqual(0);
      expect(q.failed).toBeGreaterThanOrEqual(0);
    }
  });

  it('PgWorkflowStore : insert/list/getById/update (graphe jsonb round-trip)/remove', async () => {
    const store = new PgWorkflowStore(pool);
    const graph = {
      nodes: [
        { id: 'n1', type: 'tag' as const, position: { x: 0, y: 0 }, data: { tag: 'vip' } },
        { id: 'n2', type: 'template' as const, position: { x: 200, y: 0 }, data: { templateName: 'promo' } },
      ],
      edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
    };
    const { id } = await store.insert(tenantId, 'Onboarding', graph);
    expect(id).toBeTruthy();

    const list = await store.list(tenantId);
    const mine = list.find((w) => w.id === id);
    expect(mine).toBeDefined();
    expect(mine!.status).toBe('draft');
    expect(mine!.graph).toEqual(graph); // round-trip jsonb intact

    const one = await store.getById(id, tenantId);
    expect(one!.graph.nodes).toHaveLength(2);

    // update partiel : seul le status change, le graphe est préservé (coalesce).
    expect(await store.update(id, tenantId, { status: 'active' })).toBe(true);
    const afterStatus = await store.getById(id, tenantId);
    expect(afterStatus!.status).toBe('active');
    expect(afterStatus!.graph).toEqual(graph); // graphe non écrasé

    // update du graphe.
    const g2 = { nodes: [{ id: 'n1', type: 'inbox' as const, position: { x: 5, y: 5 }, data: {} }], edges: [] };
    expect(await store.update(id, tenantId, { graph: g2 })).toBe(true);
    expect((await store.getById(id, tenantId))!.graph).toEqual(g2);

    // scope tenant : un autre tenant ne peut ni voir ni supprimer.
    expect(await store.getById(id, '00000000-0000-0000-0000-000000000000')).toBeNull();
    expect(await store.remove(id, '00000000-0000-0000-0000-000000000000')).toBe(false);
    expect(await store.remove(id, tenantId)).toBe(true);
    expect(await store.getById(id, tenantId)).toBeNull();
  });

  it('PgQualityProvider : UNKNOWN si numéro absent, lit le rating sinon', async () => {
    const quality = new PgQualityProvider(pool);
    expect(await quality.getRating('pn-absent')).toBe('UNKNOWN');

    await pool.query(`insert into waba (id, tenant_id, name) values ($1, $2, 'w')`, ['waba-itest', tenantId]);
    await pool.query(
      `insert into phone_numbers (id, waba_id, tenant_id, quality_rating) values ($1, 'waba-itest', $2, 'RED')`,
      ['pn-red', tenantId],
    );
    expect(await quality.getRating('pn-red')).toBe('RED');
  });

  it('reclaimStale : un `sending` trop vieux est ramené à `pending`', async () => {
    const repo = new PgCampaignRepo(pool);
    const recipients = new PgRecipientStore(pool);
    const contactId = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164, opt_in_status) values ($1, $2, 'opted_in') returning id`,
      [tenantId, '+33600000004'],
    )).rows[0]!.id;
    const { campaignId } = await repo.createWithRecipients(
      { tenantId, phoneNumberId: 'pn', name: 'Sweep', category: 'marketing', templateName: 't', templateLanguage: 'fr', paramMapping: [] },
      [{ contactId, toE164: '+33600000004', resolvedParams: [] }],
    );
    const rid = (await recipients.listPending(campaignId))[0]!.id;
    expect(await recipients.claim(rid)).toBe(true); // pending -> sending (claimed_at=now)
    expect(await recipients.reclaimStale(60_000)).toBe(0); // pas vieux de 60s
    // Vieillir CE claim d'1h, puis récupérer (n'affecte pas les sending récents d'ailleurs).
    await pool.query(`update campaign_recipients set claimed_at = now() - interval '1 hour' where id = $1`, [rid]);
    expect(await recipients.reclaimStale(60_000)).toBeGreaterThanOrEqual(1);
    expect(await recipients.listPending(campaignId)).toHaveLength(1); // de retour pending
  });

  it('createWithRecipients : rollback si un destinataire échoue (pas de campagne orpheline)', async () => {
    const repo = new PgCampaignRepo(pool);
    const before = (await repo.listCampaignSummaries(tenantId)).length;
    await expect(
      repo.createWithRecipients(
        { tenantId, phoneNumberId: 'pn', name: 'RollbackTest', category: 'marketing', templateName: 't', templateLanguage: 'fr', paramMapping: [] },
        [{ contactId: '00000000-0000-0000-0000-000000000000', toE164: '+33600000005', resolvedParams: [] }], // FK contact inexistant
      ),
    ).rejects.toThrow();
    expect((await repo.listCampaignSummaries(tenantId)).length).toBe(before); // aucune campagne persistée
  });
});
