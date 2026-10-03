import type { Pool } from 'pg';

/**
 * Signal de vie d'un worker : prouve que le process tourne (event loop non bloquée), pas que pg-boss dépile.
 * Pour des files gelées, c'est le backlog de `getQueueLoad` qui sert.
 */
export interface WorkerHeartbeatRow {
  /** Le rôle du worker qui bat (`principal`, `analyse`, ou `all` pour un worker unique) : la clé de la ligne. */
  role: string;
  beatAt: string;
  bootedAt: string | null;
  instance: string | null;
  /** Âge du dernier battement en secondes, calculé côté base (`now() - beat_at`) pour ne pas dépendre de l'écart
   *  d'horloge entre l'API et le worker. */
  ageSeconds: number;
}

/**
 * Accès à `worker_heartbeat`, UNE LIGNE PAR RÔLE (clé `id` = le rôle), écrite par chaque worker, lue par /ops.
 * Table du schéma public, non qualifiée comme les autres ; `getQueueLoad` lit `pgboss.job`, un autre schéma :
 * ne pas aligner l'un sur l'autre.
 *
 * 🔴 UNE LIGNE PAR RÔLE, ET C'EST TOUT L'ENJEU DE CETTE CLÉ (2026-10-03). Tant qu'il n'y avait qu'un worker, une
 * ligne unique `id = 'worker'` disait la vérité. Avec deux rôles, deux processus l'auraient écrite tous les deux :
 * le survivant aurait rafraîchi la ligne du mort, et /ops l'aurait lue vivante. La mort de l'un serait devenue
 * INVISIBLE, donc le découpage aurait rendu la surveillance pire qu'avant lui. La colonne `id` était déjà une clé
 * primaire : il suffisait d'y écrire le rôle, sans migration de schéma.
 *
 * ⚠️ L'ANCIENNE LIGNE `'worker'` NE S'EFFACE PAS TOUTE SEULE : plus personne ne l'écrit une fois les rôles posés,
 * elle vieillit, et /ops l'afficherait comme un worker mort. La migration 0202 l'efface, APRÈS le déploiement
 * (avant, l'ancien code la recréerait au battement suivant).
 */
export class PgWorkerHeartbeatStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Upsert du battement de CE rôle ; `boot=true` rafraîchit aussi booted_at. L'appelant l'enveloppe en
   * best-effort : une écriture qui lève ne doit pas tuer le worker.
   */
  async beat(role: string, instance: string, boot: boolean): Promise<void> {
    if (boot) {
      await this.pool.query(
        `insert into worker_heartbeat (id, beat_at, booted_at, instance) values ($1, now(), now(), $2)
         on conflict (id) do update set beat_at = now(), booted_at = now(), instance = excluded.instance`,
        [role, instance],
      );
      return;
    }
    await this.pool.query(
      `insert into worker_heartbeat (id, beat_at, booted_at, instance) values ($1, now(), now(), $2)
       on conflict (id) do update set beat_at = now(), instance = excluded.instance`,
      [role, instance],
    );
  }

  /**
   * Tous les battements, un par rôle, triés par rôle. Vide si aucun worker n'a jamais battu.
   *
   * 🔴 TOUTES LES LIGNES, SANS FILTRE SUR LES RÔLES ATTENDUS, et c'est délibéré : un filtre sur une liste de rôles
   * « connus » rendrait invisible exactement ce qu'on veut voir, une ligne qui a cessé de battre. Une ligne
   * périmée doit apparaître morte, c'est son seul rôle.
   */
  async lister(): Promise<WorkerHeartbeatRow[]> {
    const res = await this.pool.query<{ id: string; beat_at: Date; booted_at: Date | null; instance: string | null; age_seconds: string }>(
      `select id, beat_at, booted_at, instance, extract(epoch from (now() - beat_at)) as age_seconds
       from worker_heartbeat order by id`,
    );
    return res.rows.map((row) => ({
      role: row.id,
      beatAt: row.beat_at.toISOString(),
      bootedAt: row.booted_at ? row.booted_at.toISOString() : null,
      instance: row.instance,
      ageSeconds: Math.max(0, Math.round(Number(row.age_seconds))),
    }));
  }
}
