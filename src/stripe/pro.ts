import { randomUUID } from 'node:crypto';
import { creerSessionAbonnement, lirePrixStripe, StripeError } from './client';
import { clientDeLEspace, ouvrirPortail, page, refusDeStripe, type DepsPortail } from './abonnement';
import { PRIX_PRO_HT_CENTIMES } from '../offres/offres';
import { journaliser } from '../lib/journal';
import { refus, type Issue } from '../lib/issue';

/**
 * OUVRIR LE PAIEMENT DU PRO, ET SON PORTAIL (lot 6, livraison B1, tâche 10, spec § 6). Comme le numéro, la route n'en rend
 * qu'une ADRESSE : le paiement reste un geste humain sur la page de Stripe, et seul le webhook signé fait passer l'espace
 * en Pro (`abonnements_offre`). Mensuel ou annuel ; le changement de l'un à l'autre se fait dans le portail de Stripe.
 */
export type PeriodicitePro = 'mois' | 'an';

export interface DepsPro extends DepsPortail {
  /** Les identifiants Stripe des deux prix (`STRIPE_PRIX_PRO_MOIS`, `STRIPE_PRIX_PRO_AN`). Vides = pas encore en vente. */
  prixProMois: string;
  prixProAn: string;
  /** L'espace a-t-il déjà un Pro vivant (`abonnements_offre`) ? Il va alors au portail, jamais à un second paiement. */
  proVivant(tenantId: string): Promise<boolean>;
}

export const PRO_INDISPONIBLE = refus(503, 'le Pro n’est pas encore en vente', { code: 'pro_indisponible' });

/** La récurrence que doit porter chaque prix chez Stripe. */
const RECURRENCE: Readonly<Record<PeriodicitePro, string>> = { mois: 'month', an: 'year' };

/**
 * Ouvre la session Checkout du Pro. `payeur` est l'utilisateur de la session, jamais une valeur du corps. 🔴 Le prix
 * configuré est relu chez Stripe AVANT tout et recoupé avec la grille : sinon rien n'est créé chez Stripe et le journal le
 * dit. Un espace déjà Pro reçoit l'adresse du portail (`portail: true`) : deux abonnements Pro vivants ne se paient pas.
 */
export async function ouvrirPro(
  d: DepsPro, tenantId: string, periodicite: PeriodicitePro, payeur: string,
): Promise<Issue<{ url: string; portail: boolean }>> {
  const s = d.stripe;
  const prixId = periodicite === 'mois' ? d.prixProMois : d.prixProAn;
  if (s === null || prixId === '') return PRO_INDISPONIBLE;
  if (!(await d.payeurAutorise(payeur))) return PRO_INDISPONIBLE;
  if (await d.proVivant(tenantId)) {
    const portail = await ouvrirPortail(d, tenantId, 'offre', payeur);
    return portail.ok ? { ok: true, valeur: { url: portail.valeur.url, portail: true } } : portail;
  }
  try {
    const prix = await lirePrixStripe(s.transport, { cle: s.cle, prix: prixId });
    const attendu = PRIX_PRO_HT_CENTIMES[periodicite];
    const recurrenceJuste = prix.recurrence?.intervalle === RECURRENCE[periodicite] && prix.recurrence.nombre === 1;
    if (prix.montantCentimes !== attendu || prix.devise !== 'eur' || !recurrenceJuste) {
      journaliser('error', 'stripe_prix_pro_incoherent', {
        tenantId, periodicite, prix: prixId, attenduCentimes: attendu, luCentimes: prix.montantCentimes, devise: prix.devise,
        recurrence: prix.recurrence,
      });
      return refus(422, 'Le Pro est momentanément indisponible : son tarif est en cours de correction. Réessayez plus tard, ou contactez-nous.',
        { code: 'prix_incoherent' });
    }
    const session = await creerSessionAbonnement(s.transport, {
      cle: s.cle,
      tenantId,
      prix: prixId,
      customerId: await clientDeLEspace(d, s, tenantId),
      urlSucces: `${page(d, 'offre')}?pro=recu`,
      urlAbandon: `${page(d, 'offre')}?pro=abandon`,
      idempotence: `pro-${tenantId}-${randomUUID()}`,
      produit: 'pro',
      periodicite,
    });
    return { ok: true, valeur: { url: session.url, portail: false } };
  } catch (err) {
    if (!(err instanceof StripeError)) throw err;
    return refusDeStripe(err, tenantId, 'pro');
  }
}

/** Le portail de Stripe de l'espace (carte, factures, périodicité, résiliation), retour sur la page de l'offre. */
export function ouvrirPortailPro(d: DepsPro, tenantId: string, payeur: string): Promise<Issue<{ url: string }>> {
  return ouvrirPortail(d, tenantId, 'offre', payeur);
}
