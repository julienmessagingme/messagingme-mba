import type { Pool, PoolClient } from 'pg';

/**
 * Exécute `travail` dans une transaction : `commit` s'il rend, `rollback` s'il lève. La connexion est relâchée dans
 * tous les cas, et c'est l'erreur d'origine qui remonte, jamais celle du `rollback`.
 * Rendre sans lever valide la transaction : un travail qui ne doit rien laisser après avoir écrit doit lever.
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
