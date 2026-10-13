/**
 * Le message RCS, tel que le serveur l'envoie et que la console le compose. L'union est fermée et petite : ce qui
 * n'est pas ici ne s'envoie pas. Le schéma `zod` qui le valide reste côté serveur (`src/rcs/schema.ts`).
 */

/** Longueur maximale d'un message RCS texte : le serveur refuse au-delà, l'écran le dit avant l'envoi. */
export const RCS_TEXTE_MAX = 3072;

/**
 * Bouton affiché sous un message : les six formes du provider, aucune de plus. Seul `reply` produit une
 * sortie reliable dans un scénario : les autres ne renvoient rien qui permette de choisir une branche (un lien
 * et un appel sortent de la conversation, une position partagée revient sans `postbackData`).
 */
export type RcsSuggestion =
  | { kind: 'reply'; text: string; postbackData: string }
  | { kind: 'openUrl'; text: string; url: string; postbackData: string }
  | { kind: 'dial'; text: string; phoneNumber: string; postbackData: string }
  /**
   * Ajouter un rendez-vous à l'agenda. `startAt`/`endAt` : date-heures ISO locales (`2026-09-01T10:00:00`) ou
   * une variable `{{champ}}` résolue par contact, un message de bibliothèque étant réutilisable. Une date qui
   * ne se résout pas fait tomber le bouton, jamais le message.
   */
  | { kind: 'calendar'; text: string; postbackData: string; title: string; description?: string; startAt: string; endAt: string }
  /** Ouvrir un lieu sur la carte du contact. */
  | { kind: 'showLocation'; text: string; postbackData: string; latitude: number; longitude: number; label?: string }
  /** Demander sa position au contact. Sa réponse arrive dans l'inbox avec ses coordonnées, pas sur une
   *  branche de scénario : le provider ne renvoie aucune charge utile avec une position. */
  | { kind: 'requestLocation'; text: string; postbackData: string };

/**
 * Carte : le format à visuel (image ou vidéo au-dessus du texte). `title` est optionnel : le provider exige
 * « un titre ou un média », règle tenue par le schéma du serveur.
 */
export interface RcsCard {
  title?: string;
  description?: string;
  mediaUrl?: string;
  /** Hauteur du visuel : SHORT (7:3), MEDIUM (2:1, défaut), TALL (16:9, la grande image de campagne). */
  mediaHeight?: 'SHORT' | 'MEDIUM' | 'TALL';
  suggestions?: RcsSuggestion[];
}

export type RcsOutbound =
  | { kind: 'text'; text: string; suggestions?: RcsSuggestion[] }
  /** `suggestions` = les pastilles sous le message (11 max), éphémères, distinctes des 4 boutons pleine
   *  largeur de la carte (`card.suggestions`), qui eux restent affichés. */
  | { kind: 'card'; card: RcsCard; suggestions?: RcsSuggestion[] }
  | { kind: 'carousel'; cards: RcsCard[] };
