import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgPlafondEspaceStore } from '../../src/auth/plafond-espace.pg';
import { PgTenantSettingsStore } from '../../src/settings/store.pg';

/**
 * LE RÉGLAGE DU PLAFOND DE L'API D'UN ESPACE (migration 0181), contre une VRAIE base.
 *
 * 🔴 CE QU'AUCUN TEST UNITAIRE NE VOIT : que l'upsert est CIBLÉ (il n'écrase aucun autre réglage), qu'un espace
 * sans ligne de réglages se lit au défaut et un espace inexistant comme inexistant, qu'un espace inconnu n'écrit
 * rien au lieu de lever sur la clé étrangère, et que le CHECK refuse 0.
 *
 * ⚠️ Ne PAS le lancer en local : le `DATABASE_URL` du `.env` local pointe sur la base de PRODUCTION. La CI
 * monte un Postgres jetable pour ça (job `integration`).
 */
const url = process.env.DATABASE_URL ?? '';

describe.skipIf(!url)('le plafond de l’API par espace, en base', () => {
  let pool: Pool;
  let store: PgPlafondEspaceStore;
  let reglages: PgTenantSettingsStore;
  let tenantId = '';
  let autreTenantId = '';
  const INCONNU = '11111111-2222-4333-8444-555555555555';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    store = new PgPlafondEspaceStore(pool);
    reglages = new PgTenantSettingsStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-plafond-api') returning id`)).rows[0]!.id;
    autreTenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-plafond-api-autre') returning id`)).rows[0]!.id;
  });

  afterAll(async () => {
    for (const t of [tenantId, autreTenantId]) if (t) await pool.query('delete from tenants where id = $1', [t]);
    await pool.end();
  });

  it('🔴 un espace SANS ligne de réglages se lit au défaut, un espace inexistant rend null', async () => {
    expect(await store.lire(autreTenantId)).toEqual({ minute: null, heure: null });
    expect(await store.lire(INCONNU)).toBeNull();
  });

  it('🔴 l’écriture fait l’aller-retour, en entiers, et n’écrase aucun autre réglage', async () => {
    await reglages.setMbaEnabled(tenantId, true);
    expect(await store.ecrire(tenantId, { minute: 600, heure: null })).toBe(true);
    expect(await store.lire(tenantId)).toEqual({ minute: 600, heure: null });
    expect((await reglages.get(tenantId)).mbaEnabled, 'upsert ciblé : le réglage voisin n’a pas bougé').toBe(true);
    expect(await store.ecrire(tenantId, { minute: null, heure: 20_000 })).toBe(true);
    expect(await store.lire(tenantId)).toEqual({ minute: null, heure: 20_000 });
  });

  it('🔴 un espace SANS ligne de réglages en reçoit une, et l’espace voisin ne bouge pas', async () => {
    const t = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-plafond-api-neuf') returning id`)).rows[0]!.id;
    try {
      expect(await store.ecrire(t, { minute: 5, heure: 50 })).toBe(true);
      expect(await store.lire(t)).toEqual({ minute: 5, heure: 50 });
      expect(await store.lire(autreTenantId)).toEqual({ minute: null, heure: null });
    } finally {
      await pool.query('delete from tenants where id = $1', [t]);
    }
  });

  it('🔴 un espace inconnu n’écrit rien, et ne lève pas sur la clé étrangère', async () => {
    expect(await store.ecrire(INCONNU, { minute: 5, heure: 50 })).toBe(false);
    const n = await pool.query('select 1 from tenant_settings where tenant_id = $1', [INCONNU]);
    expect(n.rowCount).toBe(0);
  });

  it('🔴 le CHECK refuse 0 et un négatif, sur les deux colonnes', async () => {
    for (const colonne of ['api_plafond_minute', 'api_plafond_heure']) {
      for (const valeur of [0, -1]) {
        await expect(pool.query(`update tenant_settings set ${colonne} = $2 where tenant_id = $1`, [tenantId, valeur]))
          .rejects.toMatchObject({ code: '23514' });
      }
    }
  });
});
