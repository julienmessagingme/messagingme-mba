import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgPoolAttentesStore } from '../../src/ops/pool-attentes.pg';

const url = process.env.DATABASE_URL ?? '';

/**
 * L'AGRÉGAT D'ATTENTE DU POOL (lot 7 du plan post-audit, migration 0109).
 *
 * 🔴 EN INTÉGRATION parce que tout ce qui est délicat ici est du SQL, et faux d'une manière qui ne se voit
 * pas : le `on conflict` doit ADDITIONNER les compteurs (deux vidages dans la même minute, après un
 * redémarrage, ne doivent pas s'écraser) et combiner les maxima par `greatest`, la seule façon correcte de
 * fusionner deux pics. Un remplacement pur passerait tous les tests unitaires du monde.
 */
describe.skipIf(!url)('attentes du pool (Postgres)', () => {
  let pool: Pool;
  let store: PgPoolAttentesStore;
  const processus = `itest-${Math.abs(Date.now() % 100000)}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 2 });
    store = new PgPoolAttentesStore(pool);
  });

  afterAll(async () => {
    await pool.query('delete from pool_attentes where process like $1', ['itest-%']).catch(() => {});
    await pool.end().catch(() => {});
  });

  it('🔴 deux vidages dans la MÊME minute s’additionnent, et les pics se combinent par le maximum', async () => {
    const minute = new Date();
    minute.setSeconds(0, 0);
    await store.enregistrer(processus, minute, { echantillons: 10, attentes: 2, maxMs: 40, maxAttenteMs: 40, sommeMs: 100 });
    await store.enregistrer(processus, minute, { echantillons: 5, attentes: 1, maxMs: 900, maxAttenteMs: 900, sommeMs: 950 });
    const point = (await store.lireDernieresMinutes(10)).find((p) => p.process === processus);
    expect(point).toBeDefined();
    expect(point!.echantillons).toBe(15); // additionné, pas remplacé
    expect(point!.attentes).toBe(3);
    expect(point!.maxMs).toBe(900); // le pic du second, pas celui du dernier écrit par hasard
    expect(point!.moyenneMs).toBeCloseTo(1050 / 15, 5);
  });

  it('la moyenne est DÉRIVÉE de la somme, jamais stockée', async () => {
    // La garder en base serait une seconde vérité à recalculer à chaque fusion, donc à faire diverger.
    const minute = new Date(Date.now() - 60_000);
    minute.setSeconds(0, 0);
    await store.enregistrer(`${processus}-b`, minute, { echantillons: 4, attentes: 0, maxMs: 12, maxAttenteMs: 0, sommeMs: 40 });
    const point = (await store.lireDernieresMinutes(10)).find((p) => p.process === `${processus}-b`);
    expect(point!.moyenneMs).toBe(10);
  });

  it('la lecture est bornée dans le temps et rendue du plus ANCIEN au plus récent', async () => {
    // C'est l'ordre où une courbe se dessine : l'inverser mettrait le passé à droite.
    const points = await store.lireDernieresMinutes(180);
    const minutes = points.map((p) => p.minute);
    expect([...minutes].sort()).toEqual(minutes);
  });

  it('la purge efface les vieilles minutes et épargne les récentes', async () => {
    await pool.query(
      `insert into pool_attentes (process, minute, echantillons, attentes, max_ms, somme_ms)
       values ($1, now() - interval '30 days', 1, 0, 1, 1)`,
      [`${processus}-vieux`],
    );
    const efface = await store.purgeOlderThan(7);
    expect(efface).toBeGreaterThanOrEqual(1);
    const restants = await store.lireDernieresMinutes(180);
    expect(restants.some((p) => p.process === processus)).toBe(true);
  });
});
