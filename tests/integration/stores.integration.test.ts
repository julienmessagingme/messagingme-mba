import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgContactStore } from '../../src/crm/contact-store.pg';
import { PgUserFieldStore } from '../../src/crm/field-store.pg';
import {
  PgCampaignRepo,
  PgCampaignStore,
  PgRecipientStore,
  PgFrequencyStore,
  PgQualityProvider,
} from '../../src/campaign/store.pg';

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
    expect(await recipients.updateDeliveryByMessageId('m-1', 'sent', null)).toBe(1);
    expect(await recipients.updateDeliveryByMessageId('m-1', 'read', null)).toBe(1);
    expect(await recipients.updateDeliveryByMessageId('m-1', 'delivered', null)).toBe(0); // read ne régresse pas
    const dstatus = (await pool.query<{ delivery_status: string }>(`select delivery_status from campaign_recipients where id = $1`, [rid])).rows[0]?.delivery_status;
    expect(dstatus).toBe('read');
    expect(await recipients.updateDeliveryByMessageId('m-inconnu', 'sent', null)).toBe(0); // wamid pas à nous
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
