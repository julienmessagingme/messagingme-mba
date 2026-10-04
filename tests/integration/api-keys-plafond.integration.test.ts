import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgApiKeyStore, type PlafondCles } from '../../src/auth/api-key-store.pg';

/**
 * AU PLUS DIX CLÉS ACTIVES PAR ESPACE (décision de Julien, 2026-10-04), tenu en base par `creerSousPlafond`.
 *
 * ⚠️ CI SEULEMENT : le `DATABASE_URL` local est la production.
 */
const url = process.env.DATABASE_URL ?? '';
const PLAFOND: PlafondCles = { max: 10, horsDroit: 'mba:relais' };

describe.skipIf(!url)('le plafond de clés d’API actives par espace', () => {
  let pool: Pool;
  let tenantId = '';
  let autre = '';
  let cles: PgApiKeyStore;

  beforeAll(async () => {
    // Douze connexions : l'épreuve de concurrence ouvre douze transactions à la fois.
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 13 });
    cles = new PgApiKeyStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-plafond-cles') returning id`)).rows[0]!.id;
    autre = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-plafond-cles-autre') returning id`)).rows[0]!.id;
  });

  beforeEach(async () => {
    await pool.query('delete from api_keys where tenant_id = any($1::uuid[])', [[tenantId, autre]]);
  });

  afterAll(async () => {
    await pool.query('delete from tenants where id = any($1::uuid[])', [[tenantId, autre].filter(Boolean)]);
    await pool.end();
  });

  const creer = (nom: string): Promise<{ id: string; key: string } | null> =>
    cles.creerSousPlafond(tenantId, nom, ['contacts:write'], PLAFOND);

  it('🔴 la onzième est refusée ; ni la clé du relais, ni les révoquées, ni l’autre espace ne comptent', async () => {
    // Ce qui ne doit PAS compter, posé d'abord : sinon le test passerait aussi avec un compte trop large.
    await cles.create(tenantId, 'Agent de Meta', ['mba:relais']);
    const revoquee = await creer('à révoquer');
    await cles.revoke(tenantId, revoquee!.id);
    for (let i = 0; i < 10; i += 1) await cles.creerSousPlafond(autre, `ailleurs ${i}`, ['contacts:write'], PLAFOND);

    for (let i = 0; i < 10; i += 1) expect(await creer(`clé ${i}`), `la clé ${i + 1} doit passer`).not.toBeNull();
    expect(await creer('de trop')).toBeNull();
    const n = await pool.query<{ n: number }>(
      `select count(*)::int as n from api_keys where tenant_id = $1 and revoked_at is null and name = 'de trop'`, [tenantId],
    );
    expect(n.rows[0]!.n).toBe(0);
  });

  it('révoquer une clé libère une place', async () => {
    const premiere = await creer('clé 0');
    for (let i = 1; i < 10; i += 1) await creer(`clé ${i}`);
    expect(await creer('de trop')).toBeNull();
    await cles.revoke(tenantId, premiere!.id);
    expect(await creer('remplaçante')).not.toBeNull();
  });

  it('🔴 la création attend le verrou de l’espace : le compte et l’insertion ne se croisent pas', async () => {
    // Même clé de verrou que `creerSousPlafond`. Prise ici en session : la création doit l'attendre. Sans le
    // verrou, elle rendrait tout de suite, et deux créations simultanées dépasseraient le plafond.
    const tient = await pool.connect();
    try {
      await tient.query(`select pg_advisory_lock(hashtext('api_keys:' || $1))`, [tenantId]);
      let rendue = false;
      const enCours = creer('attend').then((r) => { rendue = true; return r; });
      await new Promise((r) => setTimeout(r, 500));
      expect(rendue, 'la création a rendu sans attendre le verrou de l’espace').toBe(false);
      await tient.query(`select pg_advisory_unlock(hashtext('api_keys:' || $1))`, [tenantId]);
      expect(await enCours).not.toBeNull();
    } finally {
      await tient.query('select pg_advisory_unlock_all()').catch(() => {});
      tient.release();
    }
  });

  it('douze créations simultanées n’en laissent passer que dix', async () => {
    const rendues = await Promise.all(Array.from({ length: 12 }, (_, i) => creer(`simultanée ${i}`)));
    expect(rendues.filter((r) => r !== null)).toHaveLength(10);
    const n = await pool.query<{ n: number }>(
      `select count(*)::int as n from api_keys where tenant_id = $1 and revoked_at is null`, [tenantId],
    );
    expect(n.rows[0]!.n).toBe(10);
  });
});
