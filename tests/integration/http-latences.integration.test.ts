import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgHttpLatencesStore, fenetreDe } from '../../src/ops/latence-http.pg';
import { BORNES_LATENCE_MS, trancheDe, type LigneLatence } from '../../src/ops/latence-http';

const url = process.env.DATABASE_URL ?? '';

/**
 * LA LATENCE HTTP EN BASE (migration 0205). 🔴 EN INTÉGRATION parce que tout ce qui est délicat est du SQL, faux
 * d'une manière qu'aucun test unitaire ne voit : le `on conflict` doit additionner les tranches UNE À UNE et dans
 * l'ordre, la lecture doit agréger copies et fenêtres sans mélanger les routes, et la purge ne toucher que l'ancien.
 * Chaque essai a ses propres routes : la table est partagée par tout le fichier.
 */
describe.skipIf(!url)('latence HTTP (Postgres)', () => {
  let pool: Pool;
  let store: PgHttpLatencesStore;
  const marque = `/itest-${Math.abs(Date.now() % 100000)}`;
  const N = BORNES_LATENCE_MS.length + 1;

  const ligne = (route: string, durees: number[], code = 200): LigneLatence => {
    const seaux = new Array<number>(N).fill(0);
    for (const d of durees) seaux[trancheDe(d)] = (seaux[trancheDe(d)] ?? 0) + 1;
    return { methode: 'GET', route, code, seaux, sommeMs: durees.reduce((s, d) => s + d, 0), maxMs: Math.max(...durees) };
  };
  const lue = async (route: string, code = 200) => (await store.lire(24)).find((r) => r.route === route && r.code === code);

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 2 });
    store = new PgHttpLatencesStore(pool);
  });

  afterAll(async () => {
    await pool.query('delete from http_latences where route like $1', ['/itest-%']).catch(() => {});
    await pool.end().catch(() => {});
  });

  it('🔴 deux vidages dans la MÊME fenêtre additionnent leurs tranches une à une, et les pics par le maximum', async () => {
    const route = `${marque}/fusion/:id`;
    const fenetre = fenetreDe(new Date());
    await store.enregistrer('api', fenetre, [ligne(route, [5, 5, 120])]);
    await store.enregistrer('api', fenetre, [ligne(route, [5, 900])]);
    const brut = await pool.query<{ seaux: number[]; somme_ms: string; max_ms: number }>(
      'select seaux, somme_ms::text, max_ms from http_latences where route = $1', [route],
    );
    expect(brut.rows).toHaveLength(1); // une seule ligne : additionnée, pas doublée
    const attendu = new Array<number>(N).fill(0);
    attendu[trancheDe(5)] = 3;
    attendu[trancheDe(120)] = 1;
    attendu[trancheDe(900)] = 1;
    expect(brut.rows[0]!.seaux).toEqual(attendu); // dans l'ordre, case par case
    expect(Number(brut.rows[0]!.somme_ms)).toBe(1035);
    expect(brut.rows[0]!.max_ms).toBe(900);
  });

  it('la lecture agrège copies et fenêtres, sans mélanger les codes ni les routes', async () => {
    const route = `${marque}/agrege`;
    const ici = fenetreDe(new Date());
    const avant = new Date(ici.getTime() - 5 * 60_000);
    await store.enregistrer('api-a', ici, [ligne(route, [20, 20]), ligne(route, [3], 404)]);
    await store.enregistrer('api-b', avant, [ligne(route, [450, 30])]);
    await store.enregistrer('api-a', ici, [ligne(`${marque}/voisine`, [9000])]);
    const ok = await lue(route);
    expect(ok).toMatchObject({ methode: 'GET', code: 200, groupe: 'autres', requetes: 4, maxMs: 450, moyenneMs: 130 });
    expect(ok!.p50Ms).toBe(25); // rang 2 : les deux requêtes de 20 ms, tranche « ≤ 25 »
    expect(ok!.p95Ms).toBe(450); // rang 4 : la tranche « ≤ 500 », plafonnée par le maximum
    expect(await lue(route, 404)).toMatchObject({ requetes: 1, maxMs: 3 });
    expect((await lue(`${marque}/voisine`))!.maxMs).toBe(9000);
  });

  it('la lecture est bornée dans le temps, et la purge n’efface que l’ancien', async () => {
    const vieille = `${marque}/vieille`;
    const recente = `${marque}/recente`;
    await store.enregistrer('api', fenetreDe(new Date(Date.now() - 9 * 24 * 3600_000)), [ligne(vieille, [1])]);
    await store.enregistrer('api', fenetreDe(new Date()), [ligne(recente, [1])]);
    expect(await lue(vieille)).toBeUndefined(); // hors des 24 h
    expect(await store.purgeOlderThan(7)).toBeGreaterThanOrEqual(1);
    const restantes = await pool.query<{ route: string }>('select route from http_latences where route in ($1, $2)', [vieille, recente]);
    expect(restantes.rows.map((r) => r.route)).toEqual([recente]);
  });

  it('un vidage vide n’écrit rien', async () => {
    await expect(store.enregistrer('api', fenetreDe(new Date()), [])).resolves.toBeUndefined();
  });
});
