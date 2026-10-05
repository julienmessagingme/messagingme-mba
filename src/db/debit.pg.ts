import type { Pool } from 'pg';
import { debutDeFenetre, normaliserComptages, type CompteurDebit, type LigneCompteur, type VerdictDebit } from './debit';

/**
 * Les compteurs de débit en base (`compteurs_debit`, migration 0186). L'heure qui décide d'une fenêtre est celle de
 * la base : toutes les copies comptent dans la même ligne.
 *
 * UNE instruction par appel accepté. Le refus d'un appel à plusieurs fenêtres en coûte une seconde, qui rend ce que
 * les fenêtres non pleines avaient compté (toutes ou aucune) : le chemin des refus est aussi celui que la mémoire
 * des pleines (`memoireDesPleines`) épargne presque toujours.
 */
export class PgCompteurDebit implements CompteurDebit {
  constructor(private readonly pool: Pool) {}

  async compter(comptages: Parameters<CompteurDebit['compter']>[0]): Promise<VerdictDebit> {
    const demandes = normaliserComptages(comptages);
    const cles = demandes.map((c) => c.cle);
    const plafonds = demandes.map((c) => c.max);
    /**
     * Une ligne par fenêtre : une fenêtre neuve s'insère avec son pas, une fenêtre en cours ajoute le pas seulement
     * s'il tient sous son plafond (`do update ... where`), une fenêtre pleine ne rend aucune ligne. Deux appels
     * simultanés sur la même ligne se sérialisent sur l'index unique : le compte est exact. `order by cle` fixe
     * l'ordre des écritures, donc deux appels qui partagent des clés ne s'interbloquent pas (la purge verrouille dans
     * le même ordre). Le plafond d'une ligne se lit par sa position dans les tableaux de paramètres : une seule
     * instruction sert ainsi plusieurs plafonds. Un pas plus grand que le plafond ne s'insère même pas.
     * L'instruction rend toujours au moins une ligne, celle de l'heure de la base.
     */
    const res = await this.pool.query<{ maintenant_ms: number; cle: string | null; n: number | null; debut_ms: number | null }>(
      `with h as (select (extract(epoch from now()) * 1000)::float8 as ms),
       t as (
         select u.cle, u.duree, u.pas, u.maxi, u.garde, u.origine + floor((h.ms - u.origine) / u.duree) * u.duree as debut
         from unnest($1::text[], $2::float8[], $3::int[], $4::int[], $5::float8[], $6::float8[]) as u(cle, duree, pas, maxi, garde, origine), h
       ),
       compte as (
         insert into compteurs_debit as c (cle, fenetre, n, expire_le)
         select cle, to_timestamp(debut / 1000), pas, to_timestamp((debut + duree + garde) / 1000)
         from t
         where maxi is null or pas <= maxi
         order by cle
         on conflict (cle, fenetre) do update set n = c.n + excluded.n
           where ($4::int[])[array_position($1::text[], c.cle)] is null
              or c.n + excluded.n <= ($4::int[])[array_position($1::text[], c.cle)]
         returning c.cle, c.n, (extract(epoch from c.fenetre) * 1000)::float8 as debut_ms
       )
       select h.ms as maintenant_ms, compte.cle, compte.n, compte.debut_ms from h left join compte on true`,
      [cles, demandes.map((c) => c.dureeMs), demandes.map((c) => c.pas), plafonds, demandes.map((c) => c.garderMs), demandes.map((c) => c.origineMs ?? 0)],
    );
    const maintenantMs = Number(res.rows[0]?.maintenant_ms);
    const comptees = new Map<string, { n: number; debutMs: number }>();
    for (const r of res.rows) if (r.cle !== null) comptees.set(r.cle, { n: Number(r.n), debutMs: Number(r.debut_ms) });
    const accepte = comptees.size === demandes.length;
    if (!accepte && comptees.size > 0) {
      /**
       * Toutes ou aucune : ce que les fenêtres non pleines ont compté est rendu. Entre les deux instructions, un
       * appel concurrent peut voir une place de moins (quelques millisecondes, jamais une de plus) ; si le rendu
       * échoue, la fenêtre garde une unité de trop jusqu'à sa fin, jamais une place offerte en trop. Verrouillé dans
       * l'ordre des clés, comme l'écriture.
       */
      const rendre = demandes.filter((c) => comptees.has(c.cle));
      await this.pool.query(
        `with cibles as (
           select c.cle, c.fenetre, u.pas
           from compteurs_debit c
           join unnest($1::text[], $2::float8[], $3::int[]) as u(cle, debut, pas)
             on c.cle = u.cle and c.fenetre = to_timestamp(u.debut / 1000)
           order by c.cle
           for update of c
         )
         update compteurs_debit c set n = c.n - cibles.pas
         from cibles where c.cle = cibles.cle and c.fenetre = cibles.fenetre`,
        [rendre.map((c) => c.cle), rendre.map((c) => comptees.get(c.cle)!.debutMs), rendre.map((c) => c.pas)],
      );
    }
    return {
      accepte,
      maintenantMs,
      fenetres: demandes.map((c) => {
        const vue = comptees.get(c.cle);
        const debutMs = vue?.debutMs ?? debutDeFenetre(maintenantMs, c.dureeMs, c.origineMs ?? 0);
        return {
          cle: c.cle,
          max: c.max,
          pleine: vue === undefined,
          compte: vue === undefined ? null : accepte ? vue.n : vue.n - c.pas,
          finMs: debutMs + c.dureeMs,
        };
      }),
    };
  }

  async lister(prefixe: string, depuisMs: number): Promise<LigneCompteur[]> {
    const res = await this.pool.query<{ cle: string; debut_ms: number; n: number }>(
      `select cle, (extract(epoch from fenetre) * 1000)::float8 as debut_ms, n
       from compteurs_debit
       where starts_with(cle, $1) and fenetre >= now() - make_interval(secs => $2::float8 / 1000)
       order by fenetre desc`,
      [prefixe, depuisMs],
    );
    return res.rows.map((r) => ({ cle: r.cle, debutMs: Number(r.debut_ms), n: Number(r.n) }));
  }

  /**
   * Efface les lignes échues (tâche du worker). Une ligne échue ne compte plus pour aucune décision : l'effacer borne
   * seulement la table, où une tentative de connexion sur une adresse neuve écrit une ligne. Verrouillée dans l'ordre
   * des clés, comme les écritures : dans l'ordre physique, elle pourrait tenir une ligne qu'un appel attend pendant
   * qu'il en tient une qu'elle attend.
   */
  async purgerEchues(): Promise<number> {
    const res = await this.pool.query(
      `delete from compteurs_debit
       where (cle, fenetre) in (
         select cle, fenetre from compteurs_debit where expire_le <= now() order by cle, fenetre for update
       )`,
    );
    return res.rowCount ?? 0;
  }
}
