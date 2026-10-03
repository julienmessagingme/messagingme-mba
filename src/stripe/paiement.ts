import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { creerClientStripe, creerSessionCheckout, lirePrixStripe, StripeError, type TransportStripe } from './client';
import { definitionOffre, OFFRES_RECHARGE, type OffreRecharge } from './offres';
import { journaliser } from '../lib/journal';
import { refus, type Issue } from '../lib/issue';

/**
 * OUVRIR LE PAIEMENT D'UNE RECHARGE DU CRÉDIT IA (lot 8a, `docs/superpowers/plans/2026-10-03-mcp-agent-ia.md`).
 *
 * 🔴 UNE SEULE VÉRITÉ, DEUX PORTES. La route de la console (`POST /credit/paiement`, `src/http/credit-stripe.ts`) et
 * l'outil MCP `buy_credit` appellent `ouvrirPaiement` : mêmes offres fermées, même prix relu chez Stripe, même règle du
 * mode test. L'une comme l'autre ne rendent qu'une ADRESSE : le paiement reste un geste humain sur la page de Stripe,
 * et seul le webhook signé crédite.
 */

/** Stripe configuré sur cette instance. `null` = recharge pas encore disponible (503). */
export interface StripeConfigure {
  /** La clé secrète (restreinte). Jamais journalisée, jamais rendue. */
  cle: string;
  /** Le mode de la clé : le client Stripe d'un espace est gardé par mode (migration 0191). */
  livemode: boolean;
  /** L'identifiant Stripe du prix de chaque offre. Vide = cette offre n'est pas encore en vente. */
  prix: Readonly<Record<OffreRecharge, string>>;
  transport: TransportStripe;
  /** L'adresse de la page Crédit IA de la console, où Stripe renvoie après le paiement ou l'abandon. */
  pageCredit: string;
}

/** Le câblage passe les MÊMES objets à la console et au MCP. */
export interface DepsPaiement {
  stripe: StripeConfigure | null;
  clients: {
    clientDe(tenantId: string, livemode: boolean): Promise<string | null>;
    retenirClient(tenantId: string, livemode: boolean, customerId: string): Promise<string>;
  };
  /**
   * Ce compte peut-il ouvrir un paiement ? Toujours oui en live. 🔴 En mode test, seul un exploitant : une carte de
   * test créditerait sinon de vrais euros de modèle à n'importe quel client, le temps des essais. La même règle
   * ouvre les factures.
   */
  payeurAutorise(userId: string): Promise<boolean>;
}

/** Le corps ne porte qu'une offre, jamais un montant ni un prix. Exporté : l'outil MCP annonce les offres d'ici. */
export const saisieDePaiement = z.object({ offre: z.enum(OFFRES_RECHARGE) });

/** Le même refus pour « pas configuré » et « pas encore ouvert à ce compte » : l'écran dit la même chose. */
export const RECHARGE_INDISPONIBLE = refus(503, 'recharge pas encore disponible', { code: 'recharge_indisponible' });

/**
 * Ce qu'une ouverture rend : l'adresse de la session Checkout, et le montant HORS TAXE de l'offre. ⚠️ Pas de TTC : la
 * taxe est calculée par Stripe Tax sur la page de paiement, selon le pays et le numéro de TVA que le payeur y saisit
 * (autoliquidation possible), donc aucun montant TTC n'est connu avant qu'il paie.
 */
export interface PaiementOuvert {
  url: string;
  htCentimes: number;
}

/**
 * Ouvre une session Checkout pour une offre. `payeur` est l'utilisateur de la session (console) ou la personne du
 * jeton (MCP), jamais une valeur du corps ; vide, il n'est autorisé qu'en live. Toute erreur de Stripe devient un
 * refus 422 : son message part au journal, pas à l'appelant (il parle de NOTRE compte, et peut citer la fin de la clé).
 */
export async function ouvrirPaiement(
  deps: DepsPaiement, tenantId: string, corps: unknown, payeur: string,
): Promise<Issue<PaiementOuvert>> {
  const lu = saisieDePaiement.safeParse(corps ?? {});
  if (!lu.success) return refus(400, 'offre inconnue (refill_50 ou refill_100)');
  const offre = lu.data.offre;
  const s = deps.stripe;
  if (s === null || s.prix[offre] === '') return RECHARGE_INDISPONIBLE;
  if (!(await deps.payeurAutorise(payeur))) return RECHARGE_INDISPONIBLE;

  try {
    // 🔴 LE PRIX CONFIGURÉ EST RELU CHEZ STRIPE, AVANT TOUT (relecture du 2026-09-29). Le webhook ne crédite un
    // paiement que s'il a encaissé, en euros, le HT de l'offre : un prix mal configuré (un identifiant interverti
    // entre les deux offres, un prix en dollars, un montant faux) laissait payer le client, puis refusait de le
    // créditer. On refuse donc AVANT le paiement, sans rien créer chez Stripe, et on le dit au journal.
    const attendu = definitionOffre(offre).htCentimes;
    const prix = await lirePrixStripe(s.transport, { cle: s.cle, prix: s.prix[offre] });
    if (prix.montantCentimes !== attendu || prix.devise !== 'eur') {
      journaliser('error', 'stripe_prix_incoherent', {
        tenantId, offre, prix: s.prix[offre], attenduCentimes: attendu, luCentimes: prix.montantCentimes, devise: prix.devise,
      });
      return refus(422,
        'La recharge est momentanément indisponible : son tarif est en cours de correction. Réessayez plus tard, ou contactez-nous.',
        { code: 'prix_incoherent' });
    }

    let client = await deps.clients.clientDe(tenantId, s.livemode);
    if (client === null) {
      const cree = await creerClientStripe(s.transport, { cle: s.cle, tenantId });
      client = await deps.clients.retenirClient(tenantId, s.livemode, cree);
    }
    const session = await creerSessionCheckout(s.transport, {
      cle: s.cle,
      tenantId,
      offre,
      prix: s.prix[offre],
      customerId: client,
      urlSucces: `${s.pageCredit}?paiement=recu`,
      urlAbandon: `${s.pageCredit}?paiement=abandon`,
      idempotence: `session-${tenantId}-${randomUUID()}`,
    });
    return { ok: true, valeur: { url: session.url, htCentimes: attendu } };
  } catch (err) {
    if (!(err instanceof StripeError)) throw err;
    // 🔴 4xx et jamais 5xx : Cloudflare remplacerait le corps. Le message de Stripe (Stripe Tax pas activé, prix
    // archivé...) part dans le journal et pas à l'appelant : il parle de NOTRE compte, et un message d'erreur
    // d'authentification de Stripe cite la fin de la clé.
    journaliser('error', 'stripe_paiement_impossible', {
      tenantId, offre, operation: err.operation, status: err.status, type: err.type, code: err.code, err: err.message,
    });
    return refus(422, 'Le paiement n’a pas pu être préparé. Réessayez dans un instant ; si cela persiste, contactez-nous.',
      { code: 'paiement_impossible' });
  }
}
