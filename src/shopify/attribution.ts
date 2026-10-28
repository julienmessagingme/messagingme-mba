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
