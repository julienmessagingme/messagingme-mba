import type { Pool } from 'pg';
import { enTransaction } from '../db/transaction';
import { attribuerAvec } from '../otp/store.pg';
import { couvertureParLePro, etatAbonnement, liberationPrevue, DELAI_COUPURE_IMPAYE_MS, type EtatAbonnementNumero } from './etat-abonnement';

/**
 * L'ABONNEMENT DU NUMÉRO FOURNI (lot 3c, livraison B, migration 0214). Un numéro fourni se paie 3,50 € HT par mois en
 * abonnement Stripe, et il n'est attribué qu'une fois le paiement confirmé : `enregistrer` écrit l'abonnement ET
 * attribue le numéro dans la MÊME transaction. Rejouer un événement ne duplique rien (clé = l'abonnement Stripe), et
 * l'ordre d'arrivée des événements ne change pas l'état final.
 *
 * Le lot 4 (migration 0215) garde les DATES qui font l'état (`src/stripe/etat-abonnement.ts`) : le premier échec d'une
 * série, la résiliation programmée, la fin effective, la libération. Aucun statut n'est écrit par un balayage.
 */
export type StatutAbonnement = 'actif' | 'en_retard' | 'resilie';

export interface AbonnementNumero {
  abonnementId: string;
  tenantId: string;
  livemode: boolean;
  statut: StatutAbonnement;
  periodeFin: Date | null;
  /** Le premier échec de paiement de la série en cours (0215) : 7 jours après, les envois sont coupés. */
  premierEchecLe: Date | null;
  /** La résiliation programmée (portail de Stripe, ou « Abandonner ») : les envois restent ouverts jusque-là. */
  finPrevueLe: Date | null;
  /** La fin effective : les envois sont coupés, le numéro gardé 7 jours. */
  finiLe: Date | null;
  /** La libération faite (livraison B). */
  libereLe: Date | null;
}

/** Ce que l'espace lit de son abonnement : l'état calculé et ses dates. */
export interface EtatDeLEspace {
  abonnementId: string;
  etat: EtatAbonnementNumero;
  finPrevueLe: Date | null;
  liberationLe: Date | null;
  /** En retard : la date où les envois seront coupés (7 jours après le premier échec) ; `null` sinon. */
  coupureLe: Date | null;
  /** La fin effective : suspendu PARCE QUE fini (un nouveau paiement rend le même numéro), et non faute de paiement. */
  finiLe: Date | null;
  /** La libération faite (livraison B) : le balayage envoie alors l'e-mail et l'alerte de libération. */
  libereLe: Date | null;
}

/** Les avis qui ne partent qu'une fois par abonnement (CHECK `abonnements_numero_avis_chk`, 0215). */
export type AvisAbonnement = 'suspension_telegram' | 'suspension_mail' | 'rappel_liberation_mail' | 'liberation_mail' | 'liberation_telegram';

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
  premier_echec_le: Date | null;
  fin_prevue_le: Date | null;
  fini_le: Date | null;
  libere_le: Date | null;
}
const COLONNES = 'stripe_subscription_id, tenant_id, livemode, statut, periode_fin, premier_echec_le, fin_prevue_le, fini_le, libere_le';
const versAbonnement = (l: Ligne): AbonnementNumero => ({
  abonnementId: l.stripe_subscription_id, tenantId: l.tenant_id, livemode: l.livemode, statut: l.statut, periodeFin: l.periode_fin,
  premierEchecLe: l.premier_echec_le, finPrevueLe: l.fin_prevue_le, finiLe: l.fini_le, libereLe: l.libere_le,
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
   * facture la porte (elle ne recule jamais). `resilie` est terminal. Les dates du lot 4 suivent le statut : un échec
   * pose le premier échec de la série s'il ne l'est pas déjà, un paiement l'efface, une résiliation date la fin une
   * fois. Rend l'abonnement, `null` s'il est inconnu.
   *
   * 🔴 `finFactureEchouee` : la fin de la période que couvre la facture d'un échec. Si la période payée la couvre déjà,
   * l'échec est un rejeu arrivé APRÈS le paiement (Stripe ne garantit pas l'ordre) : rien n'est écrit et la méthode
   * rend `null`, comme pour un abonnement inconnu (donc aucune alerte). `null` : rien à comparer, l'échec compte.
   */
  async majStatut(
    abonnementId: string, statut: StatutAbonnement, periodeFin: Date | null, finFactureEchouee: Date | null = null,
  ): Promise<AbonnementNumero | null> {
    // Un abonnement qui redevient actif (payé) oublie ses avis de suspension, dans la même instruction : une seconde
    // suspension du même abonnement doit prévenir de nouveau (jaune 6 de la relecture de la livraison A).
    const res = await this.pool.query<Ligne>(
      `with maj as (
       update abonnements_numero
          set statut = case when statut = 'resilie' then statut else $2 end,
              periode_fin = greatest(periode_fin, $3::timestamptz),
              premier_echec_le = case
                when statut = 'resilie' then premier_echec_le
                when $2::text = 'en_retard' then coalesce(premier_echec_le, now())
                when $2::text = 'actif' then null
                else premier_echec_le end,
              fini_le = case when $2::text = 'resilie' then coalesce(fini_le, now()) else fini_le end,
              maj_le = now()
        where stripe_subscription_id = $1
          and not ($2::text = 'en_retard' and $4::timestamptz is not null
                   and periode_fin is not null and periode_fin >= $4::timestamptz)
        returning ${COLONNES}
       ), oubli as (
         delete from abonnements_numero_avis v using maj
          where $2::text = 'actif' and maj.statut = 'actif' and v.stripe_subscription_id = maj.stripe_subscription_id
            and v.avis in ('suspension_telegram', 'suspension_mail')
       )
       select * from maj`,
      [abonnementId, statut, periodeFin, finFactureEchouee],
    );
    return res.rows[0] ? versAbonnement(res.rows[0]) : null;
  }

  /**
   * La résiliation programmée (`customer.subscription.updated`) : posée à sa date, ou retirée (`null`) quand le client
   * l'annule dans le portail. Sans effet sur l'état d'un abonnement fini (la fin compte). `false` : abonnement inconnu.
   */
  async noterFinPrevue(abonnementId: string, fin: Date | null): Promise<boolean> {
    const res = await this.pool.query(
      `update abonnements_numero set fin_prevue_le = $2, maj_le = now() where stripe_subscription_id = $1`,
      [abonnementId, fin],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Les espaces que le balayage surveille (lot 4) : un abonnement qui porte un échec, une fin ou une résiliation, et
   * qui n'est pas libéré. Lecture de toute la table, délibérément : c'est le worker, pas un espace, qui la demande.
   */
  async aSurveiller(): Promise<string[]> {
    // L'abonnement COURANT de chaque espace, dans l'ordre de `deLEspace` : la vieille ligne résiliée d'un espace
    // réabonné ne le fait plus surveiller pour toujours (relecture de la livraison A).
    // Et un espace libéré depuis moins de 2 jours tant que l'e-mail ou l'alerte de libération n'est pas parti : un
    // envoi raté se rejoue au tour suivant (livraison B).
    const res = await this.pool.query<{ tenant_id: string }>(
      `select tenant_id from (
         select distinct on (tenant_id) tenant_id, stripe_subscription_id, statut, premier_echec_le, fini_le, libere_le
           from abonnements_numero
          order by tenant_id, (statut <> 'resilie') desc, cree_le desc
       ) a
        where (libere_le is null and (premier_echec_le is not null or fini_le is not null or statut = 'resilie'))
           or (libere_le > now() - interval '2 days'
               and (select count(*) from abonnements_numero_avis v
                     where v.stripe_subscription_id = a.stripe_subscription_id
                       and v.avis in ('liberation_mail', 'liberation_telegram')) < 2)`,
    );
    return res.rows.map((r) => r.tenant_id);
  }

  /** Cet avis est-il déjà parti pour cet abonnement ? Lu AVANT l'envoi : l'avis ne se note qu'une fois l'envoi réussi. */
  async avisDejaParti(abonnementId: string, avis: AvisAbonnement): Promise<boolean> {
    const res = await this.pool.query(
      `select 1 from abonnements_numero_avis where stripe_subscription_id = $1 and avis = $2`, [abonnementId, avis],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Un avis (alerte ou e-mail) ne part qu'une fois par abonnement : `true` la première fois seulement. */
  async noterAvis(abonnementId: string, avis: AvisAbonnement): Promise<boolean> {
    const res = await this.pool.query(
      `insert into abonnements_numero_avis (stripe_subscription_id, avis) values ($1, $2) on conflict do nothing`,
      [abonnementId, avis],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * L'état de l'abonnement de l'espace et ses dates, `null` s'il n'en a jamais eu. La SEULE lecture de l'état : la garde
   * d'envoi, la route de l'état, les outils MCP et le balayage passent par elle.
   */
  async etatDeLEspace(tenantId: string, maintenant: Date = new Date()): Promise<EtatDeLEspace | null> {
    const ligne = await this.deLEspace(tenantId);
    if (ligne === null) return null;
    // 🔴 Le Pro de l'espace couvre le numéro (lot 6, livraison B1, vigilance 4) : appliqué ICI, la seule lecture de l'état,
    // donc à la garde d'envoi, au balayage qui suspend puis libère, au MCP et à la console (`couvertureParLePro`).
    const pro = await this.pool.query<{ vivant: boolean | null; dernier_fini: Date | null }>(
      `select bool_or(fini_le is null) as vivant, max(fini_le) as dernier_fini from abonnements_offre where tenant_id = $1`,
      [tenantId],
    );
    const p = pro.rows[0];
    const a = { ...ligne, ...couvertureParLePro(ligne, { vivant: p?.vivant === true, dernierFini: p?.dernier_fini ?? null }) };
    // Le numéro fourni attribué et le numéro WhatsApp relié, en chiffres. Des chiffres inconnus (affichage vide, Meta pas
    // lu à la liaison) sont ceux du numéro fourni, comme pour « Abandonner » et la garde d'envoi (jaune 3).
    const n = await this.pool.query<{ fourni: string | null; relie: string | null }>(
      `select (select numero from numeros_fournis where tenant_id = $1 and statut = 'attribue' limit 1) as fourni,
              (select regexp_replace(coalesce(display_phone_number, ''), '[^0-9]', '', 'g') from phone_numbers
                where tenant_id = $1 limit 1) as relie`,
      [tenantId],
    );
    const { fourni, relie } = n.rows[0] ?? { fourni: null, relie: null };
    // Un AUTRE numéro que le numéro fourni envoie (jaune 1) : rien de chez nous n'est coupé.
    const numeroApporte = relie !== null && relie !== '' && relie !== fourni;
    const etat = etatAbonnement(a, { maintenant, numeroAttribue: fourni !== null, numeroApporte });
    return {
      abonnementId: a.abonnementId,
      etat,
      finPrevueLe: a.finPrevueLe,
      liberationLe: liberationPrevue(a),
      coupureLe: etat === 'en_retard' && a.premierEchecLe !== null && !numeroApporte
        ? new Date(a.premierEchecLe.getTime() + DELAI_COUPURE_IMPAYE_MS) : null,
      finiLe: a.finiLe,
      libereLe: a.libereLe,
    };
  }

  /** L'abonnement de l'espace : le vivant s'il y en a un, sinon le dernier résilié ; `null` s'il n'en a jamais eu. */
  async deLEspace(tenantId: string): Promise<AbonnementNumero | null> {
    const res = await this.pool.query<Ligne>(
      `select ${COLONNES} from abonnements_numero
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
          -- Une fin programmée (« Abandonner », ou le portail) : l'abonné ne veut plus de numéro (lot 4, livraison B).
          and a.fin_prevue_le is null
          and not exists (select 1 from numeros_fournis n where n.tenant_id = a.tenant_id and n.statut = 'attribue')
          and not exists (select 1 from phone_numbers p where p.tenant_id = a.tenant_id)
        order by a.cree_le`,
    );
    return res.rows.map((r) => r.tenant_id);
  }
}
