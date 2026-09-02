import type { Pool } from 'pg';
import type { MesureAttentePool, SeauAttente } from '../db/attente-pool';

/**
 * L'ATTENTE DU POOL, ÉCRITE ET RELUE (lot 7 du plan post-audit, migration 0109).
 *
 * 🔴 Cette table est le SEUL canal par lequel le worker peut se montrer : `/ops` est servi par l'API, qui voit
 * son propre pool en mémoire et jamais celui du worker. Sans elle, la moitié de la mesure serait invisible.
 *
 * ⚠️ Tout est best-effort ici, dans les deux sens. Une mesure ne doit JAMAIS faire tomber ce qu'elle mesure :
 * ni l'écriture (qui tourne dans un process en train de servir des clients), ni la lecture (qui alimente un
 * écran d'exploitation dont le reste doit continuer de s'afficher).
 */

export interface PointAttente {
  process: string;
  minute: string;
  echantillons: number;
  attentes: number;
  maxMs: number;
  /** 🔴 Le maximum des seules acquisitions faites sur un pool SATURE. C'est LUI qui alarme, jamais `maxMs`. */
  maxAttenteMs: number;
  /** Moyenne dérivée de la somme : la garder en base serait une seconde vérité à recalculer. */
  moyenneMs: number;
}

export class PgPoolAttentesStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Écrit le seau d'une minute. `on conflict` en ADDITION et non en remplacement : deux vidages dans la même
   * minute (un redémarrage, un balayage qui se chevauche) doivent s'ajouter, sinon le premier disparaîtrait.
   * Le maximum, lui, se combine par `greatest` : c'est la seule façon correcte de fusionner deux pics.
   */
  async enregistrer(processus: string, minute: Date, seau: SeauAttente): Promise<void> {
    await this.pool.query(
      `insert into pool_attentes (process, minute, echantillons, attentes, max_ms, max_attente_ms, somme_ms)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (process, minute) do update set
         echantillons = pool_attentes.echantillons + excluded.echantillons,
         attentes = pool_attentes.attentes + excluded.attentes,
         max_ms = greatest(pool_attentes.max_ms, excluded.max_ms),
         max_attente_ms = greatest(pool_attentes.max_attente_ms, excluded.max_attente_ms),
         somme_ms = pool_attentes.somme_ms + excluded.somme_ms`,
      [processus, minute, seau.echantillons, seau.attentes, Math.round(seau.maxMs), Math.round(seau.maxAttenteMs), Math.round(seau.sommeMs)],
    );
  }

  /** Les dernières minutes, du plus ancien au plus récent (l'ordre où une courbe se dessine). */
  async lireDernieresMinutes(minutes = 180): Promise<PointAttente[]> {
    const res = await this.pool.query<{
      process: string; minute: Date; echantillons: string; attentes: string; max_ms: string; max_attente_ms: string; somme_ms: string;
    }>(
      `select process, minute, echantillons::text, attentes::text, max_ms::text, max_attente_ms::text, somme_ms::text
         from pool_attentes
        where minute > now() - make_interval(mins => $1::int)
        order by minute asc`,
      [Math.max(1, Math.min(minutes, 1440))],
    );
    return res.rows.map((r) => {
      const echantillons = Number(r.echantillons);
      return {
        process: r.process,
        minute: r.minute.toISOString(),
        echantillons,
        attentes: Number(r.attentes),
        maxMs: Number(r.max_ms),
        maxAttenteMs: Number(r.max_attente_ms),
        moyenneMs: echantillons === 0 ? 0 : Number(r.somme_ms) / echantillons,
      };
    });
  }

  /** Purge de rétention. De l'exploitation, pas une preuve : ça ne se garde pas indéfiniment. */
  async purgeOlderThan(jours: number): Promise<number> {
    const res = await this.pool.query(
      `delete from pool_attentes where minute < now() - make_interval(days => $1::int)`,
      [Math.max(1, Math.floor(jours))],
    );
    return res.rowCount ?? 0;
  }
}

/**
 * Le vidage périodique : prend le seau du process et l'écrit. Renvoie `false` quand rien n'a été écrit (seau
 * vide), ce qui évite une ligne par minute sur un process au repos.
 *
 * ⚠️ Best-effort : une écriture en échec ne doit jamais remonter. Le seau est REPRIS dans ce cas, sinon une
 * panne de base ferait perdre la minute, c'est-à-dire précisément la minute où quelque chose n'allait pas.
 */
export async function viderVersLaBase(
  store: { enregistrer(processus: string, minute: Date, seau: SeauAttente): Promise<void> },
  mesure: MesureAttentePool,
  processus: string,
  maintenant: Date,
  onErreur?: (err: unknown) => void,
): Promise<boolean> {
  const seau = mesure.vider();
  if (seau.echantillons === 0) return false;
  const minute = new Date(maintenant);
  minute.setSeconds(0, 0);
  try {
    // 🔴 SANS SE MESURER : cette ecriture passe par le pool instrumente, elle deviendrait sinon le premier
    // echantillon de la minute suivante et la telemetrie s'auto-alimenterait.
    await mesure.sansSeMesurer(() => store.enregistrer(processus, minute, seau));
    return true;
  } catch (err) {
    onErreur?.(err);
    // On REMET le seau entier : la minute perdue serait justement celle où ça allait mal. Fusionné, jamais
    // réinjecté comme une acquisition unique, ce qui perdrait tout sauf le pic.
    mesure.reinjecter(seau);
    return false;
  }
}
