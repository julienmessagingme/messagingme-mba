import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgCspRapportsStore } from '../../src/csp/store.pg';
import type { RapportCsp } from '../../src/csp/rapports';

/**
 * LES RAPPORTS CSP AGRÉGÉS (migration 0236), contre une VRAIE base : ce qu'aucun test unitaire ne voit, que la même
 * combinaison COMPTE au lieu de se répéter, et que la borne arrête une combinaison neuve sans arrêter le compte des
 * anciennes.
 *
 * ⚠️ Ne PAS le lancer en local : le `DATABASE_URL` du `.env` local pointe sur la base de PRODUCTION. La CI monte un
 * Postgres jetable pour ça (job `integration`).
 */
const url = process.env.DATABASE_URL ?? '';
const PAGE = '/itest-csp';
const rapport = (bloque: string): RapportCsp => ({ directive: 'connect-src', bloque, page: PAGE, disposition: 'report' });

describe.skipIf(!url)('les rapports CSP en base', () => {
  let pool: Pool;

  const ligne = async (bloque: string) => (await pool.query<{ compte: number; premier_vu: Date; dernier_vu: Date }>(
    'select compte, premier_vu, dernier_vu from csp_rapports where page = $1 and bloque = $2', [PAGE, bloque])).rows;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    await pool.query('delete from csp_rapports where page = $1', [PAGE]);
  });

  afterAll(async () => {
    await pool.query('delete from csp_rapports where page = $1', [PAGE]);
    await pool.end();
  });

  it('🔴 la même combinaison compte, une seule ligne', async () => {
    const store = new PgCspRapportsStore(pool);
    await store.noter(rapport('https://a.itest'));
    await store.noter(rapport('https://a.itest'));
    const lignes = await ligne('https://a.itest');
    expect(lignes).toHaveLength(1);
    expect(lignes[0]!.compte).toBe(2);
    expect(lignes[0]!.dernier_vu.getTime()).toBeGreaterThanOrEqual(lignes[0]!.premier_vu.getTime());
  });

  it('🔴 vingt rapports simultanés d’une même combinaison neuve : une ligne, vingt comptés', async () => {
    const store = new PgCspRapportsStore(pool);
    await Promise.all(Array.from({ length: 20 }, () => store.noter(rapport('https://concurrence.itest'))));
    const lignes = await ligne('https://concurrence.itest');
    expect(lignes).toHaveLength(1);
    expect(lignes[0]!.compte).toBe(20);
  });

  it('🔴 à la borne, une combinaison neuve n’entre plus, une ancienne compte toujours', async () => {
    const avant = Number((await pool.query<{ n: string }>('select count(*) as n from csp_rapports')).rows[0]!.n);
    const borne = new PgCspRapportsStore(pool, avant + 1);
    await borne.noter(rapport('https://b.itest'));
    await borne.noter(rapport('https://c.itest'));
    await borne.noter(rapport('https://a.itest'));
    expect(await ligne('https://b.itest')).toHaveLength(1);
    expect(await ligne('https://c.itest'), 'la borne est atteinte').toHaveLength(0);
    expect((await ligne('https://a.itest'))[0]!.compte).toBe(3);
  });
});
