// tests/integration/refus-effaces.integration.test.ts
import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgContactStore } from '../../src/crm/contact-store.pg';
import { empreinteRefus } from '../../src/crm/refus-effaces';

/**
 * 🔴 LA LISTE DE REFUS DES FICHES EFFACÉES, CONTRE UNE VRAIE BASE (`src/crm/refus-effaces.ts`, migration 0226). Une
 * fiche effacée en STOP laisse l'empreinte de ses identifiants ; recréée par n'importe lequel des quatre chemins, elle
 * naît en STOP à la date d'origine et l'entrée est consommée. Ce qui ne doit PAS arriver est tenu aussi : une fiche
 * vivante réabonnée n'est jamais désabonnée par la liste, un espace ne touche pas l'autre, et seule la case cochée d'un
 * import lève le STOP, comme sur une fiche vivante. Joué par le job `integration`, jamais en local (le DATABASE_URL
 * local pointe la PRODUCTION).
 */
const url = process.env.DATABASE_URL ?? '';

describe.skipIf(!url)('la liste de refus des fiches effacées (Postgres)', () => {
  let pool: Pool;
  let store: PgContactStore;
  let tenantId = '';
  let autreTenantId = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    store = new PgContactStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-refus-effaces') returning id`)).rows[0]!.id;
    autreTenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-refus-voisin') returning id`)).rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    if (autreTenantId) await pool.query('delete from tenants where id = $1', [autreTenantId]);
    await pool.end();
  });

  /** Une fiche qui dit STOP (la personne, son mot), puis qu'on efface. Rend la date de son STOP. */
  async function stopPuisEfface(t: string, phone: string, rcs?: Date): Promise<Date> {
    const { id } = await store.upsertByPhoneReturningId({ tenantId: t, phoneE164: phone, profileName: 'X', fields: {}, optInStatus: 'opted_in' });
    await store.setOptInByWaId(t, phone.slice(1), 'opted_out', 'personne', 'stop');
    if (rcs) await pool.query('update contacts set rcs_optout_at = $2 where id = $1', [id, rcs]);
    const d = (await pool.query<{ opt_out_at: Date }>('select opt_out_at from contacts where id = $1', [id])).rows[0]!.opt_out_at;
    await store.purgeMany(t, [id]);
    return d;
  }

  async function ficheDe(t: string, cle: { phone?: string; bsuid?: string }) {
    const r = await pool.query<{ opt_in_status: string; opt_out_at: Date | null; opt_in_source: string | null; rcs_optout_at: Date | null }>(
      `select opt_in_status, opt_out_at, opt_in_source, rcs_optout_at from contacts
        where tenant_id = $1 and deleted_at is null and (phone_e164 = $2 or bsuid = $3)`,
      [t, cle.phone ?? null, cle.bsuid ?? null],
    );
    expect(r.rows).toHaveLength(1);
    return r.rows[0]!;
  }

  const entrees = async (t: string): Promise<number> =>
    (await pool.query<{ n: number }>('select count(*)::int as n from refus_effaces where tenant_id = $1', [t])).rows[0]!.n;

  it('la purge d’une fiche en STOP laisse une empreinte, jamais le numéro ; une fiche sans STOP n’en laisse aucune', async () => {
    const avant = await entrees(tenantId);
    const d = await stopPuisEfface(tenantId, '+33600001001');
    const r = await pool.query<{ empreinte: string; whatsapp_le: Date; rcs_le: Date | null }>(
      'select empreinte, whatsapp_le, rcs_le from refus_effaces where tenant_id = $1 and empreinte = $2',
      [tenantId, empreinteRefus(tenantId, { tel: '+33600001001' })],
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.whatsapp_le.toISOString()).toBe(d.toISOString());
    expect(r.rows[0]!.rcs_le).toBeNull();
    expect(r.rows[0]!.empreinte).not.toContain('600001001');

    const { id } = await store.upsertByPhoneReturningId({ tenantId, phoneE164: '+33600001002', profileName: null, fields: {}, optInStatus: 'opted_in' });
    await store.purgeMany(tenantId, [id]);
    expect(await entrees(tenantId)).toBe(avant + 1);
  });

  it('🔴 recréée par le webhook entrant ou la saisie : elle naît en STOP, à la date d’origine, et l’entrée est consommée', async () => {
    const d = await stopPuisEfface(tenantId, '+33600001011');
    const r = await store.upsertByPhoneReturningId({ tenantId, phoneE164: '+33600001011', profileName: 'Revenue', fields: {}, optInStatus: 'opted_in' });
    expect(r.created).toBe(true);
    const f = await ficheDe(tenantId, { phone: '+33600001011' });
    expect([f.opt_in_status, f.opt_in_source, f.opt_out_at?.toISOString()]).toEqual(['opted_out', 'liste_de_refus', d.toISOString()]);
    expect((await pool.query('select 1 from refus_effaces where tenant_id = $1 and empreinte = $2',
      [tenantId, empreinteRefus(tenantId, { tel: '+33600001011' })])).rowCount).toBe(0);

    // Effacée une seconde fois, toujours en STOP : l'entrée revient avec la MÊME date.
    const { id } = await store.upsertByPhoneReturningId({ tenantId, phoneE164: '+33600001011', profileName: null, fields: {}, optInStatus: 'opted_in' });
    await store.purgeMany(tenantId, [id]);
    const e = await pool.query<{ whatsapp_le: Date }>('select whatsapp_le from refus_effaces where tenant_id = $1 and empreinte = $2',
      [tenantId, empreinteRefus(tenantId, { tel: '+33600001011' })]);
    expect(e.rows[0]?.whatsapp_le.toISOString()).toBe(d.toISOString());
  });

  it('🔴 par un import sans la case : naît en STOP ; avec la case cochée : réabonnée, comme une fiche vivante', async () => {
    await stopPuisEfface(tenantId, '+33600001021');
    await stopPuisEfface(tenantId, '+33600001022');
    await store.upsertManyByPhone({ tenantId, optInStatus: 'opted_in', autorite: 'import', contacts: [{ phoneE164: '+33600001021', profileName: null, fields: {} }] });
    await store.upsertManyByPhone({ tenantId, optInStatus: 'opted_in', optInSource: 'csv_import', autorite: 'import_csv_coche', contacts: [{ phoneE164: '+33600001022', profileName: null, fields: {} }] });
    expect((await ficheDe(tenantId, { phone: '+33600001021' })).opt_in_status).toBe('opted_out');
    const coche = await ficheDe(tenantId, { phone: '+33600001022' });
    expect([coche.opt_in_status, coche.opt_out_at, coche.opt_in_source]).toEqual(['opted_in', null, 'csv_import']);
    // Les deux entrées sont consommées : la fiche porte désormais la vérité.
    expect((await pool.query('select 1 from refus_effaces where tenant_id = $1 and empreinte = any($2::text[])',
      [tenantId, ['+33600001021', '+33600001022'].map((tel) => empreinteRefus(tenantId, { tel }))])).rowCount).toBe(0);
  });

  it('🔴 par un message entrant, au numéro comme au BSUID : écrire ne lève pas un STOP', async () => {
    const d = await stopPuisEfface(tenantId, '+33600001031');
    expect(await store.upsertFromInbound(tenantId, '33600001031', 'Revient')).toBe('created');
    const f = await ficheDe(tenantId, { phone: '+33600001031' });
    expect([f.opt_in_status, f.opt_in_source, f.opt_out_at?.toISOString()]).toEqual(['opted_out', 'liste_de_refus', d.toISOString()]);

    const bsuid = 'itest-bsuid-refus-1032';
    expect(await store.upsertFromInbound(tenantId, bsuid, 'Sans numéro')).toBe('created');
    await store.setOptInByWaId(tenantId, bsuid, 'opted_out', 'personne', 'stop');
    const id = (await pool.query<{ id: string }>('select id from contacts where tenant_id = $1 and bsuid = $2', [tenantId, bsuid])).rows[0]!.id;
    await store.purgeMany(tenantId, [id]);
    expect(await store.upsertFromInbound(tenantId, bsuid, 'Sans numéro')).toBe('created');
    expect((await ficheDe(tenantId, { bsuid })).opt_in_status).toBe('opted_out');
  });

  it('🔴 par l’API (creerFicheApi) : naît en STOP', async () => {
    await stopPuisEfface(tenantId, '+33600001041');
    const c = await store.creerFicheApi(tenantId, { phoneE164: '+33600001041', externalId: 'itest-ext-refus-1041' });
    expect(c).not.toBe('conflit');
    expect((await ficheDe(tenantId, { phone: '+33600001041' })).opt_in_status).toBe('opted_out');
  });

  it('le STOP RCS revient aussi, et seul : une fiche sans STOP WhatsApp naît comme demandé', async () => {
    const rcs = new Date('2026-05-01T08:00:00.000Z');
    const { id } = await store.upsertByPhoneReturningId({ tenantId, phoneE164: '+33600001051', profileName: null, fields: {}, optInStatus: 'opted_in' });
    await pool.query('update contacts set rcs_optout_at = $2 where id = $1', [id, rcs]);
    await store.purgeMany(tenantId, [id]);
    await store.upsertByPhoneReturningId({ tenantId, phoneE164: '+33600001051', profileName: null, fields: {}, optInStatus: 'opted_in' });
    const f = await ficheDe(tenantId, { phone: '+33600001051' });
    expect([f.opt_in_status, f.rcs_optout_at?.toISOString()]).toEqual(['opted_in', rcs.toISOString()]);
  });

  it('🔴 une fiche vivante n’est jamais désabonnée par la liste, et ne consomme pas une entrée qui l’attend', async () => {
    // Une entrée pour le numéro d'une fiche VIVANTE réabonnée (un numéro rattaché après coup peut y mener).
    const { id } = await store.upsertByPhoneReturningId({ tenantId, phoneE164: '+33600001061', profileName: null, fields: {}, optInStatus: 'opted_in' });
    const empreinte = empreinteRefus(tenantId, { tel: '+33600001061' });
    await pool.query(`insert into refus_effaces (tenant_id, empreinte, whatsapp_le) values ($1, $2, now() - interval '1 day')`, [tenantId, empreinte]);
    await store.upsertByPhoneReturningId({ tenantId, phoneE164: '+33600001061', profileName: 'Mise à jour', fields: {}, optInStatus: 'opted_in' });
    await store.upsertManyByPhone({ tenantId, optInStatus: 'opted_in', autorite: 'import', contacts: [{ phoneE164: '+33600001061', profileName: null, fields: {} }] });
    await store.upsertFromInbound(tenantId, '33600001061', 'Écrit');
    expect(await store.creerFicheApi(tenantId, { phoneE164: '+33600001061' })).not.toBe('conflit');
    const f = await ficheDe(tenantId, { phone: '+33600001061' });
    expect(f.opt_in_status).toBe('opted_in');
    expect((await pool.query('select 1 from refus_effaces where tenant_id = $1 and empreinte = $2', [tenantId, empreinte])).rowCount).toBe(1);
    await pool.query('delete from refus_effaces where tenant_id = $1 and empreinte = $2', [tenantId, empreinte]);
    expect(id).toBeTruthy();
  });

  it('🔴 un espace ne touche pas l’autre : le même numéro naît libre ailleurs, et l’entrée reste', async () => {
    await stopPuisEfface(tenantId, '+33600001071');
    await store.upsertByPhoneReturningId({ tenantId: autreTenantId, phoneE164: '+33600001071', profileName: null, fields: {}, optInStatus: 'opted_in' });
    expect((await ficheDe(autreTenantId, { phone: '+33600001071' })).opt_in_status).toBe('opted_in');
    expect((await pool.query('select 1 from refus_effaces where tenant_id = $1 and empreinte = $2',
      [tenantId, empreinteRefus(tenantId, { tel: '+33600001071' })])).rowCount).toBe(1);
  });

  it('la rétention : trois ans depuis le STOP le plus récent de l’entrée', async () => {
    const e = (n: number) => empreinteRefus(tenantId, { tel: `+3360000109${n}` });
    await pool.query(
      `insert into refus_effaces (tenant_id, empreinte, whatsapp_le, rcs_le) values
         ($1, $2, now() - interval '4 years', null),
         ($1, $3, now() - interval '2 years', null),
         ($1, $4, now() - interval '4 years', now() - interval '1 year')`,
      [tenantId, e(1), e(2), e(3)],
    );
    await store.purgerRefusEffaces(3);
    const restent = await pool.query<{ empreinte: string }>('select empreinte from refus_effaces where tenant_id = $1 and empreinte = any($2::text[])',
      [tenantId, [e(1), e(2), e(3)]]);
    expect(restent.rows.map((r) => r.empreinte).sort()).toEqual([e(2), e(3)].sort());
  });
});
