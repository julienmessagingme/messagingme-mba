import type { Pool } from 'pg';

/**
 * Signal de vie du worker : prouve que le process tourne (event loop non bloquée), pas que pg-boss dépile.
 * Pour des files gelées, c'est le backlog de `getQueueLoad` qui sert.
 */
export interface WorkerHeartbeatRow {
  beatAt: string;
  bootedAt: string | null;
  instance: string | null;
  /** Âge du dernier battement en secondes, calculé côté base (`now() - beat_at`) pour ne pas dépendre de l'écart
   *  d'horloge entre l'API et le worker. */
  ageSeconds: number;
}

/**
 * Accès à `worker_heartbeat` (ligne unique id='worker'), écrite par le worker, lue par /ops.
 * Table du schéma public, non qualifiée comme les autres ; `getQueueLoad` lit `pgboss.job`, un autre schéma :
 * ne pas aligner l'un sur l'autre.
 */
export class PgWorkerHeartbeatStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Upsert du battement ; `boot=true` rafraîchit aussi booted_at. L'appelant l'enveloppe en best-effort : une
   * écriture qui lève ne doit pas tuer le worker.
   */
  async beat(instance: string, boot: boolean): Promise<void> {
    if (boot) {
      await this.pool.query(
        `insert into worker_heartbeat (id, beat_at, booted_at, instance) values ('worker', now(), now(), $1)
         on conflict (id) do update set beat_at = now(), booted_at = now(), instance = excluded.instance`,
        [instance],
      );
      return;
    }
    await this.pool.query(
      `insert into worker_heartbeat (id, beat_at, booted_at, instance) values ('worker', now(), now(), $1)
       on conflict (id) do update set beat_at = now(), instance = excluded.instance`,
      [instance],
    );
  }

  /** Dernier battement, ou null si aucun worker n'a jamais battu. */
  async get(): Promise<WorkerHeartbeatRow | null> {
    const res = await this.pool.query<{ beat_at: Date; booted_at: Date | null; instance: string | null; age_seconds: string }>(
      `select beat_at, booted_at, instance, extract(epoch from (now() - beat_at)) as age_seconds
       from worker_heartbeat where id = 'worker'`,
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      beatAt: row.beat_at.toISOString(),
      bootedAt: row.booted_at ? row.booted_at.toISOString() : null,
      instance: row.instance,
      ageSeconds: Math.max(0, Math.round(Number(row.age_seconds))),
    };
  }
}
