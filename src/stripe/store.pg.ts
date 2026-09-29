import type { Pool } from 'pg';
import { enTransaction } from '../db/transaction';
import { crediterAchat } from '../agent/credits.pg';

/**
 * Ce que la recharge Stripe garde en base (migration 0191) : le client Stripe de chaque espace, par mode, et les
 * paiements déjà crédités. 🔴 `tenant_id = $1` sur chaque lecture : un espace ne lit jamais le client d'un autre.
 */

export interface PaiementStripe {
  sessionId: string;
  tenantId: string;
  offre: string;
  creditMicroEur: number;
  htCentimes: number;
  ttcCentimes: number | null;
  factureId: string | null;
  livemode: boolean;
}

/**
 * Ce qu'a fait le webhook d'un paiement :
 *   - `credite` : la ligne de paiement, le crédit et son mouvement `achat` sont écrits ;
 *   - `deja` : cette session a déjà été créditée (événement rejoué, ou second événement de la même session) ;
 *   - `espace_inconnu` : l'espace des métadonnées n'existe pas (ou plus). Rien n'est écrit.
 */
export type IssuePaiement = 'credite' | 'deja' | 'espace_inconnu';

export class PgStripeStore {
  constructor(private readonly pool: Pool) {}

  /** Le client Stripe de l'espace dans ce mode, `null` s'il n'a jamais payé dans ce mode. */
  async clientDe(tenantId: string, livemode: boolean): Promise<string | null> {
    const r = await this.pool.query<{ customer_id: string }>(
      'select customer_id from stripe_clients where tenant_id = $1 and livemode = $2',
      [tenantId, livemode],
    );
    return r.rows[0]?.customer_id ?? null;
  }

  /**
   * Retient le client créé chez Stripe, et rend celui qui FAIT AUTORITÉ : le premier écrit gagne. Deux achats
   * simultanés reçoivent déjà le même client grâce à la clé d'idempotence de Stripe ; la relecture couvre le reste.
   */
  async retenirClient(tenantId: string, livemode: boolean, customerId: string): Promise<string> {
    await this.pool.query(
      `insert into stripe_clients (tenant_id, livemode, customer_id) values ($1, $2, $3)
       on conflict (tenant_id, livemode) do nothing`,
      [tenantId, livemode, customerId],
    );
    return (await this.clientDe(tenantId, livemode)) ?? customerId;
  }

  /**
   * La facture d'un paiement DE CET ESPACE : `null` quand la session est inconnue ici (inconnue tout court, ou d'un
   * autre espace, et les deux se disent pareil), `factureId` nul quand Stripe n'a pas émis de facture.
   */
  async factureDe(tenantId: string, sessionId: string): Promise<{ factureId: string | null } | null> {
    const r = await this.pool.query<{ facture_id: string | null }>(
      'select facture_id from stripe_paiements where tenant_id = $1 and session_id = $2',
      [tenantId, sessionId],
    );
    const ligne = r.rows[0];
    return ligne ? { factureId: ligne.facture_id } : null;
  }

  /**
   * Crédite un paiement, UNE FOIS. 🔴 Une seule transaction : la ligne de paiement (clé primaire sur la session),
   * puis le crédit et son mouvement `achat`. Un conflit sur la session veut dire « déjà crédité », et rien d'autre ne
   * s'écrit ; un échec du crédit annule la ligne de paiement, et Stripe, qui recevra un 5xx, rejouera.
   */
  async crediterPaiement(p: PaiementStripe): Promise<IssuePaiement> {
    try {
      return await enTransaction(this.pool, async (client) => {
        const ligne = await client.query(
          `insert into stripe_paiements
             (session_id, tenant_id, offre, credit_micro_eur, montant_ht_centimes, montant_ttc_centimes, facture_id, livemode)
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           on conflict (session_id) do nothing`,
          [p.sessionId, p.tenantId, p.offre, p.creditMicroEur, p.htCentimes, p.ttcCentimes, p.factureId, p.livemode],
        );
        if ((ligne.rowCount ?? 0) === 0) return 'deja';
        // Le mouvement porte sa session Stripe (migration 0193) : c'est le lien que suit la facture. La note, elle,
        // sert l'exploitation (le client lit la raison), et plus rien ne la relit. ⚠️ La reprise de 0193 a relu CE
        // texte une fois, pour l'achat d'avant la colonne : `tests/migration-0193.test.ts` compare les deux.
        await crediterAchat(client, p.tenantId, p.creditMicroEur, `achat Stripe ${p.offre} (${p.sessionId})`, p.sessionId);
        return 'credite';
      });
    } catch (err) {
      // 23503 : l'espace n'existe pas. Le rejouer n'y changerait rien, donc ce n'est pas une panne à rendre en 5xx.
      if ((err as { code?: unknown } | null)?.code === '23503') return 'espace_inconnu';
      throw err;
    }
  }
}
