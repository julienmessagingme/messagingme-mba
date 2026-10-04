import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgMesuresTachesStore } from '../../src/ops/mesure-taches.pg';
import { PgStockageStore } from '../../src/ops/stockage.pg';

/**
 * Les mesures de `/ops` sur une vraie base : les tâches de fond (migration 0207) et les octets en base.
 *
 * ⚠️ CI SEULEMENT : le `DATABASE_URL` local est la production.
 */
const url = process.env.DATABASE_URL ?? '';
const PROCESS = 'itest-worker';

describe.skipIf(!url)('mesures de /ops', () => {
  let pool: Pool;
  let tenantId = '';
  const store = () => new PgMesuresTachesStore(pool);

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 3 });
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-ops-mesures') returning id`)).rows[0]!.id;
  });

  beforeEach(async () => {
    await pool.query('delete from taches_mesures where process = $1', [PROCESS]);
  });

  afterAll(async () => {
    await pool.query('delete from taches_mesures where process = $1', [PROCESS]);
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  it('🔴 deux vidages dans la même heure s’additionnent ; null plus null reste null, null plus 5 vaut 5', async () => {
    const heure = new Date();
    heure.setUTCMinutes(0, 0, 0);
    await store().enregistrer(PROCESS, heure, [
      { tache: 'purge', passes: 2, echecs: 0, sautees: 0, sommeMs: 300, maxMs: 200, lignes: null, maxLignes: null },
      { tache: 'battement', passes: 3, echecs: 0, sautees: 1, sommeMs: 9, maxMs: 4, lignes: null, maxLignes: null },
    ]);
    await store().enregistrer(PROCESS, heure, [
      { tache: 'purge', passes: 1, echecs: 1, sautees: 0, sommeMs: 700, maxMs: 700, lignes: 5, maxLignes: 5 },
      { tache: 'battement', passes: 3, echecs: 0, sautees: 1, sommeMs: 6, maxMs: 2, lignes: null, maxLignes: null },
    ]);
    const lues = (await store().lire(24)).filter((r) => r.process === PROCESS);
    // La plus lente en tête.
    expect(lues.map((r) => r.tache)).toEqual(['purge', 'battement']);
    expect(lues[0]).toMatchObject({ passes: 3, echecs: 1, sommeMs: 1000, maxMs: 700, lignes: 5, maxLignes: 5 });
    // Les tours sautés s'additionnent aussi : un par vidage.
    expect(lues[1]).toMatchObject({ passes: 6, sautees: 2, sommeMs: 15, maxMs: 4, lignes: null, maxLignes: null });
    expect(lues[0]!.derniere).toBe(heure.toISOString());
  });

  it('la lecture ne voit que la fenêtre, la purge efface au-delà de sa rétention', async () => {
    const ancienne = new Date(Date.now() - 10 * 24 * 3600_000);
    ancienne.setUTCMinutes(0, 0, 0);
    await store().enregistrer(PROCESS, ancienne, [{ tache: 'vieille', passes: 1, echecs: 0, sautees: 0, sommeMs: 1, maxMs: 1, lignes: null, maxLignes: null }]);
    expect((await store().lire(24)).filter((r) => r.process === PROCESS)).toEqual([]);
    expect(await store().purgeOlderThan(7)).toBeGreaterThanOrEqual(1);
    const reste = await pool.query('select 1 from taches_mesures where process = $1', [PROCESS]);
    expect(reste.rowCount).toBe(0);
  });

  it('une durée hors de la capacité d’un integer est bornée, pas refusée', async () => {
    const heure = new Date();
    heure.setUTCMinutes(0, 0, 0);
    await store().enregistrer(PROCESS, heure, [{ tache: 'enorme', passes: 1, echecs: 0, sautees: 0, sommeMs: 5e12, maxMs: 5e12, lignes: null, maxLignes: null }]);
    const [r] = (await store().lire(24)).filter((x) => x.process === PROCESS);
    expect(r!.maxMs).toBe(2_147_483_647);
  });

  it('🔴 le stockage compte les octets utiles d’une image RCS, sans charger ses octets', async () => {
    const avant = await new PgStockageStore(pool).mesurer();
    const octets = Buffer.alloc(4096, 7);
    await pool.query(
      `insert into rcs_media (tenant_id, code, mime, bytes, taille) values ($1, $2, 'image/png', $3, $4)`,
      [tenantId, `itest-${Date.now()}`, octets, octets.length],
    );
    const apres = await new PgStockageStore(pool).mesurer();
    const rcs = (m: typeof avant) => m.familles.find((f) => f.famille === 'rcs')!;
    expect(rcs(apres).elements).toBe(rcs(avant).elements + 1);
    expect(rcs(apres).octets).toBe(rcs(avant).octets + 4096);
    expect(apres.familles.map((f) => f.famille)).toEqual(['rcs', 'pubs', 'flows']);
    expect(apres.baseOctets).toBeGreaterThan(0);
    expect(apres.tables.length).toBeGreaterThan(0);
    expect(apres.tables.length).toBeLessThanOrEqual(8);
  });
});
