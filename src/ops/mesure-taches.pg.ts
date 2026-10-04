import type { Pool } from 'pg';
import type { LigneTache, MesureTaches, TacheMesureRow } from './mesure-taches';

/** Le plus grand `integer` de Postgres. */
const INT_MAX = 2_147_483_647;
const borne = (n: number): number => Math.min(Math.round(n), INT_MAX);

/**
 * Les mesures des tâches de fond, écrites et relues (`db/migrations/0207_taches_mesures.sql`). Au mieux dans les
 * deux sens : une écriture en échec se réinjecte, une lecture en échec rend l'écran sans la carte.
 */
export class PgMesuresTachesStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Écrit un vidage dans son heure, en UNE instruction. `on conflict` additionne : soixante vidages tombent dans la
   * même heure. Triées par tâche, pour que deux écritures concurrentes prennent leurs verrous dans le même ordre.
   */
  async enregistrer(processus: string, fenetre: Date, entree: LigneTache[]): Promise<void> {
    if (entree.length === 0) return;
    const lignes = [...entree].sort((a, b) => (a.tache < b.tache ? -1 : a.tache > b.tache ? 1 : 0));
    await this.pool.query(
      `insert into taches_mesures (fenetre, process, tache, passes, echecs, sautees, somme_ms, max_ms, lignes, max_lignes)
       select $1, $2, l.tache, l.passes, l.echecs, l.sautees, l.somme_ms, l.max_ms, l.lignes, l.max_lignes
         from unnest($3::text[], $4::integer[], $5::integer[], $6::integer[], $7::bigint[], $8::integer[], $9::bigint[], $10::integer[])
              as l(tache, passes, echecs, sautees, somme_ms, max_ms, lignes, max_lignes)
       on conflict (fenetre, process, tache) do update set
         passes = taches_mesures.passes + excluded.passes,
         echecs = taches_mesures.echecs + excluded.echecs,
         sautees = taches_mesures.sautees + excluded.sautees,
         somme_ms = taches_mesures.somme_ms + excluded.somme_ms,
         max_ms = greatest(taches_mesures.max_ms, excluded.max_ms),
         lignes = case when taches_mesures.lignes is null and excluded.lignes is null then null
                       else coalesce(taches_mesures.lignes, 0) + coalesce(excluded.lignes, 0) end,
         max_lignes = greatest(taches_mesures.max_lignes, excluded.max_lignes)`,
      [
        fenetre,
        processus,
        lignes.map((l) => l.tache),
        lignes.map((l) => borne(l.passes)),
        lignes.map((l) => borne(l.echecs)),
        lignes.map((l) => borne(l.sautees)),
        lignes.map((l) => Math.round(l.sommeMs)),
        // Bornés à la capacité d'un `integer` : une valeur hors limites ferait échouer CHAQUE vidage, réinjecté sans fin.
        lignes.map((l) => borne(l.maxMs)),
        lignes.map((l) => (l.lignes === null ? null : Math.round(l.lignes))),
        lignes.map((l) => (l.maxLignes === null ? null : borne(l.maxLignes))),
      ],
    );
  }

  /** Les `heures` dernières heures, agrégées par processus et par tâche. */
  async lire(heures: number): Promise<TacheMesureRow[]> {
    const res = await this.pool.query<{
      process: string; tache: string; passes: string; echecs: string; sautees: string; somme_ms: string; max_ms: number;
      lignes: string | null; max_lignes: number | null; derniere: Date;
    }>(
      `select process, tache, sum(passes)::text as passes, sum(echecs)::text as echecs, sum(sautees)::text as sautees,
              sum(somme_ms)::text as somme_ms,
              max(max_ms) as max_ms, sum(lignes)::text as lignes, max(max_lignes) as max_lignes, max(fenetre) as derniere
         from taches_mesures
        where fenetre > now() - make_interval(hours => $1::int)
        group by process, tache
        order by max(max_ms) desc, tache`,
      [Math.max(1, Math.min(Math.floor(heures), 24 * 7))],
    );
    return res.rows.map((r) => ({
      process: r.process,
      tache: r.tache,
      passes: Number(r.passes),
      echecs: Number(r.echecs),
      sautees: Number(r.sautees),
      sommeMs: Number(r.somme_ms),
      maxMs: r.max_ms,
      lignes: r.lignes === null ? null : Number(r.lignes),
      maxLignes: r.max_lignes,
      derniere: r.derniere.toISOString(),
    }));
  }

  async purgeOlderThan(jours: number): Promise<number> {
    const res = await this.pool.query(
      `delete from taches_mesures where fenetre < now() - make_interval(days => $1::int)`,
      [Math.max(1, Math.floor(jours))],
    );
    return res.rowCount ?? 0;
  }
}

/** Le début de l'heure qui contient `instant`. */
export function heureDe(instant: Date): Date {
  const f = new Date(instant);
  f.setUTCMinutes(0, 0, 0);
  return f;
}

/** Le vidage périodique : rien à écrire au repos (`false`), une écriture en échec réinjecte ses lignes. */
export async function viderMesuresTachesVersLaBase(
  store: { enregistrer(processus: string, fenetre: Date, lignes: LigneTache[]): Promise<void> },
  mesure: MesureTaches,
  processus: string,
  maintenant: Date,
  onErreur?: (err: unknown) => void,
): Promise<boolean> {
  const lignes = mesure.vider();
  if (lignes.length === 0) return false;
  try {
    await store.enregistrer(processus, heureDe(maintenant), lignes);
    return true;
  } catch (err) {
    onErreur?.(err);
    mesure.reinjecter(lignes);
    return false;
  }
}
