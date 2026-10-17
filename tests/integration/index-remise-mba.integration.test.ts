import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { CONSOMMER_REMISE_MBA_SQL } from '../../src/inbox/store.pg';

// Ne PAS lancer ce fichier en local : le DATABASE_URL du .env local pointe sur la base de PRODUCTION
// (cf. CLAUDE.md du repo), et ce fichier cree/supprime des tenants. La CI monte un Postgres jetable pour ca.
const url = process.env.DATABASE_URL ?? '';

/**
 * 🔴 L'INDEX DE LA REMISE À L'AGENT DE META SERT VRAIMENT LA REQUÊTE DU CODE (migration 0242, banc du 2026-10-17).
 *
 * Un index partiel n'est choisi que si le planificateur prouve que la requête reste dans son prédicat ; sinon il est
 * payé à chaque écriture et jamais lu, en silence. Ce test planifie l'instruction EXPORTÉE par le magasin, pas une
 * copie : le jour où son `where` dérive, c'est ici que ça se voit.
 *
 * Comme `schema-indexes.integration.test.ts` : 2 000 conversations dans un espace dédié et `analyze`, parce que sur une
 * table vide tous les chemins coûtent zéro ; puis le parcours complet interdit le temps d'un `explain` (`set local`,
 * transaction annulée), pour voir ce que le planificateur ferait s'il avait le choix. C'est la question, pas la vitesse.
 */
describe.skipIf(!url)('index de la remise à l’agent de Meta (migration 0242)', () => {
  let pool: Pool;
  let tenantId = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 2 });
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-index-remise-mba') returning id`)).rows[0]!.id;
    await pool.query(
      `insert into conversations (tenant_id, wa_id, release_mba_apres_message)
       select $1, '3369' || lpad(i::text, 6, '0'), case when i % 400 = 0 then 'wamid.itest.remise.' || i end
         from generate_series(1, 2000) i`,
      [tenantId],
    );
    await pool.query('analyze conversations');
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  it('existe et est valide', async () => {
    const r = await pool.query<{ valide: boolean; def: string }>(
      `select i.indisvalid as valide, pg_get_indexdef(i.indexrelid) as def
         from pg_index i where i.indexrelid = 'conversations_release_mba_idx'::regclass`,
    );
    expect(r.rows[0]?.valide).toBe(true);
    expect(r.rows[0]?.def).toMatch(/WHERE \(release_mba_apres_message IS NOT NULL\)/);
  });

  it('🔴 l’instruction du code passe par lui, et plus par la table entière', async () => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local enable_seqscan = off');
      const p = await client.query<{ 'QUERY PLAN': Array<{ Plan: unknown }> }>(
        `explain (format json) ${CONSOMMER_REMISE_MBA_SQL}`, ['wamid.itest.remise.400'],
      );
      // Tous les noeuds du plan. On n'apparie PAS table et index : le noeud racine d'un update (ModifyTable) porte
      // lui aussi le nom de la table cible, sans index, et un Bitmap Heap Scan laisse le nom d'index a son fils.
      type Noeud = { 'Node Type'?: string; 'Relation Name'?: string; 'Index Name'?: string; Plans?: Noeud[] };
      const tous: Noeud[] = [];
      const parcourir = (n: Noeud): void => {
        tous.push(n);
        for (const x of n.Plans ?? []) parcourir(x);
      };
      parcourir(p.rows[0]!['QUERY PLAN'][0]!.Plan as Noeud);
      expect(tous.some((n) => n['Index Name'] === 'conversations_release_mba_idx')).toBe(true);
      expect(tous.filter((n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'conversations')).toEqual([]);
    } finally {
      await client.query('rollback').catch(() => {});
      client.release();
    }
  });
});
