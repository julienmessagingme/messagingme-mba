import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgStatsStore } from '../../src/stats/store.pg';
import { TYPE_ENTREE_GRATUITE } from '../../src/webhooks/tarif-meta';

// Ne PAS lancer ce fichier en local : le DATABASE_URL du .env local pointe sur la base de PRODUCTION.
const url = process.env.DATABASE_URL ?? '';
const RANGE = { from: '2026-09-01', to: '2026-09-07' };
const GRATUITS = ['wamid.cg-camp-gratuit', 'wamid.cg-tpl-gratuit', 'wamid.cg-svc-gratuit'];

/**
 * Les messages que Meta ne facture pas (72 h après un clic sur une pub) sortent des CINQ lectures de coût, dont
 * `envoisDeLaCampagne` (la fiche d'une campagne), qui doit compter la MÊME population que le tableau.
 *
 * 🔴 LE DERNIER CAS PORTE LES DEUX SENS DANS UN SEUL RUN. Les mêmes messages, requalifiés `regular`,
 * redeviennent comptés : c'est l'exclusion, et rien d'autre, qui fait le chiffre. Sans elle, les premiers cas
 * rendraient 4, 2, 2 et 2.
 */
describe.skipIf(!url)('Coût : les 72 h gratuites après un clic sur une pub (Postgres réel)', () => {
  let pool: Pool;
  let store: PgStatsStore;
  let tenantId = '';
  let campaignId = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    store = new PgStatsStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-cout-gratuit') returning id`)).rows[0]!.id;
    const contacts: string[] = [];
    for (const num of ['+33600000601', '+33600000602']) {
      contacts.push((await pool.query<{ id: string }>(
        `insert into contacts (tenant_id, phone_e164) values ($1, $2) returning id`, [tenantId, num],
      )).rows[0]!.id);
    }
    campaignId = (await pool.query<{ id: string }>(
      `insert into campaigns (tenant_id, name, category, template_name, channel)
       values ($1, 'itest-cout-gratuit', 'marketing', 'itest_tpl_gratuit', 'whatsapp') returning id`,
      [tenantId],
    )).rows[0]!.id;
    // Deux envois de campagne : l'un dans une fenêtre gratuite, l'autre SANS ligne de tarif (le cas d'avant).
    await pool.query(
      `insert into campaign_recipients (campaign_id, contact_id, to_e164, resolved_params, status, sent_at, message_id)
       values ($1, $2, '33600000601', '{}'::jsonb, 'sent', timestamptz '2026-09-05 08:00:00+00', 'wamid.cg-camp-gratuit'),
              ($1, $3, '33600000602', '{}'::jsonb, 'sent', timestamptz '2026-09-05 08:00:00+00', 'wamid.cg-camp-payant')`,
      [campaignId, contacts[0], contacts[1]],
    );
    // La conversation du premier contact : deux modèles et deux messages de service, un gratuit et un payant.
    const conv = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, contact_id, last_message_at, control_owner, is_test)
       values ($1, '33600000601', $2, now(), 'app_workflow', false) returning id`,
      [tenantId, contacts[0]],
    )).rows[0]!.id;
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, channel, template_name, template_category, created_at, meta_message_id) values
         ($1, 'out', 'template', 'whatsapp', 'itest_tpl_scn', 'utility', timestamptz '2026-09-05 09:00:00+00', 'wamid.cg-tpl-gratuit'),
         ($1, 'out', 'template', 'whatsapp', 'itest_tpl_scn', 'utility', timestamptz '2026-09-05 09:01:00+00', 'wamid.cg-tpl-payant'),
         ($1, 'out', 'text', 'whatsapp', null, null, timestamptz '2026-09-05 10:00:00+00', 'wamid.cg-svc-gratuit'),
         ($1, 'out', 'text', 'whatsapp', null, null, timestamptz '2026-09-05 10:01:00+00', 'wamid.cg-svc-payant')`,
      [conv],
    );
    // Ce que Meta a écrit dans ses accusés. `wamid.cg-camp-payant` n'a AUCUNE ligne : absence = payant.
    await pool.query(
      `insert into tarifs_meta (tenant_id, wamid, type) values
         ($1, 'wamid.cg-camp-gratuit', $2), ($1, 'wamid.cg-tpl-gratuit', $2), ($1, 'wamid.cg-svc-gratuit', $2),
         ($1, 'wamid.cg-tpl-payant', 'regular'), ($1, 'wamid.cg-svc-payant', 'regular')`,
      [tenantId, TYPE_ENTREE_GRATUITE],
    );
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  const total = (rows: Array<{ count: number }>) => rows.reduce((a, r) => a + r.count, 0);
  const dans = (rows: Array<{ dansLaPeriode: number }>) => rows.reduce((a, r) => a + r.dansLaPeriode, 0);

  it('🔴 les modèles gratuits sortent du coût, un modèle SANS tarif connu y reste', async () => {
    // `cg-camp-payant` (aucune ligne) et `cg-tpl-payant` ('regular') restent ; les deux gratuits sortent.
    expect(total(await store.getCostVolume(tenantId, RANGE, {}))).toBe(2);
  });

  it('le détail par modèle, le volume par campagne et la fiche de la campagne disent la MÊME chose', async () => {
    expect(total(await store.getTemplateBreakdown(tenantId, RANGE))).toBe(2);
    const parCampagne = (await store.getVolumeParCampagne(tenantId, RANGE)).filter((l) => l.campaignId === campaignId);
    expect(parCampagne.reduce((a, l) => a + l.count, 0)).toBe(1);
    // 🔴 La fiche s'ouvre depuis la ligne du tableau : deux populations y afficheraient deux coûts côte à côte.
    const fiche = await store.envoisDeLaCampagne(tenantId, campaignId);
    expect(fiche.reduce((a, l) => a + l.total, 0)).toBe(1);
  });

  it('🔴 les messages de service gratuits sortent aussi, du mois ET de la campagne', async () => {
    expect(dans(await store.serviceParMois(tenantId, RANGE))).toBe(1);
    expect((await store.servicesParCampagne(tenantId, [campaignId], RANGE)).get(campaignId)).toBe(1);
  });

  it('🔴 LES DEUX SENS : requalifiés « regular », les mêmes messages redeviennent comptés', async () => {
    await pool.query(`update tarifs_meta set type = 'regular' where tenant_id = $1 and wamid = any($2::text[])`, [tenantId, GRATUITS]);
    try {
      expect(total(await store.getCostVolume(tenantId, RANGE, {}))).toBe(4);
      expect((await store.envoisDeLaCampagne(tenantId, campaignId)).reduce((a, l) => a + l.total, 0)).toBe(2);
      expect(dans(await store.serviceParMois(tenantId, RANGE))).toBe(2);
      expect((await store.servicesParCampagne(tenantId, [campaignId], RANGE)).get(campaignId)).toBe(2);
    } finally {
      await pool.query(`update tarifs_meta set type = $3 where tenant_id = $1 and wamid = any($2::text[])`, [tenantId, GRATUITS, TYPE_ENTREE_GRATUITE]);
    }
  });
});
