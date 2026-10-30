import type { Pool } from 'pg';
import { grillePerimee, normaliserCategorie, type GrilleMeta, type TarifGrille } from './grille';

/**
 * LES RÉGLAGES DU CRÉDIT WHATSAPP POSÉS DANS `/ops` (migration 0264) : la grille de Meta, datée, et la commission des
 * messages. La grille en vigueur est la dernière chargée dont la date est passée : Julien peut charger celle du
 * trimestre suivant dès que Meta la publie, elle prend effet seule à sa date.
 *
 * Lues avant CHAQUE envoi sur la ligne, elles sont gardées une minute par processus : un changement dans `/ops` vaut
 * tout de suite dans la copie qui l'a reçu, en moins d'une minute dans les autres.
 */
const CACHE_MS = 60_000;

/** La commission quand la ligne de réglage manque (la migration la pose) : jamais zéro, qui rendrait la marge nulle en silence. */
const COMMISSION_DEFAUT = 5;

export interface ResumeGrille {
  id: string;
  enVigueurLe: string;
  chargeeLe: string;
  chargeePar: string;
  note: string | null;
  tarifs: number;
  perimee: boolean;
  /** Une grille déjà chargée qui prendra effet plus tard, s'il y en a une. */
  prochaine: { enVigueurLe: string } | null;
}

export interface ChargementGrille {
  enVigueurLe: string;
  tarifs: readonly TarifGrille[];
  auteur: string;
  note: string;
}

export class PgCreditWhatsappReglagesStore {
  private grille: { lue: number; valeur: GrilleMeta | null } | null = null;
  private commissionLue: { lue: number; valeur: number } | null = null;

  constructor(private readonly pool: Pool, private readonly maintenant: () => Date = () => new Date()) {}

  async grilleEnVigueur(): Promise<GrilleMeta | null> {
    const t = this.maintenant().getTime();
    if (this.grille !== null && t - this.grille.lue < CACHE_MS) return this.grille.valeur;
    const { rows } = await this.pool.query<{ id: string; en_vigueur_le: string }>(
      `select id, en_vigueur_le::text as en_vigueur_le from grilles_meta
        where en_vigueur_le <= current_date order by en_vigueur_le desc, chargee_le desc limit 1`,
    );
    let valeur: GrilleMeta | null = null;
    const g = rows[0];
    if (g !== undefined) {
      const tarifs = await this.pool.query<{ marche: string; categorie: string; palier: number; prix_micro_eur: string }>(
        'select marche, categorie, palier, prix_micro_eur from grille_meta_tarifs where grille_id = $1',
        [g.id],
      );
      valeur = {
        id: g.id,
        enVigueurLe: g.en_vigueur_le,
        tarifs: tarifs.rows.flatMap((r) => {
          const categorie = normaliserCategorie(r.categorie);
          return categorie === null ? [] : [{ marche: r.marche, categorie, palier: r.palier, prixMicroEur: Number(r.prix_micro_eur) }];
        }),
      };
    }
    this.grille = { lue: t, valeur };
    return valeur;
  }

  /** Charge une grille entière, en une transaction : une grille à moitié écrite ferait payer au hasard. */
  async chargerGrille(c: ChargementGrille): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const { rows } = await client.query<{ id: string }>(
        'insert into grilles_meta (en_vigueur_le, chargee_par, note) values ($1::date, $2, $3) returning id',
        [c.enVigueurLe, c.auteur, c.note],
      );
      const id = rows[0]!.id;
      await client.query(
        `insert into grille_meta_tarifs (grille_id, marche, categorie, palier, prix_micro_eur)
         select $1, u.marche, u.categorie, u.palier, u.prix
           from unnest($2::text[], $3::text[], $4::int[], $5::bigint[]) as u (marche, categorie, palier, prix)`,
        [id, c.tarifs.map((t) => t.marche), c.tarifs.map((t) => t.categorie), c.tarifs.map((t) => t.palier), c.tarifs.map((t) => String(t.prixMicroEur))],
      );
      await client.query('commit');
      this.grille = null;
      return id;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async resumeGrille(): Promise<ResumeGrille | null> {
    const { rows } = await this.pool.query<{
      id: string; en_vigueur_le: string; chargee_le: Date; chargee_par: string; note: string | null; tarifs: string; prochaine: string | null;
    }>(
      `select g.id, g.en_vigueur_le::text as en_vigueur_le, g.chargee_le, g.chargee_par, g.note,
              (select count(*) from grille_meta_tarifs t where t.grille_id = g.id) as tarifs,
              (select min(p.en_vigueur_le)::text from grilles_meta p where p.en_vigueur_le > current_date) as prochaine
         from grilles_meta g
        where g.en_vigueur_le <= current_date
        order by g.en_vigueur_le desc, g.chargee_le desc limit 1`,
    );
    const g = rows[0];
    if (g === undefined) return null;
    return {
      id: g.id,
      enVigueurLe: g.en_vigueur_le,
      chargeeLe: g.chargee_le.toISOString(),
      chargeePar: g.chargee_par,
      note: g.note,
      tarifs: Number(g.tarifs),
      perimee: grillePerimee(g.en_vigueur_le, this.maintenant()),
      prochaine: g.prochaine === null ? null : { enVigueurLe: g.prochaine },
    };
  }

  async commission(): Promise<number> {
    const t = this.maintenant().getTime();
    if (this.commissionLue !== null && t - this.commissionLue.lue < CACHE_MS) return this.commissionLue.valeur;
    const { rows } = await this.pool.query<{ commission_pct: number }>('select commission_pct from credit_whatsapp_reglages where id');
    const valeur = rows[0]?.commission_pct ?? COMMISSION_DEFAUT;
    this.commissionLue = { lue: t, valeur };
    return valeur;
  }

  /** `par` = la note signée (`noteSignee`) : qui a changé la commission, et pourquoi. */
  async reglerCommission(pct: number, par: string): Promise<void> {
    await this.pool.query(
      `insert into credit_whatsapp_reglages (id, commission_pct, modifie_le, modifie_par) values (true, $1, now(), $2)
       on conflict (id) do update set commission_pct = excluded.commission_pct, modifie_le = now(), modifie_par = excluded.modifie_par`,
      [pct, par],
    );
    this.commissionLue = null;
  }
}
