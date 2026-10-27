import type { Pool } from 'pg';
import { ALL_QUEUES } from '../queue/names';

/**
 * LA LATENCE DES FILES, HEURE PAR HEURE (refonte de /ops, lot 1, migration 0258). pg-boss efface ses tâches terminées
 * au bout de sept jours (`deleteAfterSeconds`) : pour tracer un mois, le worker principal recopie chaque heure dans
 * `mesures_files_heures`. Tout est au mieux, comme les autres mesures : une mesure ne fait jamais tomber ce qu'elle
 * mesure.
 */

/** Ce que l'onglet Capacité garde : trente jours (décision de Julien, cadrage du 2026-10-27). */
export const RETENTION_FILES_HEURES_JOURS = 30;

/**
 * Les files que l'onglet Capacité trace. Le relevé les garde TOUTES (un lot suivant en tracera d'autres) ; la lecture
 * n'envoie que celles-ci, sinon trente jours de trente-quatre files partiraient à chaque ouverture de l'onglet.
 */
export const FILES_DE_CAPACITE: readonly string[] = ['webhook', 'webhook-status'];

export interface PointFileHeure {
  file: string;
  heure: string;
  echantillons: number;
  attenteP95Secondes: number;
  boutEnBoutP95Secondes: number;
  boutEnBoutMaxSecondes: number;
}

export class PgMesuresFilesStore {
  constructor(private readonly pool: Pool, private readonly schemaPgBoss: string) {}

  /**
   * Recalcule les heures commencées depuis `depuis` (l'heure en cours et la précédente, à chaque passage) : l'heure
   * en cours se complète d'un passage à l'autre, la précédente se fige. Mêmes définitions que la carte de latence de
   * `/ops` (`getQueueLatence`) : l'attente compte depuis `start_after`, donc une tâche programmée n'est pas en retard.
   * Chaque durée est bornée au plus grand `integer` : une seule valeur hors bornes ferait échouer le relevé de TOUTES
   * les files.
   */
  async relever(depuis: Date): Promise<number> {
    const res = await this.pool.query(
      `insert into mesures_files_heures (file, heure, echantillons, attente_p95_ms, bout_en_bout_p95_ms, bout_en_bout_max_ms)
       select name, date_trunc('hour', completed_on), count(*)::int,
              least(2147483647, round(1000 * greatest(0, percentile_cont(0.95) within group (order by extract(epoch from (started_on - start_after))))))::int,
              least(2147483647, round(1000 * greatest(0, percentile_cont(0.95) within group (order by extract(epoch from (completed_on - start_after))))))::int,
              least(2147483647, round(1000 * greatest(0, max(extract(epoch from (completed_on - start_after))))))::int
         from ${this.schemaPgBoss}.job
        where name = any($1) and state = 'completed' and started_on is not null and completed_on is not null
          and completed_on >= date_trunc('hour', $2::timestamptz)
        group by 1, 2
       on conflict (file, heure) do update set
         echantillons = excluded.echantillons,
         attente_p95_ms = excluded.attente_p95_ms,
         bout_en_bout_p95_ms = excluded.bout_en_bout_p95_ms,
         bout_en_bout_max_ms = excluded.bout_en_bout_max_ms`,
      [ALL_QUEUES, depuis],
    );
    return res.rowCount ?? 0;
  }

  /** Les `jours` derniers jours des `files` demandées, du plus ancien au plus récent. */
  async lire(jours: number, files: readonly string[] = FILES_DE_CAPACITE): Promise<PointFileHeure[]> {
    const res = await this.pool.query<{
      file: string; heure: Date; echantillons: number; attente_p95_ms: number; bout_en_bout_p95_ms: number; bout_en_bout_max_ms: number;
    }>(
      `select file, heure, echantillons, attente_p95_ms, bout_en_bout_p95_ms, bout_en_bout_max_ms
         from mesures_files_heures
        where heure > now() - make_interval(days => $1::int) and file = any($2)
        order by heure asc, file asc`,
      [Math.max(1, Math.min(Math.floor(jours), RETENTION_FILES_HEURES_JOURS)), [...files]],
    );
    return res.rows.map((r) => ({
      file: r.file,
      heure: r.heure.toISOString(),
      echantillons: r.echantillons,
      attenteP95Secondes: r.attente_p95_ms / 1000,
      boutEnBoutP95Secondes: r.bout_en_bout_p95_ms / 1000,
      boutEnBoutMaxSecondes: r.bout_en_bout_max_ms / 1000,
    }));
  }

  async purgeOlderThan(jours: number): Promise<number> {
    const res = await this.pool.query(
      `delete from mesures_files_heures where heure < now() - make_interval(days => $1::int)`,
      [Math.max(1, Math.floor(jours))],
    );
    return res.rowCount ?? 0;
  }
}
