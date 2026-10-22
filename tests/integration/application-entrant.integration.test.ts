import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgInboxStore } from '../../src/inbox/store.pg';
import { creerDejaRecu } from '../../src/application/entrant.pg';

/**
 * RECEVOIR, FILIÈRE APPLICATION (plan 2026-10-22, tâche 4), sur une vraie base : « déjà reçu » lit le message par la
 * conversation de l'espace, jamais d'un autre.
 *
 * ⚠️ Ne PAS le lancer en local : le `DATABASE_URL` du `.env` local pointe sur la base de PRODUCTION. La CI monte un
 * Postgres jetable pour ça (job `integration`).
 */
const url = process.env.DATABASE_URL ?? '';

describe.skipIf(!url)('un message de l’application déjà reçu', () => {
  let pool: Pool;
  let t1 = '';
  let t2 = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    const espace = async (nom: string) => (await pool.query<{ id: string }>(`insert into tenants (name) values ($1) returning id`, [nom])).rows[0]!.id;
    t1 = await espace('itest-application-entrant-1');
    t2 = await espace('itest-application-entrant-2');
  });

  afterAll(async () => {
    await pool.query('delete from tenants where id = any($1::uuid[])', [[t1, t2]]);
    await pool.end();
  });

  it('🔴 se lit dans l’espace qui l’a reçu, et seulement là', async () => {
    const id = 'app:aaaaaaaa-0000-4000-8000-000000000001:ITEST-DEJA-RECU';
    const dejaRecu = creerDejaRecu(pool);
    expect(await dejaRecu(t1, id)).toBe(false);
    await new PgInboxStore(pool).recordInbound(t1, {
      phoneNumberId: '', waId: '33600000071', messageId: id, type: 'text', body: 'Bonjour', buttonPayload: null, profileName: null, field: 'messages',
    });
    expect(await dejaRecu(t1, id)).toBe(true);
    expect(await dejaRecu(t2, id)).toBe(false);
  });
});
