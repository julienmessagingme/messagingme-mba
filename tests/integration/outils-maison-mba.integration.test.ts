import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';

/**
 * Les outils maison de l'agent de Meta, contre une vraie base (migration 0162, spec
 * docs/superpowers/specs/2026-09-21-outils-maison-mba-design.md).
 *
 * ⚠️ CI SEULEMENT : le DATABASE_URL local est la production.
 */
const url = process.env.DATABASE_URL ?? '';

describe.skipIf(!url)('0162 : les contraintes', () => {
  let pool: Pool;
  let tenantId = '';
  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    tenantId = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-outils-maison-mba') returning id`,
    )).rows[0]!.id;
  });
  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  const inserer = (name: string, pourAgentMeta: boolean, origin = 'mba') => pool.query(
    `insert into agent_tools (tenant_id, origin, name, title, description, ne_pas_utiliser, params, binding, risk, pour_agent_meta)
     values ($1, $2, $3, 'T', 'D', 'N', '[]'::jsonb, '{"handler":"tag_fixe","tag":"vip"}'::jsonb, 'write', $4)`,
    [tenantId, origin, name, pourAgentMeta],
  );

  it('🔴 un outil maison SANS agent et SANS le drapeau reste refusé (0159 tient toujours)', async () => {
    await expect(inserer('orphelin', false)).rejects.toMatchObject({ code: '23514', constraint: 'agent_tools_action_par_agent_chk' });
  });

  it('un outil maison de l’agent de Meta est accepté', async () => {
    await expect(inserer('pose_vip', true)).resolves.toBeTruthy();
  });

  it('🔴 le drapeau sur un connecteur est refusé', async () => {
    // Refusé par 0088 (un connecteur exige une source) ou par 0162 : les deux disent non, c'est ce qui compte.
    await expect(inserer('faux_connecteur', true, 'http')).rejects.toMatchObject({ code: '23514' });
  });
});
