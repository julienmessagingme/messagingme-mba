import type { Pool } from 'pg';
import type { MemoireConteneur } from './memoire-worker';

/**
 * La mémoire des workers, heure par heure (migration 0260). Chaque relevé réécrit la ligne de l'heure : la dernière
 * valeur, et le pire de l'heure. Au mieux, comme les autres mesures : une mesure ne fait jamais tomber ce qu'elle mesure.
 */

/** Ce que l'onglet Capacité garde : trente jours (décision de Julien, cadrage du 2026-10-27). */
export const RETENTION_MEMOIRE_WORKERS_JOURS = 30;
/** Au-delà, le dernier relevé d'un rôle n'est plus « l'instant » : l'onglet Santé ne le juge pas. */
export const FRAICHEUR_MEMOIRE_S = 300;

export interface MemoireWorker {
  role: string;
  utiliseOctets: number;
  limiteOctets: number | null;
}

export interface PointMemoireHeure {
  role: string;
  heure: string;
  maxOctets: number;
  limiteOctets: number | null;
}

export class PgMemoireWorkersStore {
  constructor(private readonly pool: Pool) {}

  async noter(role: string, m: MemoireConteneur): Promise<void> {
    await this.pool.query(
      `insert into memoire_workers (role, heure, max_octets, dernier_octets, limite_octets, maj)
       values ($1, date_trunc('hour', now()), $2, $2, $3, now())
       on conflict (role, heure) do update set
         max_octets = greatest(memoire_workers.max_octets, excluded.max_octets),
         dernier_octets = excluded.dernier_octets,
         limite_octets = excluded.limite_octets,
         maj = now()`,
      [role, Math.round(m.utiliseOctets), m.limiteOctets === null ? null : Math.round(m.limiteOctets)],
    );
  }

  /** Le dernier relevé de chaque rôle, s'il date de moins de `FRAICHEUR_MEMOIRE_S`. */
  async actuelles(): Promise<MemoireWorker[]> {
    const res = await this.pool.query<{ role: string; dernier_octets: string; limite_octets: string | null }>(
      `select distinct on (role) role, dernier_octets, limite_octets
         from memoire_workers
        where maj > now() - make_interval(secs => $1::int)
        order by role, heure desc`,
      [FRAICHEUR_MEMOIRE_S],
    );
    return res.rows.map((r) => ({
      role: r.role,
      utiliseOctets: Number(r.dernier_octets),
      limiteOctets: r.limite_octets === null ? null : Number(r.limite_octets),
    }));
  }

  /** Le pire de chaque heure, par rôle, sur les `jours` derniers jours, du plus ancien au plus récent. */
  async parHeure(jours: number): Promise<PointMemoireHeure[]> {
    const res = await this.pool.query<{ role: string; heure: Date; max_octets: string; limite_octets: string | null }>(
      `select role, heure, max_octets, limite_octets
         from memoire_workers
        where heure > now() - make_interval(days => $1::int)
        order by heure asc, role asc`,
      [Math.max(1, Math.min(Math.floor(jours), RETENTION_MEMOIRE_WORKERS_JOURS))],
    );
    return res.rows.map((r) => ({
      role: r.role,
      heure: r.heure.toISOString(),
      maxOctets: Number(r.max_octets),
      limiteOctets: r.limite_octets === null ? null : Number(r.limite_octets),
    }));
  }

  async purgeOlderThan(jours: number): Promise<number> {
    const res = await this.pool.query(
      `delete from memoire_workers where heure < now() - make_interval(days => $1::int)`,
      [Math.max(1, Math.floor(jours))],
    );
    return res.rowCount ?? 0;
  }
}
