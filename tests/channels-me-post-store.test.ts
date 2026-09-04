import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { PgChannelsMePostStore } from '../src/channels-me/post-store.pg';

/**
 * La trace des publications, avec un FAUX pool (aucune base reelle).
 *
 * Ce que ces tests protegent, et qui ne se voit pas a la lecture :
 *  1. 🔴 Aucun STATUT n est stocke. Le statut d un post se lit en direct chez Channels Me : le miroiter
 *     creerait une copie a resynchroniser, donc une file de rattrapage, donc un etat qui ment quand elle
 *     prend du retard. Cette table ne porte que le rattachement post vers lien.
 *  2. create() rend void et ne fait AUCUN returning : l appelant vient de publier, il n a rien a relire.
 *  3. Chaque requete porte tenant_id, seul controle d isolation (pooler superuser, RLS contournee).
 *  4. Le mapping rend createdAt en ISO, jamais un objet Date brut.
 */

const TENANT = 't1';

interface Reponse { rows: Array<Record<string, unknown>>; rowCount?: number }

/** Faux pool : enregistre SQL et params, repond selon l ordre des appels. Aucune base, aucun reseau. */
function fauxPool(reponses: Reponse[] = []) {
  const requetes: Array<{ sql: string; params: unknown[] }> = [];
  let i = 0;
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      requetes.push({ sql, params });
      const r = reponses[Math.min(i, reponses.length - 1)] ?? { rows: [] };
      i += 1;
      return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
    },
  } as unknown as Pool;
  return { pool, requetes };
}

/** Ligne `channelsme_posts` telle que Postgres la rend (created_at en Date, comme le driver pg). */
function lignePost(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'pst-1', tenant_id: TENANT, cm_message_id: 'cmmsg-1001', link_id: 'lnk-1',
    created_at: new Date('2026-09-04T10:00:00.000Z'),
    ...over,
  };
}

describe('PgChannelsMePostStore (faux pool, sans base reelle)', () => {
  it('create() : insert scope tenant, params dans le bon ordre, aucun returning et aucun retour', async () => {
    const { pool, requetes } = fauxPool();
    const retour = await new PgChannelsMePostStore(pool).create(TENANT, {
      cmMessageId: 'cmmsg-1001', linkId: 'lnk-1',
    });

    const q = requetes[0]!;
    expect(q.sql).toMatch(/^insert into channelsme_posts/i);
    expect(q.sql).not.toMatch(/returning/i);
    expect(q.params).toEqual([TENANT, 'cmmsg-1001', 'lnk-1']);
    expect(retour).toBeUndefined();
  });

  it('create() : un post sans lien (linkId null) est accepte tel quel', async () => {
    const { pool, requetes } = fauxPool();
    await new PgChannelsMePostStore(pool).create(TENANT, { cmMessageId: 'cmmsg-1002', linkId: null });
    expect(requetes[0]!.params).toEqual([TENANT, 'cmmsg-1002', null]);
  });

  it('list() : trie par created_at desc, mapping en camelCase, createdAt en ISO', async () => {
    const { pool, requetes } = fauxPool([
      { rows: [lignePost(), lignePost({ id: 'pst-2', cm_message_id: 'cmmsg-1002', link_id: null })] },
    ]);
    const posts = await new PgChannelsMePostStore(pool).list(TENANT);

    expect(requetes[0]!.sql).toMatch(/where tenant_id=\$1 order by created_at desc/i);
    expect(requetes[0]!.params).toEqual([TENANT]);
    expect(posts[0]).toEqual({
      id: 'pst-1', tenantId: TENANT, cmMessageId: 'cmmsg-1001', linkId: 'lnk-1',
      createdAt: '2026-09-04T10:00:00.000Z',
    });
    expect(posts[1]!.linkId).toBeNull();
  });

  it('🔴 aucune requete ne stocke ni ne lit un statut : il se lit en direct chez Channels Me', async () => {
    const { pool, requetes } = fauxPool([{ rows: [lignePost()] }]);
    const store = new PgChannelsMePostStore(pool);
    await store.create(TENANT, { cmMessageId: 'cmmsg-1001', linkId: 'lnk-1' });
    await store.list(TENANT);

    expect(requetes).toHaveLength(2);
    for (const q of requetes) {
      expect(q.sql).not.toMatch(/status|statut|published_at|state/i);
      expect(q.sql).toMatch(/tenant_id/i);
    }
  });
});
