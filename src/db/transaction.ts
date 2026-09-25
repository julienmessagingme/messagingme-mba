import type { Pool, PoolClient } from 'pg';

/**
 * Exécute `travail` dans UNE transaction sur une connexion du pool : `begin`, puis `commit` si le travail rend,
 * `rollback` s'il lève. La connexion est relâchée dans TOUS les cas, y compris quand le `rollback` lui-même
 * échoue, et c'est l'erreur D'ORIGINE qui remonte, jamais celle du `rollback`.
 *
 * ⚠️ Rendre sans lever VALIDE la transaction. Un travail qui ne doit rien laisser derrière lui après avoir écrit
 * doit LEVER ; un travail qui n'a fait que lire peut rendre, la validation n'écrit alors rien.
 */
export async function enTransaction<T>(pool: Pick<Pool, 'connect'>, travail: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const r = await travail(client);
    await client.query('commit');
    return r;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
