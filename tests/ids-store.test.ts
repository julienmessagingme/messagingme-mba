import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { PgWorkflowStore } from '../src/workflow/store.pg';
import { PgUserStore } from '../src/user/store.pg';
import { PgUserFieldStore } from '../src/crm/field-store.pg';
import { PgTagStore } from '../src/crm/tag-store.pg';

const CODE_RE = (type: string) => new RegExp(`^${type}_k7m2p3_[0-9A-HJKMNP-TV-Z]{26}$`);

/** Fake pool : renvoie un public_code fixe pour resolveTenantCode, capture les INSERT. */
function fakePool() {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] });
      if (/select public_code/i.test(sql)) return { rows: [{ public_code: 'k7m2p3' }], rowCount: 1 };
      if (/returning/i.test(sql)) return { rows: [{ id: 'x1', email: 'a@b.fr', name: null, role: 'agent', created_at: new Date(0) }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Pool;
  return { pool, queries };
}

describe('génération de code public à l\'INSERT (schéma A)', () => {
  it('scénario -> scn_<client>_<ulid>', async () => {
    const { pool, queries } = fakePool();
    await new PgWorkflowStore(pool).insert('t1', 'Onboarding', { nodes: [], edges: [] });
    const ins = queries.find((q) => /insert into workflows/i.test(q.sql))!;
    expect(ins.params[3]).toMatch(CODE_RE('scn')); // (tenant_id, name, graph, code)
  });

  it('champ perso -> fld_<client>_<ulid>', async () => {
    const { pool, queries } = fakePool();
    await new PgUserFieldStore(pool).create('t1', { key: 'ville', label: 'Ville', type: 'text' });
    const ins = queries.find((q) => /insert into user_fields/i.test(q.sql))!;
    expect(ins.params[4]).toMatch(CODE_RE('fld')); // (tenant_id, key, label, type, code)
  });

  it('tag -> tag_<client>_<ulid>', async () => {
    const { pool, queries } = fakePool();
    await new PgTagStore(pool).create('t1', 'vip');
    const ins = queries.find((q) => /insert into tags/i.test(q.sql))!;
    expect(ins.params[2]).toMatch(CODE_RE('tag')); // (tenant_id, name, code)
  });

  it('user (invitation) -> usr_<client>_<ulid>', async () => {
    const { pool, queries } = fakePool();
    await new PgUserStore(pool).createPending('t1', 'a@b.fr', 'agent');
    const ins = queries.find((q) => /insert into users/i.test(q.sql))!;
    expect(ins.params[3]).toMatch(CODE_RE('usr')); // (tenant_id, email, role, code) — name/password_hash = littéraux null
  });
});
