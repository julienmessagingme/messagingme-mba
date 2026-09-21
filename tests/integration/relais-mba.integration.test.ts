import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgJournalAppels } from '../../src/agent/catalog.pg';

/**
 * La migration 0161 : le relais du Meta Business Agent (spec 2026-09-21-relais-mba-design.md).
 *
 * ⚠️ CI SEULEMENT : le `DATABASE_URL` local est la production.
 */
const url = process.env.DATABASE_URL ?? '';

describe.skipIf(!url)('migration 0161 : le relais du MBA', () => {
  let pool: Pool;
  let tenantId = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-relais-mba') returning id`)).rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  it('🔴 le journal accepte un appel de l’agent de Meta, sans session', async () => {
    // Sans l'élargissement du CHECK, cette écriture échoue, et le journal du relais resterait muet : le
    // `journaliser` du point de passage est best-effort, il avale l'erreur.
    const journal = new PgJournalAppels(pool);
    const id = await journal.ouvrir({
      tenantId, sessionId: null, toolId: null, toolName: 'add_tag', origin: 'http', argsRediges: {}, source: 'mba',
    });
    const r = await pool.query<{ source: string }>('select source from agent_tool_calls where id = $1', [id]);
    expect(r.rows[0]!.source).toBe('mba');
  });

  it('la colonne de la clé retenue existe, nullable, et suit la suppression de la clé', async () => {
    const col = await pool.query<{ is_nullable: string; data_type: string }>(
      `select is_nullable, data_type from information_schema.columns
        where table_name = 'tenant_settings' and column_name = 'mba_relais_cle_id'`,
    );
    expect(col.rows[0]).toEqual({ is_nullable: 'YES', data_type: 'uuid' });
    const fk = await pool.query<{ confdeltype: string }>(
      `select confdeltype from pg_constraint
        where conrelid = 'tenant_settings'::regclass and contype = 'f'
          and conkey = array[(select attnum from pg_attribute where attrelid = 'tenant_settings'::regclass and attname = 'mba_relais_cle_id')]`,
    );
    // `n` = on delete set null : une clé supprimée redevient « aucune clé posée ».
    expect(fk.rows[0]!.confdeltype).toBe('n');
  });
});
