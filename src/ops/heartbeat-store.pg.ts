import type { Pool } from 'pg';

/**
 * Signal de vie du worker (item 4.9). Prouve que le PROCESS worker tourne (event loop non bloqué), PAS que
 * pg-boss dépile : un worker vivant dont les files sont gelées écrirait quand même son heartbeat. Pour « files
 * gelées », c'est le backlog/failed de getQueueLoad qui sert — deux signaux distincts, exposés côté /ops.
 */
export interface WorkerHeartbeatRow {
  beatAt: string;
  bootedAt: string | null;
  instance: string | null;
  /** Âge du dernier battement en secondes (calculé côté DB : now() - beat_at, insensible au décalage d'horloge
   *  entre l'API et le worker). Un âge qui dépasse largement HEARTBEAT_INTERVAL_MS = worker probablement mort. */
  ageSeconds: number;
}

/**
 * Accès à la table `worker_heartbeat` (ligne unique id='worker', migration 0044). Écrite par le worker,
 * lue par la surface /ops. Read + write au même endroit pour que la tolérance 42P01 et la note de schéma
 * ci-dessous n'aient qu'UNE définition (PgOpsStore reste, lui, strictement en lecture d'agrégats).
 * ⚠️ Table en schéma PUBLIC, lue/écrite NON qualifiée (comme tenants/contacts) : le pool n'a pas de search_path
 * custom, la résolution nue tombe sur public. Ne PAS la préfixer du schéma pgboss (getQueueLoad, lui, lit
 * `pgboss.job` qualifié — ce sont deux schémas différents ; « corriger » un côté en le préfixant casserait tout).
 */
export class PgWorkerHeartbeatStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Upsert best-effort du battement. `boot=true` (démarrage du worker) rafraîchit AUSSI booted_at. L'APPELANT
   * doit envelopper l'appel en best-effort (try/catch) : une écriture qui throw ne doit JAMAIS tuer le worker.
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

  /**
   * Dernier battement, ou null si aucun worker n'a jamais battu OU si la table n'existe pas encore (42P01,
   * fenêtre entre le deploy du code et la migration 0044) — même tolérance que getQueueLoad, sinon
   * /ops/overview casserait pendant le déploiement.
   */
  async get(): Promise<WorkerHeartbeatRow | null> {
    try {
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
    } catch (err) {
      // 42P01 = undefined_table (migration 0044 pas encore appliquée) -> null plutôt que planter la route.
      if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === '42P01') return null;
      throw err;
    }
  }
}
