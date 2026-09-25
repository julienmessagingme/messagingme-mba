import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgNumeroDelieStore } from '../../src/account/numero-delie.pg';
import { PgPhoneStatusStore } from '../../src/account/store.pg';
import { PgCampaignRepo } from '../../src/campaign/store.pg';
import { PgChannelsMeConnectionStore } from '../../src/channels-me/connection-store.pg';

// Ne PAS lancer ce fichier en local : le DATABASE_URL du .env local pointe sur la base de PRODUCTION (cf.
// CLAUDE.md du dépôt), et ce fichier crée puis supprime des espaces. La CI monte un Postgres jetable pour ça.
const url = process.env.DATABASE_URL ?? '';

/**
 * DÉLIER ET RELIER LE NUMÉRO (migration 0180) contre un vrai Postgres.
 *
 * 🔴 CE QUE SEULE UNE BASE PEUT PROUVER : que le CHECK élargi accepte `numero_delie` (sinon la pause échoue à
 * l'écriture), que la clause `tenant_id` isole deux espaces, que la pause ne touche QUE les campagnes WhatsApp
 * vivantes (repli compris), que le balayage de reprise ne la voit JAMAIS, et que « Relier » rend chaque campagne
 * à l'état que le balayage des campagnes gelées sait relancer.
 */
describe.skipIf(!url)('Numéro délié (Postgres réel)', () => {
  let pool: Pool;
  let store: PgNumeroDelieStore;
  let repo: PgCampaignRepo;
  let tenant: string;
  let autre: string;
  let sansNumero: string;
  let contactId: string;
  const suffixe = randomUUID().slice(0, 8);
  const PN = `itest-delie-pn-${suffixe}`;
  const PN_AUTRE = `itest-delie-pn2-${suffixe}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    store = new PgNumeroDelieStore(pool);
    repo = new PgCampaignRepo(pool);
    const t = async (nom: string) => (await pool.query<{ id: string }>(`insert into tenants (name) values ($1) returning id`, [nom])).rows[0]!.id;
    tenant = await t('itest-delie');
    autre = await t('itest-delie-autre');
    sansNumero = await t('itest-delie-sans-numero');
    for (const [id, waba, espace] of [[PN, `itest-delie-waba-${suffixe}`, tenant], [PN_AUTRE, `itest-delie-waba2-${suffixe}`, autre]] as const) {
      await pool.query(`insert into waba (id, tenant_id, name) values ($1, $2, 'itest')`, [waba, espace]);
      await pool.query(
        `insert into phone_numbers (id, tenant_id, waba_id, display_phone_number, status) values ($1, $2, $3, '+33500000077', 'CONNECTED')`,
        [id, espace, waba],
      );
    }
    contactId = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164) values ($1, '+33600000077') returning id`, [tenant],
    )).rows[0]!.id;
  });

  afterAll(async () => {
    for (const id of [tenant, autre, sansNumero]) if (id) await pool.query('delete from tenants where id = $1', [id]).catch(() => {});
    await pool.end().catch(() => {});
  });

  async function campagne(espace: string, o: { status: string; channel?: string; pn?: string | null; scheduledAt?: string; pauseReason?: string }): Promise<string> {
    return (await pool.query<{ id: string }>(
      `insert into campaigns (tenant_id, phone_number_id, name, category, template_name, template_language, status,
                              param_mapping, channel, scheduled_at, pause_reason)
       values ($1, $2, 'itest-delie', 'marketing', 'tpl', 'fr', $3, '[]'::jsonb, $4, $5::timestamptz, $6) returning id`,
      [espace, o.pn === undefined ? (espace === tenant ? PN : PN_AUTRE) : o.pn, o.status, o.channel ?? 'whatsapp', o.scheduledAt ?? null, o.pauseReason ?? null],
    )).rows[0]!.id;
  }
  const etat = async (id: string) => (await pool.query<{ status: string; pause_reason: string | null; paused_until: Date | null; scheduled_at: Date | null }>(
    `select status, pause_reason, paused_until, scheduled_at from campaigns where id = $1`, [id],
  )).rows[0]!;

  it('🔴 le cycle complet : délier met en pause ce qui doit l’être, rien d’autre ; relier le rend au bon état', async () => {
    const enCours = await campagne(tenant, { status: 'running' });
    await pool.query(`insert into campaign_recipients (campaign_id, contact_id, to_e164) values ($1, $2, '+33600000077')`, [enCours, contactId]);
    const programmee = await campagne(tenant, { status: 'scheduled', scheduledAt: '2030-01-01T09:00:00Z' });
    const rcsSeule = await campagne(tenant, { status: 'running', channel: 'rcs', pn: null });
    const rcsAvecRepli = await campagne(tenant, { status: 'running', channel: 'rcs', pn: null });
    await pool.query(`insert into campaign_etages (campaign_id, rang, canal) values ($1, 1, 'rcs'), ($1, 2, 'whatsapp')`, [rcsAvecRepli]);
    const brouillon = await campagne(tenant, { status: 'draft' });
    const pauseQualite = await campagne(tenant, { status: 'paused', pauseReason: 'qualite' });
    const chezLAutre = await campagne(autre, { status: 'running' });

    const r = await store.delier(tenant);
    expect(r).not.toBeNull();
    expect(r!.campagnesEnPause).toBe(3);
    expect(await store.estDelie(PN)).toBe(true);
    expect(await store.estDelie(PN_AUTRE)).toBe(false);

    for (const id of [enCours, programmee, rcsAvecRepli]) {
      // `paused_until` NUL : c'est ce qui garde la pause hors du balayage de reprise.
      expect(await etat(id), id).toMatchObject({ status: 'paused', pause_reason: 'numero_delie', paused_until: null });
    }
    // La date de programmation est GARDÉE : c'est elle qui dira, à « Relier », qu'elle était programmée.
    expect((await etat(programmee)).scheduled_at?.toISOString()).toBe('2030-01-01T09:00:00.000Z');
    expect((await etat(rcsSeule)).status).toBe('running');
    expect((await etat(brouillon)).status).toBe('draft');
    expect(await etat(pauseQualite)).toMatchObject({ status: 'paused', pause_reason: 'qualite' });
    // 🔴 L'isolation entre espaces.
    expect((await etat(chezLAutre)).status).toBe('running');

    // 🔴 Tant que le numéro est délié, ni le balayage de reprise ni celui des campagnes gelées ne la touchent,
    // même avec une échéance échue posée à la main : c'est la RAISON qui protège, pas seulement la date nulle.
    await pool.query(`update campaigns set paused_until = now() - interval '1 minute' where id = $1`, [enCours]);
    expect((await repo.reprendreCampagnesDues()).map((c) => c.id)).not.toContain(enCours);
    expect((await repo.listCampagnesGelees()).map((c) => c.id)).not.toContain(enCours);
    expect((await etat(enCours)).status).toBe('paused');

    // Rejouable : la date du premier geste est gardée, et rien de plus n'est mis en pause.
    const second = await store.delier(tenant);
    expect(second!.delieLe).toBe(r!.delieLe);
    expect(second!.campagnesEnPause).toBe(0);

    const lu = await new PgPhoneStatusStore(pool).getPhoneNumber(tenant);
    expect(lu?.delieLe).toBe(r!.delieLe);

    const relie = await store.relier(tenant);
    expect(relie).toEqual({ campagnesReprises: 2, campagnesReprogrammees: 1 });
    expect(await store.estDelie(PN)).toBe(false);
    expect(await etat(enCours)).toMatchObject({ status: 'running', pause_reason: null, paused_until: null });
    expect(await etat(programmee)).toMatchObject({ status: 'scheduled', pause_reason: null });
    expect((await etat(programmee)).scheduled_at?.toISOString()).toBe('2030-01-01T09:00:00.000Z');
    expect((await etat(rcsAvecRepli)).status).toBe('running');
    // 🔴 La pause de qualité reste une décision humaine.
    expect(await etat(pauseQualite)).toMatchObject({ status: 'paused', pause_reason: 'qualite' });
    // Et « tout repart » : la campagne en cours est exactement ce que le balayage des campagnes gelées relance.
    expect((await repo.listCampagnesGelees()).map((c) => c.id)).toContain(enCours);
    await pool.query(`update campaigns set status = 'completed' where tenant_id = $1`, [tenant]);
  });

  it('un espace sans numéro : `null` des deux côtés, rien n’est écrit', async () => {
    expect(await store.delier(sansNumero)).toBeNull();
    expect(await store.relier(sansNumero)).toBeNull();
  });

  it('`numerosDelies` : une requête pour plusieurs clés, seules les déliées reviennent, une liste vide ne coûte rien', async () => {
    await store.delier(autre);
    expect([...await store.numerosDelies([PN, PN_AUTRE, 'inconnu'])]).toEqual([PN_AUTRE]);
    expect((await store.numerosDelies([])).size).toBe(0);
    await store.relier(autre);
    expect((await store.numerosDelies([PN_AUTRE])).size).toBe(0);
    await pool.query(`update campaigns set status = 'completed' where tenant_id = $1`, [autre]);
  });

  it('🔴 débrancher la chaîne oublie les identifiants de CET espace seulement', async () => {
    const cm = new PgChannelsMeConnectionStore(pool, 'c'.repeat(64));
    await cm.upsert(tenant, { orgId: 'o', channelId: 'c', apiKey: 'k', secret: 's' });
    await cm.upsert(autre, { orgId: 'o2', channelId: 'c2', apiKey: 'k2', secret: 's2' });
    expect(await cm.supprimer(tenant)).toBe(true);
    expect(await cm.get(tenant)).toBeNull();
    expect(await cm.get(autre)).not.toBeNull();
    expect(await cm.supprimer(tenant)).toBe(false);
  });
});
