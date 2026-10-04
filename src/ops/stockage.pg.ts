import type { Pool } from 'pg';

/**
 * LES OCTETS EN BASE (audit de performance du 2026-10-02, § 9 : « le principal risque de croissance silencieuse »).
 *
 * Trois familles de fichiers vivent dans Postgres, chacune bornée à l'unité mais sans limite de cumul : les images
 * RCS (`rcs_media.bytes`, 2 Mo au plus), les visuels des brouillons de publicité (`pubs_brouillons.visuel_octets`,
 * 5 Mo au plus) et les images des Flows, en base64 dans le JSON (`flows.elements`, environ 300 Ko par image). Elles
 * grossissent la base, ses sauvegardes et ses migrations sans que rien ne le montre : cette mesure le montre, et
 * dit quand décider de les sortir vers un stockage objet.
 *
 * ⚠️ COÛTEUSE À L'ÉCHELLE DE `/ops` : la taille de chaque table se calcule en parcourant le catalogue (environ une
 * demi-seconde mesurée le 2026-10-04). Elle est donc servie par sa propre route, lue une fois à l'ouverture de
 * l'écran, et jamais avec la vue d'ensemble. `octet_length` sur un `bytea` lit la taille dans l'en-tête de la valeur
 * sans la décompresser : les octets eux-mêmes ne sont jamais chargés.
 *
 * ⚠️ DEUX UNITÉS, ET L'ÉCRAN LE DIT : les images RCS et les visuels de pub sont comptés en taille BRUTE
 * (`octet_length`, une image ne se compresse guère) ; les Flows en taille STOCKÉE, compression comprise
 * (`pg_column_size`), parce que mesurer la taille brute d'un JSON obligerait à le décompresser en entier.
 */

/** Au-delà, l'écran passe en rouge : il est temps de sortir les fichiers de la base (audit, lot 4). */
export const SEUIL_FICHIERS_EN_BASE_OCTETS = 500 * 1024 * 1024;

export type FamilleFichiers = 'rcs' | 'pubs' | 'flows';

export interface MesureStockage {
  /** Taille de toute la base, tables, index et TOAST compris. */
  baseOctets: number;
  /** Les fichiers, famille par famille : combien, combien d'octets utiles, combien sur disque (table entière). */
  familles: Array<{ famille: FamilleFichiers; elements: number; octets: number; disqueOctets: number }>;
  /** Les plus grosses tables, tous schémas confondus : ce qui pèse vraiment, fichiers ou non. */
  tables: Array<{ table: string; octets: number }>;
  mesureLe: string;
}

export class PgStockageStore {
  constructor(private readonly pool: Pool) {}

  async mesurer(): Promise<MesureStockage> {
    const [base, tables, rcs, pubs, flows] = await Promise.all([
      this.pool.query<{ n: string }>('select pg_database_size(current_database())::text as n'),
      this.pool.query<{ t: string; n: string }>(
        `select n.nspname || '.' || c.relname as t, pg_total_relation_size(c.oid)::text as n
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.relkind = 'r' and n.nspname not in ('pg_catalog', 'information_schema')
          order by pg_total_relation_size(c.oid) desc limit 8`,
      ),
      this.pool.query<{ n: number; octets: string; disque: string }>(
        `select count(*)::int as n, coalesce(sum(octet_length(bytes)), 0)::text as octets,
                pg_total_relation_size('rcs_media')::text as disque from rcs_media`,
      ),
      this.pool.query<{ n: number; octets: string; disque: string }>(
        `select count(*) filter (where visuel_octets is not null)::int as n,
                coalesce(sum(octet_length(visuel_octets)), 0)::text as octets,
                pg_total_relation_size('pubs_brouillons')::text as disque from pubs_brouillons`,
      ),
      // Le JSON entier compte, pas seulement les images : c'est ce que la colonne coûte vraiment, et les images en
      // sont l'essentiel dès qu'il y en a.
      this.pool.query<{ n: number; octets: string; disque: string }>(
        `select count(*) filter (where elements is not null)::int as n,
                coalesce(sum(pg_column_size(elements)), 0)::text as octets,
                pg_total_relation_size('flows')::text as disque from flows`,
      ),
    ]);
    const famille = (f: FamilleFichiers, r: { n: number; octets: string; disque: string } | undefined) => ({
      famille: f, elements: r?.n ?? 0, octets: Number(r?.octets ?? 0), disqueOctets: Number(r?.disque ?? 0),
    });
    return {
      baseOctets: Number(base.rows[0]?.n ?? 0),
      familles: [famille('rcs', rcs.rows[0]), famille('pubs', pubs.rows[0]), famille('flows', flows.rows[0])],
      tables: tables.rows.map((r) => ({ table: r.t, octets: Number(r.n) })),
      mesureLe: new Date().toISOString(),
    };
  }
}
