import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgUserStore } from '../../src/user/store.pg';

/**
 * 🔴 LE MOT DE PASSE SE LIT SUR L'IDENTITÉ, là où il s'écrit. `getPasswordHash` lisait la copie du compte
 * pendant que `setPassword` écrivait sur l'identité : un compte dont la copie divergeait (une inscription avec
 * l'adresse d'un autre) changeait le mot de passe de toute l'adresse.
 *
 * ⚠️ Ne PAS le lancer en local : le `DATABASE_URL` du `.env` local pointe sur la base de PRODUCTION.
 */
const url = process.env.DATABASE_URL ?? '';

describe.skipIf(!url)('le mot de passe d’une adresse, en base', () => {
  let pool: Pool;
  beforeAll(() => { pool = new Pool({ connectionString: url, ssl: pgSsl() }); });
  afterAll(async () => { await pool.end(); });

  it('getPasswordHash lit l’identité, pas la copie du compte', async () => {
    const users = new PgUserStore(pool);
    const email = `mdp.itest.${Date.now()}@exemple.fr`;
    const premier = await users.createTenantWithAdmin('Espace un', { email, name: null, passwordHash: 'scrypt$un$1' });
    // Deuxième compte sur la même identité, dont la COPIE porte un autre hash : l'état que laissait une
    // inscription avec l'adresse d'un autre.
    const second = await users.createTenantWithAdmin('Espace deux', { email, name: null, passwordHash: 'scrypt$deux$2' });
    try {
      expect(await users.getPasswordHash(second.userId)).toBe('scrypt$un$1');
      expect(await users.motDePasseDeLAdresse(email.toUpperCase())).toBe('scrypt$un$1');
    } finally {
      await pool.query('delete from tenants where id = any($1)', [[premier.tenantId, second.tenantId]]);
      await pool.query('delete from identities where lower(email) = lower($1)', [email]);
    }
  });

  it('motDePasseDeLAdresse distingue une adresse inconnue d’une identité sans mot de passe', async () => {
    const users = new PgUserStore(pool);
    const email = `sansmdp.itest.${Date.now()}@exemple.fr`;
    expect(await users.motDePasseDeLAdresse(email)).toBeUndefined();
    const compte = await users.createTenantWithAdmin('Espace Google', { email, name: null, passwordHash: null });
    try {
      expect(await users.motDePasseDeLAdresse(email)).toBeNull();
    } finally {
      await pool.query('delete from tenants where id = $1', [compte.tenantId]);
      await pool.query('delete from identities where lower(email) = lower($1)', [email]);
    }
  });
});
