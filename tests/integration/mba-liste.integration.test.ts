import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgListeStore } from '../../src/mba/liste.pg';

// Ne PAS lancer ce fichier en local : le DATABASE_URL du .env local pointe sur la base de PRODUCTION (cf.
// CLAUDE.md du dépôt), et ce fichier crée puis supprime des espaces. La CI monte un Postgres jetable pour ça.
const url = process.env.DATABASE_URL ?? '';

/**
 * LA LISTE DE L'AGENT DE META (migration 0195) contre un vrai Postgres.
 *
 * 🔴 CE QUE SEULE UNE BASE PEUT PROUVER : que la clé primaire `(tenant_id, wa_id)` refuse un doublon (et que `poser`,
 * qui doit rester idempotent, ne lève pas dessus), que la table suit l'espace en cascade, que `presents` lit
 * plusieurs numéros en une requête, et que chaque lecture reste dans son espace. La logique des gestes, elle, est
 * éprouvée sans base (`tests/mba-liste.test.ts`).
 */
describe.skipIf(!url)('mba_liste (Postgres réel)', () => {
  let pool: Pool;
  let store: PgListeStore;
  let tenant = '';
  let autre = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    store = new PgListeStore(pool);
    const t = async (nom: string) => (await pool.query<{ id: string }>(`insert into tenants (name) values ($1) returning id`, [nom])).rows[0]!.id;
    tenant = await t('itest-mba-liste');
    autre = await t('itest-mba-liste-autre');
  });

  afterAll(async () => {
    for (const id of [tenant, autre]) if (id) await pool.query('delete from tenants where id = $1', [id]).catch(() => {});
    await pool.end().catch(() => {});
  });

  it('🔴 la clé primaire est (tenant_id, wa_id), et c’est le SEUL index de la table', async () => {
    const pk = await pool.query<{ def: string }>(
      `select pg_get_constraintdef(c.oid) as def from pg_constraint c
        where c.conrelid = 'public.mba_liste'::regclass and c.contype = 'p'`,
    );
    expect(pk.rows.map((r) => r.def)).toEqual(['PRIMARY KEY (tenant_id, wa_id)']);
    const index = await pool.query<{ indexname: string }>(`select indexname from pg_indexes where schemaname = 'public' and tablename = 'mba_liste'`);
    expect(index.rows).toHaveLength(1);
    await pool.query(`insert into mba_liste (tenant_id, wa_id, phone_number_id, entree_id) values ($1, '33600000001', 'pn', 'e1')`, [tenant]);
    await expect(pool.query(
      `insert into mba_liste (tenant_id, wa_id, phone_number_id, entree_id) values ($1, '33600000001', 'pn', 'e2')`, [tenant],
    )).rejects.toThrow(/duplicate key|unique/);
  });

  it('🔴 `poser` est idempotent : un second ajout du même contact met l’entrée à jour, sans lever', async () => {
    await store.poser(tenant, '33600000002', 'pn', 'e-a');
    await store.poser(tenant, '33600000002', 'pn2', 'e-b');
    expect(await store.trouver(tenant, '33600000002')).toEqual({ phoneNumberId: 'pn2', entreeId: 'e-b' });
  });

  it('🔴 `presents` lit plusieurs numéros en une requête, et seulement dans l’espace demandé', async () => {
    await store.poser(tenant, '33600000003', 'pn', 'e3');
    await store.poser(autre, '33600000004', 'pn', 'e4');
    const vus = await store.presents(tenant, ['33600000001', '33600000003', '33600000004', '33600000099']);
    expect([...vus].sort()).toEqual(['33600000001', '33600000003']);
    expect(await store.trouver(tenant, '33600000004')).toBeNull();
    expect(await store.presents(tenant, [])).toEqual(new Set());
  });

  it('`supprimer` retire la ligne de cet espace seulement', async () => {
    await store.poser(autre, '33600000003', 'pn', 'e-autre');
    await store.supprimer(tenant, '33600000003');
    expect(await store.trouver(tenant, '33600000003')).toBeNull();
    expect(await store.trouver(autre, '33600000003')).toEqual({ phoneNumberId: 'pn', entreeId: 'e-autre' });
  });

  it('🔴 la table suit l’espace en cascade', async () => {
    const jetable = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-mba-liste-cascade') returning id`)).rows[0]!.id;
    await store.poser(jetable, '33600000005', 'pn', 'e5');
    await pool.query('delete from tenants where id = $1', [jetable]);
    const r = await pool.query('select 1 from mba_liste where tenant_id = $1', [jetable]);
    expect(r.rowCount).toBe(0);
  });
});
