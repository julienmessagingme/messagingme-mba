import { randomUUID } from 'node:crypto';
import { creerClientStripe, creerSessionAbonnement, creerSessionPortail, lirePrixStripe, programmerFinAbonnement, StripeError } from './client';
import type { DepsPaiement, StripeConfigure } from './paiement';
import { journaliser } from '../lib/journal';
import { refus, type Issue } from '../lib/issue';

/**
 * OUVRIR L'ABONNEMENT DU NUMÉRO FOURNI, ET SON PORTAIL (lot 3c, livraison B, spec
 * `docs/superpowers/specs/2026-10-06-lien-attente-abonnement-design.md`). Comme la recharge (`./paiement`), une route
 * de la console et un outil MCP n'en rendent qu'une ADRESSE : le paiement reste un geste humain sur la page de Stripe,
 * et seul le webhook signé enregistre l'abonnement et attribue le numéro.
 */

/** 3,50 € HT par mois (décision de Julien du 2026-10-06), le prix posé chez Stripe, taxe en sus. */
export const PRIX_NUMERO_HT_CENTIMES = 350;

/** Les mêmes objets que la recharge, plus le prix du numéro et l'adresse de la console où Stripe renvoie. */
export interface DepsAbonnement extends DepsPaiement {
  /** L'identifiant Stripe du prix mensuel du numéro (`STRIPE_PRIX_NUMERO`). Vide = pas encore en vente. */
  prixNumero: string;
  /** L'adresse de la console (`APP_URL`). */
  urlConsole: string;
}

/**
 * D'où l'on vient, donc où Stripe renvoie : la page du lien de Claude Code, celle de la console, ou (lot 4, un
 * réabonnement demandé à Claude) une page publique qui dit « paiement reçu, retournez dans Claude ».
 */
export type RetourAbonnement = 'brancher' | 'console' | 'claude';
const PAGE: Readonly<Record<RetourAbonnement, string>> = { brancher: '/brancher', console: '/connecter-whatsapp', claude: '/paiement-recu' };

export const ABONNEMENT_INDISPONIBLE = refus(503, 'abonnement du numéro pas encore disponible', { code: 'abonnement_indisponible' });

const page = (d: DepsAbonnement, retour: RetourAbonnement): string => `${d.urlConsole.trim().replace(/\/+$/, '')}${PAGE[retour]}`;

/** Le client Stripe de l'espace, créé à la première fois (le même que celui de la recharge, gardé par mode). */
async function clientDeLEspace(d: DepsAbonnement, s: StripeConfigure, tenantId: string): Promise<string> {
  const existant = await d.clients.clientDe(tenantId, s.livemode);
  if (existant !== null) return existant;
  return d.clients.retenirClient(tenantId, s.livemode, await creerClientStripe(s.transport, { cle: s.cle, tenantId }));
}

/** Un refus de Stripe : son message au journal (il parle de NOTRE compte), un 422 lisible à l'appelant, jamais un 5xx. */
function refusDeStripe(err: StripeError, tenantId: string, geste: string) {
  journaliser('error', 'stripe_abonnement_impossible', {
    tenantId, geste, operation: err.operation, status: err.status, type: err.type, code: err.code, err: err.message,
  });
  return refus(422, 'Le paiement n’a pas pu être préparé. Réessayez dans un instant ; si cela persiste, contactez-nous.',
    { code: 'paiement_impossible' });
}

/**
 * Ouvre la session Checkout de l'abonnement du numéro. `payeur` est l'utilisateur de la session, celui du lien, ou la
 * personne du jeton OAuth, jamais une valeur du corps. 🔴 Le prix configuré est relu chez Stripe AVANT tout : il doit
 * valoir 3,50 € HT par mois, en euros, sinon rien n'est créé chez Stripe et le journal le dit.
 */
export async function ouvrirAbonnement(
  d: DepsAbonnement, tenantId: string, retour: RetourAbonnement, payeur: string,
): Promise<Issue<{ url: string }>> {
  const s = d.stripe;
  if (s === null || d.prixNumero === '') return ABONNEMENT_INDISPONIBLE;
  if (!(await d.payeurAutorise(payeur))) return ABONNEMENT_INDISPONIBLE;
  try {
    const prix = await lirePrixStripe(s.transport, { cle: s.cle, prix: d.prixNumero });
    const mensuel = prix.recurrence?.intervalle === 'month' && prix.recurrence.nombre === 1;
    if (prix.montantCentimes !== PRIX_NUMERO_HT_CENTIMES || prix.devise !== 'eur' || !mensuel) {
      journaliser('error', 'stripe_prix_numero_incoherent', {
        tenantId, prix: d.prixNumero, attenduCentimes: PRIX_NUMERO_HT_CENTIMES, luCentimes: prix.montantCentimes, devise: prix.devise,
        recurrence: prix.recurrence,
      });
      return refus(422,
        'L’abonnement du numéro est momentanément indisponible : son tarif est en cours de correction. Réessayez plus tard, ou contactez-nous.',
        { code: 'prix_incoherent' });
    }
    const session = await creerSessionAbonnement(s.transport, {
      cle: s.cle,
      tenantId,
      prix: d.prixNumero,
      customerId: await clientDeLEspace(d, s, tenantId),
      urlSucces: `${page(d, retour)}?abonnement=recu`,
      urlAbandon: `${page(d, retour)}?abonnement=abandon`,
      idempotence: `abonnement-${tenantId}-${randomUUID()}`,
    });
    return { ok: true, valeur: { url: session.url } };
  } catch (err) {
    if (!(err instanceof StripeError)) throw err;
    return refusDeStripe(err, tenantId, 'abonnement');
  }
}

/** Le portail client de Stripe pour l'espace (carte, factures, résiliation). Sans client Stripe : rien à gérer. */
export async function ouvrirPortail(
  d: DepsAbonnement, tenantId: string, retour: RetourAbonnement, payeur: string,
): Promise<Issue<{ url: string }>> {
  const s = d.stripe;
  if (s === null) return ABONNEMENT_INDISPONIBLE;
  if (!(await d.payeurAutorise(payeur))) return ABONNEMENT_INDISPONIBLE;
  const client = await d.clients.clientDe(tenantId, s.livemode);
  if (client === null) return refus(409, 'Cet espace n’a aucun abonnement à gérer.', { code: 'aucun_abonnement' });
  try {
    return { ok: true, valeur: await creerSessionPortail(s.transport, { cle: s.cle, customerId: client, urlRetour: page(d, retour) }) };
  } catch (err) {
    if (!(err instanceof StripeError)) throw err;
    return refusDeStripe(err, tenantId, 'portail');
  }
}

/**
 * « Abandonner » d'un abonné (lot 4, livraison B) : la fin de l'abonnement programmée à la fin de la période payée.
 * Un refus (clé sans le droit d'écrire les abonnements, abonnement inconnu) est rendu, jamais levé : l'abandon se fait
 * quand même, et la route prévient Julien pour résilier à la main.
 */
export async function programmerFinDuNumero(d: DepsAbonnement, abonnementId: string): Promise<Issue<true>> {
  const s = d.stripe;
  if (s === null) return ABONNEMENT_INDISPONIBLE;
  try {
    await programmerFinAbonnement(s.transport, { cle: s.cle, abonnementId });
    return { ok: true, valeur: true };
  } catch (err) {
    if (!(err instanceof StripeError)) throw err;
    journaliser('error', 'stripe_fin_abonnement_impossible', {
      abonnementId, operation: err.operation, status: err.status, type: err.type, code: err.code, err: err.message,
    });
    return refus(422, 'La fin de l’abonnement n’a pas pu être programmée chez Stripe.', { code: 'fin_impossible' });
  }
}
