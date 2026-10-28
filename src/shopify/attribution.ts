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
