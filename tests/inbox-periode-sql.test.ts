import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { PgInboxStore } from '../src/inbox/store.pg';

/**
 * LA PÉRIODE DE `list_conversations`, dans le SQL produit (relecture du lot « Campagnes depuis Claude », 2026-10-20) :
 * chaque borne doit viser SON paramètre. Écrite `${n}` au lieu de `$${n}`, la clause devenait `>= 2::timestamptz`, que
 * Postgres refuse, et l'outil échouait à chaque appel daté. Le test d'intégration le voit, mais seulement en CI ; celui-ci
 * le voit partout, sur le SQL lui-même.
 */
function store() {
  const lus: Array<{ sql: string; params: unknown[] }> = [];
  const pool = { query: async (sql: string, params: unknown[]) => { lus.push({ sql, params }); return { rows: [] }; } } as unknown as Pool;
  return { s: new PgInboxStore(pool), lus };
}

describe('listConversations : la période dans le SQL', () => {
  it('🔴 « depuis » et « jusqua » visent chacun leur paramètre', async () => {
    const { s, lus } = store();
    await s.listConversations('t1', { depuis: '2026-10-12T22:00:00.000Z', jusqua: '2026-10-19T22:00:00.000Z' });
    const { sql, params } = lus[0]!;
    const depuis = /c\.last_message_at >= \$(\d+)::timestamptz/.exec(sql);
    const jusqua = /c\.last_message_at < \$(\d+)::timestamptz/.exec(sql);
    expect(depuis, 'clause « depuis » absente ou sans paramètre').not.toBeNull();
    expect(jusqua, 'clause « jusqua » absente ou sans paramètre').not.toBeNull();
    expect(params[Number(depuis![1]) - 1]).toBe('2026-10-12T22:00:00.000Z');
    expect(params[Number(jusqua![1]) - 1]).toBe('2026-10-19T22:00:00.000Z');
  });

  it('sans période, aucune clause sur le dernier message', async () => {
    const { s, lus } = store();
    await s.listConversations('t1', {});
    expect(lus[0]!.sql).not.toMatch(/c\.last_message_at (>=|<) /);
  });
});
