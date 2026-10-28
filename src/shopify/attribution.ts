import { montantBoutique, telephoneDeCommande, type CommandeShopify } from './donnees';
import type { BoutiqueRecue, DepsTraitementShopify } from './traitement';

/**
 * LE CHIFFRE D'AFFAIRES ATTRIBUÉ (spec docs/superpowers/specs/2026-10-28-revenus-attribues-design.md) : une commande
 * payée d'un contact connu revient à UNE source, et cette attribution est figée à la réception (`ventes_attribuees`,
 * migration 0261).
 *
 * Shopify dit qu'un client a acheté ; il ne dit pas qu'il est passé par une conversation. Le lien, c'est nous qui le
 * faisons, par le numéro de la commande : une concordance dans le temps, sauf deux preuves (le panier relancé payé, la
 * visite que Shopify rattache à nos UTM).
 */

export type SourceVente = 'campagne' | 'relance_panier' | 'scenario' | 'agent' | 'agent_meta';

/** Un envoi d'une source, livré au contact (ou parti, là où aucun accusé n'existe). */
export interface Touche {
  source: SourceVente;
  le: Date;
  /** La campagne d'une touche `campagne` ; `null` pour les autres, relance comprise. */
  campaignId: string | null;
  /** Le nom du modèle envoyé, quand il y en a un : la preuve par UTM le retrouve. */
  modele: string | null;
  /** Une campagne qui lance un scénario : les messages du scénario lui reviennent. */
  lanceScenario: boolean;
}

export interface VenteAttribuee {
  source: SourceVente;
  campaignId: string | null;
  preuve: 'panier' | 'utm' | null;
  /** La date de la relance, pour une vente attribuée à une relance de panier (et pour elle seule). */
  relanceLe: Date | null;
}

/**
 * 🔴 LES NOMS DES LIGNES SHOPIFY DE CAMPAGNES SONT UN CONTRAT : l'envoi public crée une ligne `campaigns` par message
 * Shopify, sous ces noms, et l'attribution les reconnaît par eux (la relance est une source, la confirmation et
 * l'expédition jamais). Les écrire ailleurs qu'ici ferait diverger la lecture de l'écriture en silence.
 */
export const PREFIXE_LIGNE_SHOPIFY = 'Shopify · ';
export const LIGNE_RELANCE_PANIER = `${PREFIXE_LIGNE_SHOPIFY}panier abandonné`;

/** La fenêtre entre l'envoi et le paiement : fixe, la même pour tous les espaces (décision de Julien du 2026-10-28). */
export const FENETRE_ATTRIBUTION_JOURS = 5;
const FENETRE_MS = FENETRE_ATTRIBUTION_JOURS * 86_400_000;

const venteDe = (t: Touche, preuve: VenteAttribuee['preuve']): VenteAttribuee => ({
  source: t.source, campaignId: t.campaignId, preuve, relanceLe: t.source === 'relance_panier' ? t.le : null,
});

/**
 * La source d'une commande payée, dans cet ordre (spec, « La règle d'attribution ») :
 * 1. elle paie un panier relancé : la relance, prouvée, même si un autre envoi a suivi ;
 * 2. Shopify rattache sa visite à nos UTM : la touche du modèle nommé, prouvée, sans limite de fenêtre ;
 * 3. sinon le dernier envoi de la fenêtre, non prouvé. Un scénario lancé par une campagne revient à cette campagne ;
 * 4. sinon rien.
 */
export function choisirSource(e: {
  payeeLe: Date;
  touches: readonly Touche[];
  panierRelance: { relanceLe: Date } | null;
  toucheUtm: Touche | null;
}): VenteAttribuee | null {
  if (e.panierRelance) return { source: 'relance_panier', campaignId: null, preuve: 'panier', relanceLe: e.panierRelance.relanceLe };
  if (e.toucheUtm) return venteDe(e.toucheUtm, 'utm');
  const paye = e.payeeLe.getTime();
  const fenetre = e.touches
    .filter((t) => t.le.getTime() <= paye && t.le.getTime() >= paye - FENETRE_MS)
    .sort((a, b) => b.le.getTime() - a.le.getTime());
  const gagnante = fenetre[0];
  if (!gagnante) return null;
  if (gagnante.source === 'scenario') {
    const campagne = fenetre.find((t) => t.source === 'campagne' && t.lanceScenario);
    if (campagne) return venteDe(campagne, null);
  }
  return venteDe(gagnante, null);
}

/**
 * Attribue une commande payée et la fige (`orders/paid`, plan 2026-10-28, tâche 4). Rien ne s'écrit pour une commande
 * sans téléphone, d'un numéro sans fiche (aucune fiche n'est créée : elle compterait dans la limite de l'offre), au
 * montant illisible, ou sans source. Le paiement se date par Shopify (`processed_at`), sinon par la réception.
 * La preuve par UTM attend le verdict du lot 0 : `toucheUtm` reste `null` d'ici là.
 */
export async function attribuerCommande(
  deps: Pick<DepsTraitementShopify, 'ventes' | 'ficheParTelephone' | 'filiere' | 'maintenant'>,
  b: Pick<BoutiqueRecue, 'tenantId' | 'pays' | 'devise'>,
  c: CommandeShopify,
): Promise<void> {
  const telephone = telephoneDeCommande(c, b.pays);
  if (telephone === null) return;
  const contactId = await deps.ficheParTelephone(b.tenantId, telephone);
  if (contactId === null) return;
  const montant = montantBoutique(c, b.devise);
  if (montant === null) return;
  const traitee = c.processed_at ? Date.parse(c.processed_at) : NaN;
  const payeeLe = new Date(Number.isNaN(traitee) ? (deps.maintenant ?? Date.now)() : traitee);
  const filiereApplication = (await deps.filiere(b.tenantId)) === 'application';
  const panierRelance = c.checkout_token ? await deps.ventes.panierRelance(b.tenantId, c.checkout_token) : null;
  const touches = panierRelance
    ? []
    : await deps.ventes.touches(b.tenantId, contactId, new Date(payeeLe.getTime() - FENETRE_MS), payeeLe, filiereApplication);
  const vente = choisirSource({ payeeLe, touches, panierRelance, toucheUtm: null });
  if (vente === null) return;
  await deps.ventes.enregistrer(b.tenantId, {
    commandeId: String(c.id), contactId, ...montant, payeeLe, test: c.test === true, ...vente,
  });
}
