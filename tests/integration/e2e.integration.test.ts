import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { parseCsv } from '../../src/crm/csv';
import { mappingFromHeaders } from '../../src/http/import';
import { importContacts } from '../../src/crm/import';
import { PgContactStore } from '../../src/crm/contact-store.pg';
import { PgUserFieldStore } from '../../src/crm/field-store.pg';
import { createCampaignWithRecipients } from '../../src/campaign/create';
import { campaignRunJob } from '../../src/campaign/run-job';
import {
  PgCampaignRepo,
  PgCampaignStore,
  PgRecipientStore,
  PgFrequencyStore,
  PgQualityProvider,
} from '../../src/campaign/store.pg';
import type { MessageSender } from '../../src/campaign/engine';
import type { GuardrailThresholds } from '../../src/campaign/types';
import type { SendResult, MarketingParams, TemplateSpec } from '../../src/meta/types';

const url = process.env.DATABASE_URL ?? '';

class FakeSender implements MessageSender {
  async sendMarketing(p: MarketingParams): Promise<SendResult> {
    return { messageId: `m-${p.to ?? p.recipient ?? ''}` };
  }
  async sendTemplate(to: string, _tpl: TemplateSpec): Promise<SendResult> {
    return { messageId: `m-${to}` };
  }
}

const CSV = 'Nom,Téléphone,Ville\nJulie,+33600000010,Lyon\nMarc,+33600000011,Paris';

describe.skipIf(!url)('E2E CSV -> campagne -> envoi (Supabase, sender fake)', () => {
  let pool: Pool;
  let tenantId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-e2e') returning id`)).rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  it('importe le CSV, crée la campagne, exécute le run, puis est idempotent au re-run', async () => {
    // 1) Import CSV -> contacts en base.
    const parsed = parseCsv(CSV);
    const report = await importContacts(
      { rows: parsed.rows, mapping: mappingFromHeaders(parsed.headers), tenantId, optIn: true },
      { contacts: new PgContactStore(pool), userFields: new PgUserFieldStore(pool), defaultCountry: 'FR' },
    );
    expect(report.created).toBe(2);

    // 2) Création campagne + construction des destinataires.
    const repo = new PgCampaignRepo(pool);
    const { campaignId, recipientCount } = await createCampaignWithRecipients(
      {
        tenantId, phoneNumberId: 'pn-e2e', name: 'Promo', category: 'marketing',
        templateName: 'promo', templateLanguage: 'fr',
        paramMapping: [{ position: 1, source: { type: 'attribute', key: 'name' } }],
      },
      repo,
    );
    expect(recipientCount).toBe(2); // 2 contacts opt-in

    // 3) Run avec sender fake.
    const runDeps = {
      getCampaign: (id: string) => repo.getCampaign(id),
      senderFor: () => new FakeSender(),
      recipients: new PgRecipientStore(pool),
      campaigns: new PgCampaignStore(pool),
      frequency: new PgFrequencyStore(pool),
      quality: new PgQualityProvider(pool),
    };
    const run1 = await campaignRunJob({ campaignId }, runDeps);
    expect(run1).toMatchObject({ sent: 2, failed: 0, skipped: 0, paused: false });

    // 4) Vérif base : tous sent avec message_id + sent_at.
    const rows = (await pool.query<{ status: string; message_id: string | null; sent_at: Date | null }>(
      `select status, message_id, sent_at from campaign_recipients where campaign_id = $1`, [campaignId],
    )).rows;
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.status).toBe('sent');
      expect(r.message_id).toMatch(/^m-\+336/);
      expect(r.sent_at).not.toBeNull();
    }

    // 5) Re-run idempotent : plus aucun pending -> 0 envoi.
    const run2 = await campaignRunJob({ campaignId }, runDeps);
    expect(run2).toMatchObject({ sent: 0, skipped: 0, failed: 0 });
  });

  it('fréquence : un 2e envoi marketing au même numéro dans la fenêtre est skippé (vrai PgFrequencyStore)', async () => {
    // Tenant dédié (isolé du 1er test qui a déjà des contacts) : 1 seul contact ici.
    const t2 = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-freq') returning id`)).rows[0]!.id;
    try {
      await importContacts(
        { rows: [{ Tel: '+33600000020', Nom: 'Freq' }], mapping: { columns: { Tel: { target: 'phone' }, Nom: { target: 'name' } } }, tenantId: t2, optIn: true },
        { contacts: new PgContactStore(pool), userFields: new PgUserFieldStore(pool), defaultCountry: 'FR' },
      );
      const repo = new PgCampaignRepo(pool);
      const runDeps = {
        getCampaign: (id: string) => repo.getCampaign(id),
        senderFor: () => new FakeSender(),
        recipients: new PgRecipientStore(pool),
        campaigns: new PgCampaignStore(pool),
        frequency: new PgFrequencyStore(pool),
        quality: new PgQualityProvider(pool),
      };
      const base = { tenantId: t2, phoneNumberId: 'pn-freq', category: 'marketing' as const, templateName: 't', templateLanguage: 'fr', paramMapping: [] };
      const window: GuardrailThresholds = { frequencyWindowMs: 24 * 3600 * 1000, maxFailureRate: 0.3, minSendsForFailureCheck: 20 };

      // Campagne 1 -> envoyé (sent_at récent en base).
      const c1 = await createCampaignWithRecipients({ ...base, name: 'Freq-1' }, repo);
      const r1 = await campaignRunJob({ campaignId: c1.campaignId }, { ...runDeps, thresholds: window });
      expect(r1.sent).toBe(1);

      // Campagne 2, même numéro, fenêtre 24h -> skippé par PgFrequencyStore.lastSentAt (JOIN réel).
      const c2 = await createCampaignWithRecipients({ ...base, name: 'Freq-2' }, repo);
      const r2 = await campaignRunJob({ campaignId: c2.campaignId }, { ...runDeps, thresholds: window });
      expect(r2).toMatchObject({ sent: 0, skipped: 1 });
    } finally {
      await pool.query('delete from tenants where id = $1', [t2]);
    }
  });
});
