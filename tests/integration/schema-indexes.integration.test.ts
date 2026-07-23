import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';

const url = process.env.DATABASE_URL ?? '';

// Vérifie que la migration 0042 a bien créé les 6 index de montée en charge. C'est un test de
// SCHÉMA (pas de données) : il lit pg_indexes sur la base migrée. Si un index disparaît d'une
// migration ou n'est jamais appliqué, ce test le voit avant la production.
describe.skipIf(!url)('index de montée en charge (migration 0042)', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('les 6 index nommés existent sur les bonnes tables', async () => {
    const attendus: Array<{ table: string; index: string }> = [
      { table: 'contacts', index: 'contacts_tenant_created_idx' },
      { table: 'conversation_messages', index: 'conversation_messages_created_idx' },
      { table: 'phone_numbers', index: 'phone_numbers_tenant_created_idx' },
      { table: 'waba', index: 'waba_tenant_created_idx' },
      { table: 'conversation_messages', index: 'conversation_messages_sender_idx' },
      { table: 'workflow_runs', index: 'workflow_runs_workflow_idx' },
    ];
    const res = await pool.query<{ tablename: string; indexname: string }>(
      `select tablename, indexname from pg_indexes
       where schemaname = 'public' and indexname = any($1::text[])`,
      [attendus.map((a) => a.index)],
    );
    const trouves = new Set(res.rows.map((r) => `${r.tablename}.${r.indexname}`));
    for (const a of attendus) {
      expect(trouves.has(`${a.table}.${a.index}`), `${a.index} sur ${a.table} manquant`).toBe(true);
    }
  });
});
