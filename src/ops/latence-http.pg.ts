import type { Pool } from 'pg';
import { versLigneOps, type LatenceHttpRow, type LigneLatence, type MesureLatenceHttp } from './latence-http';

/** Le plus grand `integer` de Postgres. */
const INT_MAX = 2_147_483_647;

/**
 * La latence HTTP, écrite et relue (`db/migrations/0205_http_latences.sql`). Tout est au mieux, dans les deux sens :
 * une écriture en échec se réinjecte, une lecture en échec rend l'écran sans la carte.
 */
export class PgHttpLatencesStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Écrit les lignes d'un vidage dans leur fenêtre, en UNE instruction. `on conflict` additionne tranche à tranche
   * au lieu de remplacer : plusieurs vidages tombent dans la même fenêtre de cinq minutes. Les clés d'un vidage sont
   * uniques (la mesure les tient dans une `Map`), condition d'un `on conflict` sur plusieurs lignes. Triées par clé :
   * deux écritures concurrentes sur les mêmes clés (deux copies sous le même nom, un vidage qui déborde la minute)
   * prennent alors leurs verrous dans le même ordre, et ne peuvent pas s'interbloquer.
   */
  async enregistrer(processus: string, fenetre: Date, entree: LigneLatence[]): Promise<void> {
    if (entree.length === 0) return;
    const cle = (l: LigneLatence): string => `${l.methode} ${l.code} ${l.route}`;
    const lignes = [...entree].sort((a, b) => (cle(a) < cle(b) ? -1 : cle(a) > cle(b) ? 1 : 0));
    await this.pool.query(
      `insert into http_latences (fenetre, process, methode, route, code, seaux, somme_ms, max_ms)
       select $1, $2, l.methode, l.route, l.code, l.seaux::integer[], l.somme_ms, l.max_ms
         from unnest($3::text[], $4::text[], $5::smallint[], $6::text[], $7::bigint[], $8::integer[])
              as l(methode, route, code, seaux, somme_ms, max_ms)
       on conflict (fenetre, process, methode, route, code) do update set
         seaux = array(
           select coalesce(a, 0) + coalesce(b, 0)
             from unnest(http_latences.seaux, excluded.seaux) with ordinality as t(a, b, i)
            order by t.i),
         somme_ms = http_latences.somme_ms + excluded.somme_ms,
         max_ms = greatest(http_latences.max_ms, excluded.max_ms)`,
      [
        fenetre,
        processus,
        lignes.map((l) => l.methode),
        lignes.map((l) => l.route),
        lignes.map((l) => l.code),
        // Un tableau par ligne voyage en littéral (`{1,0,3}`) : un tableau de tableaux serait aplati par `unnest`.
        lignes.map((l) => `{${l.seaux.map((n) => Math.round(n)).join(',')}}`),
        lignes.map((l) => Math.round(l.sommeMs)),
        // Borné à la capacité d'un `integer` : une valeur hors limites ferait échouer CHAQUE vidage, réinjecté sans fin.
        lignes.map((l) => Math.min(Math.round(l.maxMs), INT_MAX)),
      ],
    );
  }

  /** Les `heures` dernières heures, agrégées par méthode, route et code, toutes copies et fenêtres confondues. */
  async lire(heures: number): Promise<LatenceHttpRow[]> {
    const res = await this.pool.query<{ methode: string; route: string; code: number; seaux: string[]; somme_ms: string; max_ms: number }>(
      `with fen as (
         select * from http_latences where fenetre > now() - make_interval(hours => $1::int)
       ), totaux as (
         select methode, route, code, sum(somme_ms) as somme_ms, max(max_ms) as max_ms
           from fen group by methode, route, code
       ), par_tranche as (
         select methode, route, code, t.i, sum(t.n) as n
           from fen cross join lateral unnest(fen.seaux) with ordinality as t(n, i)
          group by methode, route, code, t.i
       )
       select tot.methode, tot.route, tot.code, tot.somme_ms::text, tot.max_ms,
              array_agg(p.n::text order by p.i) as seaux
         from totaux tot join par_tranche p using (methode, route, code)
        group by tot.methode, tot.route, tot.code, tot.somme_ms, tot.max_ms`,
      [Math.max(1, Math.min(Math.floor(heures), 24 * 7))],
    );
    return res.rows.map((r) => versLigneOps({
      methode: r.methode,
      route: r.route,
      code: r.code,
      seaux: r.seaux.map(Number),
      sommeMs: Number(r.somme_ms),
      maxMs: r.max_ms,
    }));
  }

  async purgeOlderThan(jours: number): Promise<number> {
    const res = await this.pool.query(
      `delete from http_latences where fenetre < now() - make_interval(days => $1::int)`,
      [Math.max(1, Math.floor(jours))],
    );
    return res.rowCount ?? 0;
  }
}

/** Le début de la fenêtre de cinq minutes qui contient `instant`. */
export function fenetreDe(instant: Date): Date {
  const f = new Date(instant);
  f.setUTCMinutes(f.getUTCMinutes() - (f.getUTCMinutes() % 5), 0, 0);
  return f;
}

/**
 * Le vidage périodique, pendant de `viderVersLaBase` pour le pool : rien à écrire au repos (`false`), et une
 * écriture en échec ne remonte pas, ses lignes sont reprises (la minute perdue serait celle où ça allait mal).
 */
export async function viderLatencesVersLaBase(
  store: { enregistrer(processus: string, fenetre: Date, lignes: LigneLatence[]): Promise<void> },
  mesure: MesureLatenceHttp,
  processus: string,
  maintenant: Date,
  onErreur?: (err: unknown) => void,
): Promise<boolean> {
  const lignes = mesure.vider();
  if (lignes.length === 0) return false;
  try {
    await store.enregistrer(processus, fenetreDe(maintenant), lignes);
    return true;
  } catch (err) {
    onErreur?.(err);
    mesure.reinjecter(lignes);
    return false;
  }
}
