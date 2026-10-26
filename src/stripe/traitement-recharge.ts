import { z } from 'zod';
import { journaliser } from '../lib/journal';
import { lienTableauStripe } from './liens';
import { creditDeLOffre, definitionOffre, OFFRES_RECHARGE } from './offres';
import type { IssuePaiement, PaiementStripe } from './store.pg';
import type { EvenementStripeVerifie } from './traitement-abonnements';

/**
 * Le traitement des événements Stripe qui créditent une recharge du crédit IA (audit de structure du 2026-10-25, lot C
 * du plan `docs/superpowers/plans/2026-10-26-audits-simplicite-structure.md`), sur le modèle de
 * `traitement-abonnements.ts`. La route garde le protocole HTTP (signature, enveloppe, mode et aiguillage) ; ce module
 * lit la session Checkout, vérifie qu'elle est une de nos recharges, payée, au bon montant, et crédite. Les pannes
 * inattendues remontent : Stripe doit alors rejouer l'événement.
 */

export interface DepsTraitementRecharge {
  paiements: { crediterPaiement(p: PaiementStripe): Promise<IssuePaiement> };
  /**
   * Après un crédit : remonter le plafond de la clé de modèle de l'espace (`remonterPlafondApresRecharge`, qui
   * recalcule la cible depuis le solde : le montant de CE crédit ne lui sert pas). Le traitement ne l'attend pas (le
   * câblage le fait suivre par l'arrêt propre du processus) ; un échec est journalisé et ne change pas l'issue : le
   * crédit est écrit.
   */
  apresCredit(tenantId: string): Promise<void>;
  /** L'alerte d'exploitation : de l'argent encaissé sans crédit, à traiter à la main. */
  alerter(texte: string): Promise<void>;
}

/**
 * `illisible` : une session créditante qu'on ne sait pas lire, de l'argent encaissé sans crédit, donc un rejeu à
 * demander. `acquitte` : tout le reste, crédité ou non ; `credite` absent quand l'événement n'était pas une de nos
 * recharges réglées (la réponse ne le dit alors pas).
 */
export type IssueTraitementRecharge =
  | { issue: 'non_recharge' }
  | { issue: 'illisible' }
  | { issue: 'acquitte'; credite?: boolean };

/** Les deux événements qui créditent. */
const EVENEMENTS_CREDITANTS = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded']);

/** Ce qu'on lit d'une session Checkout, et rien de plus (`safeParse`, les autres champs sont ignorés). */
const sessionSchema = z.object({
  id: z.string().min(1),
  mode: z.string(),
  payment_status: z.string(),
  amount_subtotal: z.number().int().nullable(),
  amount_total: z.number().int().nullable(),
  currency: z.string().nullable(),
  client_reference_id: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.string()).nullable().optional(),
  // Un identifiant, ou l'objet facture si l'événement l'a déplié.
  invoice: z.union([z.string(), z.object({ id: z.string() })]).nullable().optional(),
});

/** NOS métadonnées. Une session qui ne les porte pas n'est pas une recharge : le compte vend peut-être autre chose. */
const metadonneesSchema = z.object({
  tenant_id: z.uuid(),
  offre: z.enum(OFFRES_RECHARGE),
});

/** Nos métadonnées avec une offre quelconque : ce qui distingue une recharge d'une offre inconnue d'une vente étrangère. */
const notreRechargeSchema = z.object({
  tenant_id: z.uuid(),
  offre: z.string().min(1),
});

const ACQUITTE = { issue: 'acquitte' } as const;
const NON_CREDITE = { issue: 'acquitte', credite: false } as const;

export function creerTraitementRecharge(deps: DepsTraitementRecharge) {
  function concerne(e: Pick<EvenementStripeVerifie, 'type'>): boolean {
    return EVENEMENTS_CREDITANTS.has(e.type);
  }

  async function traiter(e: EvenementStripeVerifie): Promise<IssueTraitementRecharge> {
    if (!concerne(e)) return { issue: 'non_recharge' };

    const lue = sessionSchema.safeParse(e.objet);
    if (!lue.success) {
      journaliser('error', 'stripe_session_illisible', { evenement: e.id, type: e.type });
      return { issue: 'illisible' };
    }
    const session = lue.data;
    const meta = metadonneesSchema.safeParse(session.metadata ?? {});
    // Paiement différé pas encore arrivé : `async_payment_succeeded` viendra. `no_payment_required` est une session
    // réglée à zéro par un code promo à 100 % : elle crédite, comme un paiement.
    const reglee = session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
    const facture = session.invoice === undefined || session.invoice === null
      ? null
      : typeof session.invoice === 'string' ? session.invoice : session.invoice.id;
    const lienFacture = facture === null ? '' : ` ${lienTableauStripe('invoices', facture, e.livemode)}`;
    // Pas une de nos recharges : acquittée sans effet, sinon Stripe rejouerait un événement qui ne nous concerne pas.
    if (session.mode !== 'payment') return ACQUITTE;
    if (!meta.success) {
      // 🔴 NOS métadonnées avec une offre que cette version ne connaît pas (une image revenue en arrière sous une session
      // ouverte par une plus récente) : de l'argent encaissé sans crédit, qui partait en 200 sans trace (relecture du
      // 2026-10-22). Toujours acquittée : un rejeu qui créditerait après un crédit fait à la main paierait deux fois.
      const notre = notreRechargeSchema.safeParse(session.metadata ?? {});
      if (notre.success && reglee) {
        const { tenant_id: espace, offre: inconnue } = notre.data;
        journaliser('error', 'stripe_offre_inconnue', { evenement: e.id, session: session.id, tenantId: espace, offre: inconnue.slice(0, 40) });
        // La voie sûre est nommée : un crédit fait à la main n'écrit aucune ligne de paiement, et un événement renvoyé
        // ensuite par une version qui connaît l'offre créditerait la session une seconde fois.
        const encaisse = session.payment_status === 'paid' ? 'payée' : 'réglée à zéro par un code promo, rien encaissé';
        await deps.alerter(`Recharge ${encaisse}, pour une offre que cette version ne connaît pas (${inconnue.slice(0, 40)}) : espace ${espace}, session ${session.id}, rien n'a été crédité. Pour créditer : revenir à une version qui connaît l'offre, puis renvoyer l'événement depuis Stripe (un seul crédit par session). Sinon rembourser ; ne jamais créditer à la main puis renvoyer.${lienFacture}`);
        return NON_CREDITE;
      }
      return ACQUITTE;
    }
    if (!reglee) return ACQUITTE;

    // 🔴 L'offre des métadonnées doit correspondre au prix HT de la ligne, en euros, pour cet espace.
    // `amount_subtotal` est le prix avant remise : un code promo ne change pas le crédit, qui reste plein.
    const { tenant_id: tenantId, offre } = meta.data;
    const attendu = definitionOffre(offre).htCentimes;
    const reference = session.client_reference_id ?? null;
    if (session.currency !== 'eur' || session.amount_subtotal !== attendu || (reference !== null && reference !== tenantId)) {
      journaliser('error', 'stripe_paiement_incoherent', {
        evenement: e.id, session: session.id, tenantId, offre, attenduCentimes: attendu,
        payeCentimes: session.amount_subtotal, devise: session.currency,
        referenceConcorde: reference === null || reference === tenantId,
      });
      return NON_CREDITE;
    }

    // Une transaction : la ligne de paiement (idempotence), le crédit, le mouvement `achat`. Une panne de base lève, et
    // Stripe rejoue.
    const issue = await deps.paiements.crediterPaiement({
      sessionId: session.id,
      tenantId,
      offre,
      creditMicroEur: creditDeLOffre(offre),
      htCentimes: attendu,
      ttcCentimes: session.amount_total,
      factureId: facture,
      livemode: e.livemode,
    });
    if (issue === 'espace_inconnu') {
      journaliser('error', 'stripe_paiement_espace_inconnu', { evenement: e.id, session: session.id, tenantId });
      // Un espace supprimé depuis l'ouverture du paiement : de l'argent encaissé sans crédit, à rembourser.
      await deps.alerter(`Recharge payée pour un espace inexistant (supprimé ?) ${tenantId} : session ${session.id}, à rembourser chez Stripe.${lienFacture}`);
      return NON_CREDITE;
    }
    if (issue === 'credite') {
      // Après la transaction et sans faire attendre Stripe. Un échec se journalise : le crédit est écrit et le plafond
      // rattrapera au mouvement suivant.
      deps.apresCredit(tenantId).catch((err: unknown) => {
        journaliser('error', 'stripe_plafond_non_remonte', { tenantId, err });
      });
    }
    return { issue: 'acquitte', credite: issue === 'credite' };
  }

  return { concerne, traiter };
}
