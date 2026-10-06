import type { Pool } from 'pg';
import { enTransaction } from '../db/transaction';
import { attribuerAvec } from '../otp/store.pg';

/**
 * L'ABONNEMENT DU NUMÉRO FOURNI (lot 3c, livraison B, migration 0214). Un numéro fourni se paie 3,50 € HT par mois en
 * abonnement Stripe, et il n'est attribué qu'une fois le paiement confirmé : `enregistrer` écrit l'abonnement ET
 * attribue le numéro dans la MÊME transaction. Rejouer un événement ne duplique rien (clé = l'abonnement Stripe), et
 * l'ordre d'arrivée des événements ne change pas l'état final.
 *
 * Rien n'est coupé sur le statut avant le lot 4 : `en_retard` et `resilie` se notent et préviennent Julien.
 */
export type StatutAbonnement = 'actif' | 'en_retard' | 'resilie';

export interface AbonnementNumero {
  abonnementId: string;
  tenantId: string;
  livemode: boolean;
  statut: StatutAbonnement;
  periodeFin: Date | null;
}

/**
 * Ce que l'enregistrement a produit. `numero` : le numéro attribué (déjà attribué ou neuf), `null` si la réserve s'est
 * vidée entre l'ouverture du paiement et sa confirmation. `doublon` : l'espace a déjà un AUTRE abonnement vivant (deux
 * paiements ouverts en même temps) ; rien n'est écrit, Julien l'annule chez Stripe. `resilie` : un événement en retard
 * pour un abonnement déjà résilié ; rien n'est attribué, et il n'y a rien à signaler.
 */
export type IssueEnregistrement = { etat: 'enregistre'; numero: string | null } | { etat: 'doublon' } | { etat: 'resilie' };

interface Ligne {
  stripe_subscription_id: string;
  tenant_id: string;
  livemode: boolean;
  statut: StatutAbonnement;
  periode_fin: Date | null;
}
const versAbonnement = (l: Ligne): AbonnementNumero => ({
  abonnementId: l.stripe_subscription_id, tenantId: l.tenant_id, livemode: l.livemode, statut: l.statut, periodeFin: l.periode_fin,
});

export class PgAbonnementsNumeroStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Le paiement est confirmé (`checkout.session.completed`, ou une première facture payée arrivée avant) : l'abonnement
   * est actif et le numéro attribué, ensemble. Rejoué : la fin de période ne recule jamais, et un abonnement résilié le
   * reste (un événement en retard ne le ressuscite pas, et ne lui attribue rien).
   */
  async enregistrer(a: { tenantId: string; abonnementId: string; livemode: boolean; periodeFin: Date | null }): Promise<IssueEnregistrement> {
    for (let essai = 0; ; essai += 1) {
      try {
        return await this.enregistrerUneFois(a);
      } catch (err) {
        const e = err as { code?: unknown; constraint?: unknown };
        if (e.code !== '23505' || e.constraint !== 'abonnements_numero_un_par_espace') throw err;
        // 🟡 La session et la première facture du MÊME abonnement arrivent ensemble (jaune 4 de la relecture de la
        // livraison B) : l'index d'espace, qui n'arbitre pas le `on conflict`, peut refuser la seconde avant que la
        // clé primaire ne la voie. Si la ligne de CET abonnement existe, ce n'est pas un doublon : un seul nouvel essai,
        // qui passe par la mise à jour. Sinon, un AUTRE abonnement vivant tient l'espace.
        if (essai > 0 || !(await this.existe(a.abonnementId))) return { etat: 'doublon' };
      }
    }
  }

  private async existe(abonnementId: string): Promise<boolean> {
    const res = await this.pool.query(`select 1 from abonnements_numero where stripe_subscription_id = $1`, [abonnementId]);
    return (res.rowCount ?? 0) > 0;
  }

  private async enregistrerUneFois(a: { tenantId: string; abonnementId: string; livemode: boolean; periodeFin: Date | null }): Promise<IssueEnregistrement> {
    return enTransaction(this.pool, async (client) => {
      const res = await client.query<{ statut: StatutAbonnement; tenant_id: string }>(
        `insert into abonnements_numero (stripe_subscription_id, tenant_id, livemode, statut, periode_fin)
         values ($1, $2, $3, 'actif', $4)
         on conflict (stripe_subscription_id) do update
           set periode_fin = greatest(abonnements_numero.periode_fin, excluded.periode_fin), maj_le = now()
         returning statut, tenant_id`,
        [a.abonnementId, a.tenantId, a.livemode, a.periodeFin],
      );
      const l = res.rows[0]!;
      if (l.statut === 'resilie') return { etat: 'resilie' as const };
      // L'espace de la ligne, jamais celui de l'événement rejoué : un abonnement appartient à son premier espace.
      const n = await attribuerAvec(client, l.tenant_id);
      return { etat: 'enregistre' as const, numero: n?.numero ?? null };
    });
  }

  /**
   * Un renouvellement payé, un échec de paiement, une résiliation : le nouveau statut, et la fin de période si la
   * facture la porte (elle ne recule jamais). `resilie` est terminal. Rend l'abonnement, `null` s'il est inconnu.
   */
  async majStatut(abonnementId: string, statut: StatutAbonnement, periodeFin: Date | null): Promise<AbonnementNumero | null> {
    const res = await this.pool.query<Ligne>(
      `update abonnements_numero
          set statut = case when statut = 'resilie' then statut else $2 end,
              periode_fin = greatest(periode_fin, $3::timestamptz), maj_le = now()
        where stripe_subscription_id = $1
        returning stripe_subscription_id, tenant_id, livemode, statut, periode_fin`,
      [abonnementId, statut, periodeFin],
    );
    return res.rows[0] ? versAbonnement(res.rows[0]) : null;
  }

  /** L'abonnement de l'espace : le vivant s'il y en a un, sinon le dernier résilié ; `null` s'il n'en a jamais eu. */
  async deLEspace(tenantId: string): Promise<AbonnementNumero | null> {
    const res = await this.pool.query<Ligne>(
      `select stripe_subscription_id, tenant_id, livemode, statut, periode_fin from abonnements_numero
        where tenant_id = $1 order by (statut <> 'resilie') desc, cree_le desc limit 1`,
      [tenantId],
    );
    return res.rows[0] ? versAbonnement(res.rows[0]) : null;
  }

  /**
   * Les espaces abonnés qui attendent leur numéro (la réserve s'était vidée), du plus ancien au plus récent : ni numéro
   * attribué, ni numéro WhatsApp relié. La déclaration d'un numéro dans /ops les sert d'abord.
   */
  async enAttenteDeNumero(): Promise<string[]> {
    const res = await this.pool.query<{ tenant_id: string }>(
      `select a.tenant_id from abonnements_numero a
        where a.statut = 'actif'
          and not exists (select 1 from numeros_fournis n where n.tenant_id = a.tenant_id and n.statut = 'attribue')
          and not exists (select 1 from phone_numbers p where p.tenant_id = a.tenant_id)
        order by a.cree_le`,
    );
    return res.rows.map((r) => r.tenant_id);
  }
}
