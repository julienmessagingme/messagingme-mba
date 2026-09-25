import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgCampaignRepo, PgRecipientStore } from '../../src/campaign/store.pg';

const url = process.env.DATABASE_URL ?? '';

/**
 * LES VARIABLES D'UN DESTINATAIRE EN BASE (migration 0174). En intégration parce que tout ce qui compte est du
 * SQL : l'écriture par `unnest`, la relecture du jsonb par `listPending`, et le renvoi F7 qui re-résout le
 * template. Jamais joué en local (le DATABASE_URL local pointe la PRODUCTION), joué par le job `integration`.
 */
describe.skipIf(!url)('variables de destinataire (Postgres)', () => {
  let pool: Pool;
  let tenantId = '';
  let c1 = '';
  let c2 = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 3 });
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-variables-destinataire') returning id`)).rows[0]!.id;
    c1 = (await pool.query<{ id: string }>(`insert into contacts (tenant_id, phone_e164, opt_in_status) values ($1, '+33600000401', 'opted_in') returning id`, [tenantId])).rows[0]!.id;
    c2 = (await pool.query<{ id: string }>(`insert into contacts (tenant_id, phone_e164, opt_in_status) values ($1, '+33600000402', 'opted_in') returning id`, [tenantId])).rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]).catch(() => {});
    await pool.end().catch(() => {});
  });

  const creer = async (): Promise<string> => (await new PgCampaignRepo(pool).createWithRecipients({
    tenantId, phoneNumberId: '', name: 'itest-variables', category: 'utility',
    templateName: 'confirmation', templateLanguage: 'fr',
    paramMapping: [{ position: 1, source: { type: 'variable', key: 'commande' } }],
  }, [
    { contactId: c1, toE164: '+33600000401', resolvedParams: ['8412'], variables: { commande: '8412' } },
    { contactId: c2, toE164: '+33600000402', resolvedParams: [''] },
  ])).campaignId;

  it('🔴 écrites à la construction, relues par le run : un objet pour l’un, null pour l’autre', async () => {
    const campaignId = await creer();
    const pending = await new PgRecipientStore(pool).listPending(campaignId);
    const parContact = new Map(pending.map((r) => [r.contactId, r.variables]));
    expect(parContact.get(c1)).toEqual({ commande: '8412' });
    expect(parContact.get(c2)).toBeNull();
  });

  it('🔴 le renvoi F7 re-résout le template SUR les variables du destinataire', async () => {
    const campaignId = await creer();
    const r = (await pool.query<{ id: string }>(
      `update campaign_recipients set status = 'failed', error_code = 131009, resolved_params = '[""]'::jsonb
        where campaign_id = $1 and contact_id = $2 returning id`, [campaignId, c1])).rows[0]!;
    const reset = await new PgCampaignRepo(pool).resetRecipientForRetry(tenantId, campaignId, r.id);
    expect(reset).toEqual({ result: 'queued', campaignId });
    const apres = (await pool.query<{ resolved_params: string[] }>('select resolved_params from campaign_recipients where id = $1', [r.id])).rows[0]!;
    expect(apres.resolved_params).toEqual(['8412']);
  });
});
