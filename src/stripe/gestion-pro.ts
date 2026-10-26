import { randomUUID } from 'node:crypto';
import { changerFinAbonnement, lireAbonnementStripe, listerFacturesStripe, StripeError } from './client';
import type { DepsPaiement } from './paiement';
import { journaliser } from '../lib/journal';
import { refus, type Issue } from '../lib/issue';

/**
 * GÉRER LE PRO SANS QUITTER LA CONSOLE (2026-10-26, demande de Julien : « un lien clair » pour les factures et la
 * résiliation, tranché le même jour : les factures se LISTENT dans la console, la résiliation s'y FAIT). Le portail de
 * Stripe reste pour la carte bancaire.
 *
 * Même Stripe, mêmes clients et même règle du mode test que le paiement : en test, seul un exploitant (`payeurAutorise`).
 */
export type DepsGestionPro = Pick<DepsPaiement, 'stripe' | 'payeurAutorise'> & {
  clients: Pick<DepsPaiement['clients'], 'clientDe'>;
  /** Le Pro VIVANT de l'espace (`fini_le` nul), `null` sinon. */
  proVivant(tenantId: string): Promise<{ abonnementId: string } | null>;
  /**
   * La fin prévue relue chez Stripe, écrite comme `customer.subscription.updated` l'écrirait
   * (`PgAbonnementsOffreStore.modifier`) : l'écran est juste tout de suite, le webhook réécrit ensuite la même chose.
   */
  noterFinPrevue(abonnementId: string, finPrevueLe: Date | null): Promise<void>;
  /** Les identifiants Stripe des prix d'un siège (`STRIPE_PRIX_SIEGE_MOIS`, `_AN`) : le tarif sépare le Pro de ses sièges. */
  prixSiege: readonly string[];
};

/** Une panne passagère de Stripe (réseau, 5xx, 429) : l'appelant la laisse remonter, pour qu'elle se rejoue. */
const passagere = (err: StripeError): boolean => err.status === null || err.status === 429 || err.status >= 500;

/**
 * LA FIN PRÉVUE DU PRO, RELUE CHEZ STRIPE, pour `customer.subscription.updated` (relecture du lot A, 2026-10-26). La charge
 * d'un événement peut arriver après un plus récent : « Résilier » puis « Annuler la résiliation » en quelques secondes, et
 * le premier événement, rejoué en retard, remettait une fin que Stripe n'avait plus (avec l'e-mail de la suite du numéro).
 * L'abonnement relu est l'état de maintenant. `undefined` : Stripe n'est pas configuré, ou il refuse durablement ; la charge
 * de l'événement sert alors, comme avant. Une panne passagère lève : le webhook échoue, Stripe rejouera.
 */
export async function finPrevueChezStripe(d: Pick<DepsGestionPro, 'stripe'>, abonnementId: string): Promise<Date | null | undefined> {
  const s = d.stripe;
  if (s === null) return undefined;
  try {
    return (await lireAbonnementStripe(s.transport, { cle: s.cle, abonnementId })).finPrevueLe;
  } catch (err) {
    if (!(err instanceof StripeError) || passagere(err)) throw err;
    journaliser('error', 'stripe_fin_prevue_illisible', { abonnementId, status: err.status, code: err.code, err: err.message });
    return undefined;
  }
}

/**
 * LE TARIF RÉEL DU PRO DE L'ESPACE, lu sur son abonnement chez Stripe (relecture du lot B, 2026-10-26) : la carte disait le
 * prix de la grille, qui n'est plus celui d'un abonné le jour où le tarif change. Le Pro et ses sièges, prix unitaires HT
 * avant remise ; `remise` dit qu'un code promo s'applique (les factures disent alors le montant payé). Une lecture à
 * l'ouverture de la page, jamais dans la vue de l'offre, lue à chaque page de la console.
 */
export interface TarifPro {
  /** Le prix HT du Pro par période, en centimes ; `null` si une ligne n'a pas de prix fixe. */
  proHtCentimes: number | null;
  /** Le prix HT d'un utilisateur payé en plus, par période ; `null` sans siège payé. */
  siegeHtCentimes: number | null;
  remise: boolean;
}

export async function tarifDuPro(d: DepsGestionPro, tenantId: string, payeur: string): Promise<Issue<TarifPro>> {
  const s = d.stripe;
  if (s === null || !(await d.payeurAutorise(payeur))) return GESTION_INDISPONIBLE;
  const pro = await d.proVivant(tenantId);
  if (pro === null) return refus(409, 'Cet espace n’a pas de Pro en cours.', { code: 'aucun_pro' });
  try {
    const a = await lireAbonnementStripe(s.transport, { cle: s.cle, abonnementId: pro.abonnementId });
    const estSiege = (prix: string): boolean => d.prixSiege.includes(prix);
    const lignesPro = a.lignes.filter((l) => !estSiege(l.prix));
    const siege = a.lignes.find((l) => estSiege(l.prix) && l.quantite > 0);
    // UNE seule ligne hors sièges, sinon pas de prix : après un changement de tarif, un siège à l'ancien prix n'est plus
    // reconnu et s'ajouterait au Pro (relecture du 2026-10-26). La console garde alors la grille.
    const seule = lignesPro.length === 1 ? lignesPro[0]! : null;
    const proHtCentimes = seule !== null && seule.montantCentimes !== null ? seule.montantCentimes * seule.quantite : null;
    return { ok: true, valeur: { proHtCentimes, siegeHtCentimes: siege?.montantCentimes ?? null, remise: a.remise } };
  } catch (err) {
    if (!(err instanceof StripeError)) throw err;
    journaliser('error', 'stripe_tarif_pro_impossible', {
      tenantId, operation: err.operation, status: err.status, type: err.type, code: err.code, err: err.message,
    });
    return refus(422, 'Le tarif de votre abonnement n’a pas pu être lu chez Stripe.', { code: 'tarif_impossible' });
  }
}

export const GESTION_INDISPONIBLE = refus(503, 'la gestion de l’abonnement n’est pas encore disponible', { code: 'gestion_indisponible' });

/**
 * RÉSILIER LE PRO à la fin de la période payée (ou de l'essai), ou ANNULER cette résiliation tant que le Pro court. Rien
 * n'est remboursé : le Pro reste ouvert jusqu'à sa fin, puis l'espace repasse en Free (le webhook `deleted` le fait).
 */
export async function changerResiliationPro(
  d: DepsGestionPro, tenantId: string, resilier: boolean, payeur: string,
): Promise<Issue<{ finPrevueLe: string | null }>> {
  const s = d.stripe;
  if (s === null || !(await d.payeurAutorise(payeur))) return GESTION_INDISPONIBLE;
  const pro = await d.proVivant(tenantId);
  if (pro === null) return refus(409, 'Cet espace n’a pas de Pro en cours.', { code: 'aucun_pro' });
  try {
    const { finPrevueLe, finDatee } = await changerFinAbonnement(s.transport, {
      cle: s.cle, abonnementId: pro.abonnementId, resilier, idempotence: `resiliation-${pro.abonnementId}-${randomUUID()}`,
    });
    // Une fin datée, posée par nous au tableau de bord : on ne la retire pas d'ici (la facturation en dépend).
    if (finDatee) {
      journaliser('warn', 'pro_resiliation_datee_non_retiree', { tenantId, abonnementId: pro.abonnementId, finPrevueLe: finPrevueLe?.toISOString() ?? null });
      return refus(409, 'Cette résiliation a été posée à une date précise : contactez-nous pour la retirer.', { code: 'fin_datee' });
    }
    // 🔴 Stripe a changé : un échec d'écriture ici ne se dit pas en erreur au client. Le webhook réécrira la même fin.
    try {
      await d.noterFinPrevue(pro.abonnementId, finPrevueLe);
    } catch (err) {
      journaliser('error', 'pro_resiliation_non_ecrite', { tenantId, abonnementId: pro.abonnementId, err: err instanceof Error ? err.message : String(err) });
    }
    journaliser('info', resilier ? 'pro_resiliation_programmee' : 'pro_resiliation_annulee', {
      tenantId, abonnementId: pro.abonnementId, finPrevueLe: finPrevueLe?.toISOString() ?? null,
    });
    return { ok: true, valeur: { finPrevueLe: finPrevueLe?.toISOString() ?? null } };
  } catch (err) {
    if (!(err instanceof StripeError)) throw err;
    // Le message de Stripe parle de NOTRE compte : au journal, jamais au navigateur.
    journaliser('error', 'stripe_resiliation_pro_impossible', {
      tenantId, resilier, operation: err.operation, status: err.status, type: err.type, code: err.code, err: err.message,
    });
    return refus(422, resilier
      ? 'La résiliation n’a pas pu être enregistrée chez Stripe. Réessayez dans un instant ; si cela persiste, contactez-nous.'
      : 'L’annulation de la résiliation n’a pas pu être enregistrée chez Stripe. Réessayez dans un instant ; si cela persiste, contactez-nous.',
    { code: 'resiliation_impossible' });
  }
}

/** Combien de factures la console montre, les plus récentes : les autres restent sur le portail de Stripe. */
export const FACTURES_MONTREES = 24;

export type ObjetFacture = 'pro' | 'numero' | 'autre';
export type StatutFacture = 'payee' | 'a_regler' | 'impayee' | 'annulee';

export interface FactureEspace {
  id: string;
  numero: string | null;
  le: string;
  /** Ce qu'elle facture : le Pro ou le numéro (métadonnées de l'abonnement), sinon `autre` et son libellé de Stripe. */
  objet: ObjetFacture;
  libelle: string | null;
  /** TTC, en centimes (négatif pour un avoir). */
  totalCentimes: number;
  devise: string;
  statut: StatutFacture;
  urlPage: string | null;
  urlPdf: string | null;
}

const STATUTS: Readonly<Record<string, StatutFacture>> = { paid: 'payee', open: 'a_regler', uncollectible: 'impayee', void: 'annulee' };

/**
 * LES FACTURES DE L'ESPACE, Pro, numéro et recharges, les plus récentes d'abord. Les brouillons sont écartés (Stripe ne
 * les a pas encore émises), comme un statut inconnu. Sans client Stripe (l'espace n'a jamais payé) : une liste vide.
 * `plusSurStripe` : il y en a d'autres, plus anciennes, sur le portail.
 */
export async function facturesDeLEspace(
  d: DepsGestionPro, tenantId: string, payeur: string,
): Promise<Issue<{ factures: FactureEspace[]; plusSurStripe: boolean }>> {
  const s = d.stripe;
  if (s === null || !(await d.payeurAutorise(payeur))) return GESTION_INDISPONIBLE;
  const client = await d.clients.clientDe(tenantId, s.livemode);
  if (client === null) return { ok: true, valeur: { factures: [], plusSurStripe: false } };
  try {
    const r = await listerFacturesStripe(s.transport, { cle: s.cle, customerId: client, limite: FACTURES_MONTREES });
    if (r.ecartees > 0) journaliser('warn', 'stripe_factures_ecartees', { tenantId, ecartees: r.ecartees });
    const factures = r.factures.flatMap((f): FactureEspace[] => {
      const statut = f.statut === null ? undefined : STATUTS[f.statut];
      if (statut === undefined) return [];
      const objet: ObjetFacture = f.produit === 'pro' || f.produit === 'numero' ? f.produit : 'autre';
      return [{
        id: f.id, numero: f.numero, le: f.creeLe.toISOString(), objet, libelle: f.libelle, totalCentimes: f.totalCentimes,
        devise: f.devise, statut, urlPage: f.urlPage, urlPdf: f.urlPdf,
      }];
    });
    return { ok: true, valeur: { factures, plusSurStripe: r.plus } };
  } catch (err) {
    if (!(err instanceof StripeError)) throw err;
    journaliser('error', 'stripe_factures_impossible', {
      tenantId, operation: err.operation, status: err.status, type: err.type, code: err.code, err: err.message,
    });
    return refus(422, 'Vos factures n’ont pas pu être lues chez Stripe. Réessayez dans un instant.', { code: 'factures_impossible' });
  }
}
