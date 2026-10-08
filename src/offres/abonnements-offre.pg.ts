import type { Pool } from 'pg';
import { enTransaction } from '../db/transaction';
import { VERROU_NUMERO_PRO_SQL } from '../numero/verrou-numero-pro';

/**
 * L'ABONNEMENT PRO D'UN ESPACE (lot 6, livraison B1, tâche 11, migration 0218). Écrit par le seul webhook signé de Stripe ;
 * l'offre de l'espace se calcule dessus (`offre_de_l_espace` : Pro tant qu'un abonnement est vivant, `fini_le` nul). Même
 * conduite que l'abonnement du numéro (`src/stripe/abonnements.pg.ts`) : rejouer un événement ne duplique rien (clé =
 * l'abonnement Stripe), l'ordre d'arrivée ne change pas l'état final, et un abonnement fini le reste (un événement en
 * retard ne le ressuscite jamais).
 */
export type PeriodiciteOffre = 'mois' | 'an';
export type StatutOffre = 'actif' | 'en_retard' | 'resilie';
export type RaisonFinOffre = 'resiliation' | 'impaye';

export interface AbonnementOffre {
  abonnementId: string;
  tenantId: string;
  periodicite: PeriodiciteOffre;
  livemode: boolean;
  statut: StatutOffre;
  periodeFin: Date | null;
  finPrevueLe: Date | null;
  finiLe: Date | null;
  finRaison: RaisonFinOffre | null;
  /** Le client rend son numéro fourni à la fin de ce Pro (0220, B2b) : il n'est pas recréé, il suit le lot 4. */
  rendreNumero: boolean;
  /** L'e-mail qui annonce la suite du numéro à la fin prévue est parti (0220, B2b) ; `null` sinon. */
  suiteAnnonceeLe: Date | null;
}

/**
 * Ce que l'enregistrement a produit. `doublon` : l'espace a déjà un AUTRE Pro vivant (deux paiements ouverts en même
 * temps, l'index `abonnements_offre_un_vivant_par_espace`) ; rien n'est écrit, Julien l'annule chez Stripe. `fini` : un
 * événement en retard pour un abonnement déjà fini, rien ne change.
 */
export type IssueEnregistrementPro = { etat: 'enregistre'; tenantId: string; nouveau: boolean } | { etat: 'doublon' } | { etat: 'fini' };

interface Ligne {
  stripe_subscription_id: string;
  tenant_id: string;
  periodicite: PeriodiciteOffre;
  livemode: boolean;
  statut: StatutOffre;
  periode_fin: Date | null;
  fin_prevue_le: Date | null;
  fini_le: Date | null;
  fin_raison: RaisonFinOffre | null;
  rendre_numero: boolean;
  suite_annoncee_le: Date | null;
}
const COLONNES = 'stripe_subscription_id, tenant_id, periodicite, livemode, statut, periode_fin, fin_prevue_le, fini_le, fin_raison, '
  + 'rendre_numero, suite_annoncee_le';
const versAbonnement = (l: Ligne): AbonnementOffre => ({
  abonnementId: l.stripe_subscription_id, tenantId: l.tenant_id, periodicite: l.periodicite, livemode: l.livemode, statut: l.statut,
  periodeFin: l.periode_fin, finPrevueLe: l.fin_prevue_le, finiLe: l.fini_le, finRaison: l.fin_raison,
  rendreNumero: l.rendre_numero, suiteAnnonceeLe: l.suite_annoncee_le,
});

export class PgAbonnementsOffreStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Le paiement est confirmé (`checkout.session.completed`, ou une première facture payée arrivée avant) : l'espace passe
   * en Pro. Rejoué : la fin de période ne recule jamais, et un abonnement fini le reste. `nouveau` dit si la ligne vient
   * d'être créée (l'alerte « nouveau Pro » ne part qu'une fois).
   */
  async enregistrer(a: { tenantId: string; abonnementId: string; periodicite: PeriodiciteOffre; livemode: boolean; periodeFin: Date | null }): Promise<IssueEnregistrementPro> {
    for (let essai = 0; ; essai += 1) {
      try {
        return await this.enregistrerUneFois(a);
      } catch (err) {
        const e = err as { code?: unknown; constraint?: unknown };
        if (e.code !== '23505' || e.constraint !== 'abonnements_offre_un_vivant_par_espace') throw err;
        // 🟡 La session et la première facture du MÊME abonnement arrivent ensemble (jaune 1 de la relecture de B1, comme
        // le jaune 4 du numéro) : l'index d'espace, qui n'arbitre pas le `on conflict`, peut refuser la seconde avant que
        // la clé primaire ne la voie. Si la ligne de CET abonnement existe, ce n'est pas un doublon : un seul nouvel
        // essai, qui passe par la mise à jour. Sinon, un AUTRE Pro vivant tient l'espace.
        if (essai > 0 || !(await this.existe(a.abonnementId))) return { etat: 'doublon' };
      }
    }
  }

  private async existe(abonnementId: string): Promise<boolean> {
    const res = await this.pool.query(`select 1 from abonnements_offre where stripe_subscription_id = $1`, [abonnementId]);
    return (res.rowCount ?? 0) > 0;
  }

  private async enregistrerUneFois(
    a: { tenantId: string; abonnementId: string; periodicite: PeriodiciteOffre; livemode: boolean; periodeFin: Date | null },
  ): Promise<IssueEnregistrementPro> {
    // J2 (lot 6, B2b) : le verrou d'espace commun avec la libération du numéro (`src/numero/verrou-numero-pro.ts`), sur
    // l'espace de l'événement ; un rejeu sur un autre espace ne ferait que prendre un verrou de trop.
    const res = await enTransaction(this.pool, async (client) => {
      await client.query(VERROU_NUMERO_PRO_SQL, [a.tenantId]);
      return client.query<{ tenant_id: string; fini_le: Date | null; nouveau: boolean }>(
        `insert into abonnements_offre (stripe_subscription_id, tenant_id, periodicite, livemode, statut, periode_fin)
         values ($1, $2, $3, $4, 'actif', $5)
         on conflict (stripe_subscription_id) do update
           set periode_fin = greatest(abonnements_offre.periode_fin, excluded.periode_fin), maj_le = now()
         returning tenant_id, fini_le, (xmax = 0) as nouveau`,
        [a.abonnementId, a.tenantId, a.periodicite, a.livemode, a.periodeFin],
      );
    });
    const l = res.rows[0]!;
    if (l.fini_le !== null) return { etat: 'fini' };
    // L'espace de la ligne, jamais celui de l'événement rejoué : un abonnement appartient à son premier espace.
    return { etat: 'enregistre', tenantId: l.tenant_id, nouveau: l.nouveau };
  }

  /**
   * Un renouvellement payé ou un échec : le statut et la fin de période (qui ne recule jamais). Un abonnement fini ne
   * change plus. 🔴 `finFactureEchouee` : un échec dont la période est DÉJÀ payée est un rejeu arrivé après le paiement
   * (Stripe ne garantit pas l'ordre) : rien n'est écrit, `null` comme pour un abonnement inconnu.
   */
  async majStatut(
    abonnementId: string, statut: 'actif' | 'en_retard', periodeFin: Date | null, finFactureEchouee: Date | null = null,
  ): Promise<AbonnementOffre | null> {
    const res = await this.pool.query<Ligne>(
      `update abonnements_offre
          set statut = $2, periode_fin = greatest(periode_fin, $3), maj_le = now()
        where stripe_subscription_id = $1 and fini_le is null
          and not ($2 = 'en_retard' and $4::timestamptz is not null and periode_fin is not null and periode_fin >= $4::timestamptz)
        returning ${COLONNES}`,
      [abonnementId, statut, periodeFin, finFactureEchouee],
    );
    return res.rows[0] ? versAbonnement(res.rows[0]) : null;
  }

  /**
   * Une modification (`customer.subscription.updated`) : la résiliation programmée posée ou retirée, et la périodicité
   * (relue sur le prix, si le portail ouvre un jour le changement de formule, fermé aujourd'hui). Un abonnement fini ne
   * change plus. Une fin retirée efface l'annonce de la suite du numéro (B2b) : reposée, elle s'annonce de nouveau.
   */
  async modifier(abonnementId: string, m: { finPrevueLe: Date | null; periodicite: PeriodiciteOffre | null }): Promise<AbonnementOffre | null> {
    const res = await this.pool.query<Ligne>(
      `update abonnements_offre
          set fin_prevue_le = $2, periodicite = coalesce($3, periodicite),
              suite_annoncee_le = case when $2::timestamptz is null then null else suite_annoncee_le end, maj_le = now()
        where stripe_subscription_id = $1 and fini_le is null
        returning ${COLONNES}`,
      [abonnementId, m.finPrevueLe, m.periodicite],
    );
    return res.rows[0] ? versAbonnement(res.rows[0]) : null;
  }

  /**
   * RENDRE LE NUMÉRO À LA FIN DU PRO (lot 6, B2b, décision de Julien du 2026-10-07) : posé ou retiré sur le Pro VIVANT de
   * l'espace, tant qu'il court. `false` : aucun Pro vivant (rien à rendre « à la fin »). À la fin du Pro, un numéro rendu
   * n'est pas recréé en numéro seul : il suit le chemin du lot 4 (`src/offres/numero-inclus.ts`).
   */
  async rendreLeNumero(tenantId: string, rendre: boolean): Promise<boolean> {
    const res = await this.pool.query(
      `update abonnements_offre set rendre_numero = $2, maj_le = now() where tenant_id = $1 and fini_le is null`,
      [tenantId, rendre],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * La suite du numéro fourni que le Pro vivant de l'espace annonce (B2b) : sa fin prévue et le choix de rendre. `null`
   * sans Pro vivant ou sans numéro fourni attribué : rien à annoncer. Lue par la vue de l'offre et le rappel de Claude.
   */
  async suiteDuNumero(tenantId: string): Promise<{ finPrevueLe: Date | null; rendreNumero: boolean } | null> {
    const res = await this.pool.query<{ fin_prevue_le: Date | null; rendre_numero: boolean }>(
      `select o.fin_prevue_le, o.rendre_numero from abonnements_offre o
        where o.tenant_id = $1 and o.fini_le is null
          and exists (select 1 from numeros_fournis n where n.tenant_id = o.tenant_id and n.statut = 'attribue')`,
      [tenantId],
    );
    const l = res.rows[0];
    return l ? { finPrevueLe: l.fin_prevue_le, rendreNumero: l.rendre_numero } : null;
  }

  /**
   * Les Pro dont la suite du numéro est à annoncer par e-mail (B2b) : vivants, fin prévue, numéro fourni attribué et
   * gardé, pas encore annoncés. Lu par le balayage des abonnements du worker, toutes les 15 minutes.
   */
  async aAnnoncer(): Promise<Array<{ tenantId: string; abonnementId: string; finPrevueLe: Date }>> {
    const res = await this.pool.query<{ tenant_id: string; stripe_subscription_id: string; fin_prevue_le: Date }>(
      `select o.tenant_id, o.stripe_subscription_id, o.fin_prevue_le from abonnements_offre o
        where o.fini_le is null and o.fin_prevue_le is not null and o.suite_annoncee_le is null and not o.rendre_numero
          and exists (select 1 from numeros_fournis n where n.tenant_id = o.tenant_id and n.statut = 'attribue')
        order by o.fin_prevue_le`,
    );
    return res.rows.map((r) => ({ tenantId: r.tenant_id, abonnementId: r.stripe_subscription_id, finPrevueLe: r.fin_prevue_le }));
  }

  /** L'annonce est partie (B2b) : notée une fois par fin prévue. `false` : déjà notée, ou plus rien à annoncer. */
  async noterAnnonce(abonnementId: string): Promise<boolean> {
    const res = await this.pool.query(
      `update abonnements_offre set suite_annoncee_le = now(), maj_le = now()
        where stripe_subscription_id = $1 and fini_le is null and fin_prevue_le is not null and suite_annoncee_le is null`,
      [abonnementId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * La fin effective (`customer.subscription.deleted`) : l'espace revient en Base. Datée et raisonnée UNE fois : un rejeu
   * ne déplace ni la date ni la raison. Rend l'abonnement, `null` s'il est inconnu. `premiereFin` dit si CET appel l'a
   * fini (jaune 11 de la relecture de B1) : un rejeu de `customer.subscription.deleted` ne réalerte pas. Lue sur l'état
   * d'avant, verrouillé, pour que deux fins concurrentes ne se croient pas toutes deux premières.
   */
  async finir(abonnementId: string, raison: RaisonFinOffre, finiLe: Date): Promise<(AbonnementOffre & { premiereFin: boolean }) | null> {
    const res = await this.pool.query<Ligne & { premiere_fin: boolean }>(
      `with avant as (select fini_le as fini_avant from abonnements_offre where stripe_subscription_id = $1 for update)
       update abonnements_offre
          set statut = 'resilie', fini_le = coalesce(fini_le, $3), fin_raison = coalesce(fin_raison, $2), maj_le = now()
        where stripe_subscription_id = $1
        returning ${COLONNES}, (select fini_avant from avant) is null as premiere_fin`,
      [abonnementId, raison, finiLe],
    );
    const l = res.rows[0];
    return l ? { ...versAbonnement(l), premiereFin: l.premiere_fin } : null;
  }

  /** L'espace a-t-il un Pro vivant ? (le paiement le renvoie alors au portail). */
  async vivant(tenantId: string): Promise<boolean> {
    const res = await this.pool.query(`select 1 from abonnements_offre where tenant_id = $1 and fini_le is null`, [tenantId]);
    return (res.rowCount ?? 0) > 0;
  }

  /** Le Pro de l'espace : le vivant s'il y en a un, sinon le dernier fini ; `null` s'il n'en a jamais eu. */
  async deLEspace(tenantId: string): Promise<AbonnementOffre | null> {
    const res = await this.pool.query<Ligne>(
      `select ${COLONNES} from abonnements_offre where tenant_id = $1 order by (fini_le is null) desc, cree_le desc limit 1`,
      [tenantId],
    );
    return res.rows[0] ? versAbonnement(res.rows[0]) : null;
  }
}
