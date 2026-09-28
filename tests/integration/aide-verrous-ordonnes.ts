import { setTimeout as dormir } from 'node:timers/promises';
import type { Pool } from 'pg';

/**
 * LA PREUVE QU'UNE PURGE VERROUILLE DANS L'ORDRE DE LA CLÉ, contre une vraie base (relecture du lot A, 2026-09-28).
 *
 * Le scénario qui interbloquait : deux lignes échues, `seconde` rangée AVANT `premiere` dans la table. Une session
 * tient `premiere`, la purge démarre, puis la session demande `seconde`.
 * - Purge dans l'ordre PHYSIQUE : elle prend `seconde`, attend `premiere` ; la session attend `seconde` : chacune
 *   attend l'autre, Postgres en tue une après `deadlock_timeout` (40P01), et ce helper lève.
 * - Purge dans l'ordre de la CLÉ : elle attend `premiere` sans rien tenir, la session prend `seconde`, valide, et la
 *   purge efface tout. Le helper rend le nombre de lignes effacées.
 *
 * ⚠️ Le cas ne prouve quelque chose que si `seconde` est bien rangée avant `premiere` : c'est vérifié (`ctid`) avant de
 * commencer, et un ordre inverse lève au lieu de passer pour rien.
 */
export async function verrouillerPuisPurger(o: {
  pool: Pool;
  table: 'verrous_courts' | 'compteurs_debit';
  /** La plus petite clé, que la session tient d'abord. */
  premiere: string;
  /** La plus grande, rangée avant l'autre dans la table, que la session demande ensuite. */
  seconde: string;
  purger: () => Promise<number>;
  /** Rend la main quand la purge attend un verrou (donc qu'elle a commencé et qu'elle bute sur `premiere`). */
  attendre: () => Promise<void>;
}): Promise<number> {
  const client = await o.pool.connect();
  try {
    await client.query('begin');
    const ctids = await client.query<{ cle: string; ctid: string }>(
      `select cle, ctid::text as ctid from ${o.table} where cle = any($1::text[])`,
      [[o.premiere, o.seconde]],
    );
    const position = (cle: string): [number, number] => {
      const brut = ctids.rows.find((r) => r.cle === cle)?.ctid ?? '';
      const m = /^\((\d+),(\d+)\)$/.exec(brut);
      if (!m) throw new Error(`ligne introuvable pour ${cle}`);
      return [Number(m[1]), Number(m[2])];
    };
    const [p, s] = [position(o.premiere), position(o.seconde)];
    if (!(s[0] < p[0] || (s[0] === p[0] && s[1] < p[1]))) {
      throw new Error('précondition : la seconde clé devait être rangée AVANT la première dans la table, le cas ne prouverait rien');
    }
    await client.query(`select 1 from ${o.table} where cle = $1 for update`, [o.premiere]);
    // La purge part sur une autre connexion ; son échec éventuel est gardé, pas laissé sans gestionnaire.
    const purge = o.purger().then((n) => ({ n }), (err: unknown) => ({ err }));
    await o.attendre();
    await client.query(`select 1 from ${o.table} where cle = $1 for update`, [o.seconde]);
    await client.query('commit');
    const r = await purge;
    if ('err' in r) throw r.err;
    return r.n;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Attend (au plus 5 s) qu'une purge de `table` soit bloquée sur un verrou de ligne. */
export async function attendreQueLaPurgeAttende(pool: Pool, table: 'verrous_courts' | 'compteurs_debit'): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const r = await pool.query<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity
       where wait_event_type = 'Lock' and query ilike $1 and pid <> pg_backend_pid()`,
      [`%delete from ${table}%`],
    );
    if ((r.rows[0]?.n ?? 0) > 0) return;
    await dormir(50);
  }
  throw new Error(`la purge de ${table} n’a jamais attendu de verrou : le cas ne prouve rien`);
}
