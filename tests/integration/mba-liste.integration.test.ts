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

  it('🔴 `moinsActive` : la conversation la moins récemment active du numéro, dans cet espace seulement', async () => {
    // Un espace à lui : les cas précédents ont posé des lignes sur `tenant`.
    const rot = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-mba-liste-rotation') returning id`)).rows[0]!.id;
    try {
      const poser = (t: string, wa: string, pn: string, il_y_a: string) => pool.query(
        `insert into mba_liste (tenant_id, wa_id, phone_number_id, entree_id, ajoute_le) values ($1, $2, $3, $4, now() - $5::interval)`,
        [t, wa, pn, `e-${wa}`, il_y_a],
      );
      const conversation = (wa: string, il_y_a: string, t = rot) => pool.query(
        `insert into conversations (tenant_id, wa_id, last_message_at) values ($1, $2, now() - $3::interval)`, [t, wa, il_y_a],
      );
      // A : entré le premier, mais il parle en ce moment. B : entré il y a 2 h, son dernier message est plus ancien
      // encore, donc son activité est son entrée. C : entré il y a 1 h, sans conversation.
      await poser(rot, '33610000001', 'pn', '3 hours');
      await conversation('33610000001', '0 seconds');
      await poser(rot, '33610000002', 'pn', '2 hours');
      await conversation('33610000002', '5 hours');
      await poser(rot, '33610000003', 'pn', '1 hour');
      // D : entré à l'instant (« Rendre la main »), dernier message il y a 9 h. Sans `greatest`, c'est lui qui sortirait.
      await poser(rot, '33610000006', 'pn', '5 minutes');
      await conversation('33610000006', '9 hours');
      // Le numéro de B parle à l'instant dans UN AUTRE espace : sans le prédicat d'espace de la jointure, B serait
      // compté deux fois.
      await conversation('33610000002', '0 seconds', autre);
      // Plus anciens, mais sur un autre numéro, ou dans un autre espace : ni comptés, ni choisis.
      await poser(rot, '33610000004', 'pn-autre', '10 hours');
      await poser(autre, '33610000005', 'pn', '10 hours');

      expect(await store.moinsActive(rot, 'pn')).toEqual({ waId: '33610000002', taille: 4 });
      expect(await store.moinsActive(rot, 'pn-autre')).toEqual({ waId: '33610000004', taille: 1 });
      expect(await store.moinsActive(rot, 'pn-vide')).toBeNull();
    } finally {
      await pool.query('delete from tenants where id = $1', [rot]);
    }
  });

  it('🔴 la table suit l’espace en cascade', async () => {
    const jetable = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-mba-liste-cascade') returning id`)).rows[0]!.id;
    await store.poser(jetable, '33600000005', 'pn', 'e5');
    await pool.query('delete from tenants where id = $1', [jetable]);
    const r = await pool.query('select 1 from mba_liste where tenant_id = $1', [jetable]);
    expect(r.rowCount).toBe(0);
  });
});
