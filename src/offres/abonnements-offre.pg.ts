import type { Pool } from 'pg';

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
}
const COLONNES = 'stripe_subscription_id, tenant_id, periodicite, livemode, statut, periode_fin, fin_prevue_le, fini_le, fin_raison';
const versAbonnement = (l: Ligne): AbonnementOffre => ({
  abonnementId: l.stripe_subscription_id, tenantId: l.tenant_id, periodicite: l.periodicite, livemode: l.livemode, statut: l.statut,
  periodeFin: l.periode_fin, finPrevueLe: l.fin_prevue_le, finiLe: l.fini_le, finRaison: l.fin_raison,
});

export class PgAbonnementsOffreStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Le paiement est confirmé (`checkout.session.completed`, ou une première facture payée arrivée avant) : l'espace passe
   * en Pro. Rejoué : la fin de période ne recule jamais, et un abonnement fini le reste. `nouveau` dit si la ligne vient
   * d'être créée (l'alerte « nouveau Pro » ne part qu'une fois).
   */
  async enregistrer(a: { tenantId: string; abonnementId: string; periodicite: PeriodiciteOffre; livemode: boolean; periodeFin: Date | null }): Promise<IssueEnregistrementPro> {
    try {
      const res = await this.pool.query<{ tenant_id: string; fini_le: Date | null; nouveau: boolean }>(
        `insert into abonnements_offre (stripe_subscription_id, tenant_id, periodicite, livemode, statut, periode_fin)
         values ($1, $2, $3, $4, 'actif', $5)
         on conflict (stripe_subscription_id) do update
           set periode_fin = greatest(abonnements_offre.periode_fin, excluded.periode_fin), maj_le = now()
         returning tenant_id, fini_le, (xmax = 0) as nouveau`,
        [a.abonnementId, a.tenantId, a.periodicite, a.livemode, a.periodeFin],
      );
      const l = res.rows[0]!;
      if (l.fini_le !== null) return { etat: 'fini' };
      // L'espace de la ligne, jamais celui de l'événement rejoué : un abonnement appartient à son premier espace.
      return { etat: 'enregistre', tenantId: l.tenant_id, nouveau: l.nouveau };
    } catch (err) {
      const e = err as { code?: unknown; constraint?: unknown };
      if (e.code === '23505' && e.constraint === 'abonnements_offre_un_vivant_par_espace') return { etat: 'doublon' };
      throw err;
    }
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
   * (le portail permet de passer du mensuel à l'annuel). Un abonnement fini ne change plus.
   */
  async modifier(abonnementId: string, m: { finPrevueLe: Date | null; periodicite: PeriodiciteOffre | null }): Promise<AbonnementOffre | null> {
    const res = await this.pool.query<Ligne>(
      `update abonnements_offre
          set fin_prevue_le = $2, periodicite = coalesce($3, periodicite), maj_le = now()
        where stripe_subscription_id = $1 and fini_le is null
        returning ${COLONNES}`,
      [abonnementId, m.finPrevueLe, m.periodicite],
    );
    return res.rows[0] ? versAbonnement(res.rows[0]) : null;
  }

  /**
   * La fin effective (`customer.subscription.deleted`) : l'espace revient en Base. Datée et raisonnée UNE fois : un rejeu
   * ne déplace ni la date ni la raison. Rend l'abonnement, `null` s'il est inconnu.
   */
  async finir(abonnementId: string, raison: RaisonFinOffre, finiLe: Date): Promise<AbonnementOffre | null> {
    const res = await this.pool.query<Ligne>(
      `update abonnements_offre
          set statut = 'resilie', fini_le = coalesce(fini_le, $3), fin_raison = coalesce(fin_raison, $2), maj_le = now()
        where stripe_subscription_id = $1
        returning ${COLONNES}`,
      [abonnementId, raison, finiLe],
    );
    return res.rows[0] ? versAbonnement(res.rows[0]) : null;
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
