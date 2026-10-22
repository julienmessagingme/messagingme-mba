/**
 * LES MESSAGES SHOPIFY, CE QUE LA CONSOLE ET LE SERVEUR PARTAGENT (conception 2026-10-22) : les événements, les données
 * que chacun sait remplir, les textes que l'assistant propose, le pied de la relance, les valeurs d'exemple (l'aperçu
 * WhatsApp de la console, et les exemples que Meta exige pour chaque variable).
 *
 * 🔴 UNE SEULE SOURCE : le serveur (`src/shopify/donnees.ts`, `src/shopify/preparation.ts`) les importe d'ici. Un texte
 * proposé que la console afficherait et que le serveur refuserait serait une panne que le marchand ne comprendrait pas.
 */

export const EVENEMENTS_SHOPIFY = ['order_paid', 'order_fulfilled', 'checkout_abandoned'] as const;
export type EvenementShopify = (typeof EVENEMENTS_SHOPIFY)[number];

export const DONNEES_SHOPIFY = [
  'first_name', 'order_number', 'order_total', 'order_status_url', 'carrier', 'tracking_number', 'tracking_url', 'checkout_url',
] as const;
export type DonneeShopify = (typeof DONNEES_SHOPIFY)[number];

/** Ce que chaque événement sait remplir : une variable hors de cette liste est refusée. */
export const DONNEES_PAR_EVENEMENT: Readonly<Record<EvenementShopify, readonly DonneeShopify[]>> = {
  order_paid: ['first_name', 'order_number', 'order_total', 'order_status_url'],
  order_fulfilled: ['first_name', 'order_number', 'carrier', 'tracking_number', 'tracking_url'],
  checkout_abandoned: ['first_name', 'checkout_url'],
};

/** Les libellés des messages, dans la carte et les e-mails. */
export const LIBELLES_EVENEMENTS: Readonly<Record<EvenementShopify, readonly [string, string]>> = {
  order_paid: ['Commande payée', 'Order paid'],
  order_fulfilled: ['Commande expédiée', 'Order shipped'],
  checkout_abandoned: ['Relance de panier abandonné', 'Abandoned checkout reminder'],
};

/** Les libellés des données, sur les pastilles bleues de l'assistant. */
export const LIBELLES_DONNEES: Readonly<Record<DonneeShopify, readonly [string, string]>> = {
  first_name: ['prénom', 'first name'],
  order_number: ['numéro de commande', 'order number'],
  order_total: ['montant', 'total'],
  order_status_url: ['lien de la commande', 'order link'],
  carrier: ['transporteur', 'carrier'],
  tracking_number: ['numéro de suivi', 'tracking number'],
  tracking_url: ['lien de suivi', 'tracking link'],
  checkout_url: ['lien du panier', 'checkout link'],
};

/** Les valeurs d'exemple : l'aperçu de la console, et les exemples que Meta exige pour chaque variable. */
export const EXEMPLES_DONNEES: Readonly<Record<DonneeShopify, string>> = {
  first_name: 'Camille',
  order_number: '#1002',
  order_total: '42,00 €',
  order_status_url: 'https://ma-boutique.myshopify.com/commandes/1002',
  carrier: 'Colissimo',
  tracking_number: '6A12345678901',
  tracking_url: 'https://www.laposte.fr/outils/suivre-vos-envois?code=6A12345678901',
  checkout_url: 'https://ma-boutique.myshopify.com/checkouts/recover',
};

/**
 * Les textes proposés par l'assistant, un par message et par langue. Ils finissent par une phrase : Meta refuse un corps
 * qui commence ou finit par une variable.
 */
export const TEXTES_PROPOSES: Readonly<Record<EvenementShopify, Readonly<Record<'fr' | 'en', string>>>> = {
  order_paid: {
    fr: 'Bonjour {{first_name}}, merci pour votre commande {{order_number}} de {{order_total}}.\nSuivez-la ici : {{order_status_url}}\nÀ très vite !',
    en: 'Hello {{first_name}}, thank you for your order {{order_number}} of {{order_total}}.\nTrack it here: {{order_status_url}}\nSee you soon!',
  },
  order_fulfilled: {
    fr: 'Bonjour {{first_name}}, votre commande {{order_number}} est en route avec {{carrier}}.\nSuivez votre colis : {{tracking_url}}\nÀ très vite !',
    en: 'Hello {{first_name}}, your order {{order_number}} is on its way with {{carrier}}.\nTrack your parcel: {{tracking_url}}\nSee you soon!',
  },
  checkout_abandoned: {
    fr: 'Bonjour {{first_name}}, vous avez laissé des articles dans votre panier.\nIl vous attend ici : {{checkout_url}}\nÀ très vite !',
    en: 'Hello {{first_name}}, you left items in your cart.\nIt is waiting for you here: {{checkout_url}}\nSee you soon!',
  },
};

/**
 * Le pied de la relance : pas de bouton, qu'un clic ne désabonnerait pas, mais la consigne de répondre STOP, qu'une
 * réponse texte « STOP » applique déjà.
 */
export const PIED_STOP: Readonly<Record<'fr' | 'en', string>> = {
  fr: 'Répondez STOP pour ne plus recevoir ces messages',
  en: 'Reply STOP to stop these messages',
};

/** La langue du pied : le français pour une langue française, l'anglais sinon (une seule règle, console et serveur). */
export const langueDuPied = (langue: string): 'fr' | 'en' => (langue.toLowerCase().startsWith('fr') ? 'fr' : 'en');

/** Le délai d'une relance de panier, en minutes (décision de Julien : 1 h par défaut, de 15 min à 72 h). */
export const DELAI_PANIER_MIN = 15;
export const DELAI_PANIER_MAX = 4320;
export const DELAI_PANIER_DEFAUT = 60;
/** Les délais que l'assistant propose d'un clic (maquette validée) ; « autre » ouvre un champ jusqu'à 72 h. */
export const DELAIS_PROPOSES: readonly number[] = [15, 60, 180, 1440];

/** Le texte d'un modèle tel que le client le recevra : chaque repère remplacé par sa valeur d'exemple. */
export function apercuDuTexte(texte: string): string {
  return texte.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (tout, cle: string) =>
    ((DONNEES_SHOPIFY as readonly string[]).includes(cle) ? EXEMPLES_DONNEES[cle as DonneeShopify] : tout));
}
