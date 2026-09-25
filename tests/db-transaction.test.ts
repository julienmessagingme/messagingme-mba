import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { enTransaction } from '../src/db/transaction';

/** Un faux pool qui note chaque requête et chaque relâchement, et peut faire échouer le `rollback`. */
function fauxPool(opts: { rollbackLeve?: boolean } = {}) {
  const journal: string[] = [];
  const client = {
    query: async (sql: string) => {
      journal.push(sql);
      if (sql === 'rollback' && opts.rollbackLeve) throw new Error('connexion perdue pendant le rollback');
      return { rows: [], rowCount: 0 };
    },
    release: () => { journal.push('release'); },
  };
  return { pool: { connect: async () => client } as unknown as Pool, journal };
}

describe('enTransaction', () => {
  it('valide, rend le résultat du travail et relâche la connexion', async () => {
    const { pool, journal } = fauxPool();
    const r = await enTransaction(pool, async (client) => {
      await client.query('update t set x = 1');
      return 42;
    });
    expect(r).toBe(42);
    expect(journal).toEqual(['begin', 'update t set x = 1', 'commit', 'release']);
  });

  it('annule, relance l’erreur D’ORIGINE et relâche la connexion quand le travail lève', async () => {
    const { pool, journal } = fauxPool();
    const origine = new Error('contrainte violée');
    await expect(enTransaction(pool, async (client) => {
      await client.query('update t set x = 1');
      throw origine;
    })).rejects.toBe(origine);
    expect(journal).toEqual(['begin', 'update t set x = 1', 'rollback', 'release']);
  });

  it('🔴 un `rollback` qui échoue ne remplace pas l’erreur d’origine et ne garde pas la connexion', async () => {
    const { pool, journal } = fauxPool({ rollbackLeve: true });
    const origine = new Error('contrainte violée');
    await expect(enTransaction(pool, async () => { throw origine; })).rejects.toBe(origine);
    expect(journal).toEqual(['begin', 'rollback', 'release']);
  });
});
