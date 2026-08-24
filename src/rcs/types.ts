/**
 * Modèle de message RCS et adaptateur provider. PUR : aucune IO, aucun couplage à Google.
 *
 * L'union est FERMÉE et volontairement petite : ce qui n'est pas ici ne s'envoie pas, plutôt qu'un `unknown`
 * qui laisserait remonter n'importe quel payload jusqu'à l'opérateur. Elle s'élargira au besoin réel.
 *
 * L'interface `RcsProvider` est le seul point de contact avec l'extérieur : une implémentation factice
 * aujourd'hui (lot 1), une implémentation Google demain (lot 2), un hub agrégateur si un opérateur français
 * l'impose. Le reste du code ne voit que cette interface.
 */
import type { SendResult } from '../meta/types';

/**
 * Bouton affiché sous un message. Les SIX formes du provider, aucune de plus.
 *
 * Trois d'entre elles ramènent le contact dans la conversation ou l'en sortent (`reply`, `openUrl`, `dial`) ;
 * les trois autres agissent sur son téléphone : ajouter un rendez-vous à son agenda, ouvrir un lieu sur sa
 * carte, ou partager sa position. Seul `reply` produit une sortie reliable dans un scénario : les cinq autres
 * ne renvoient rien qui permette de choisir une branche (une position partagée revient SANS `postbackData`,
 * mesuré sur leur spec).
 */
export type RcsSuggestion =
  | { kind: 'reply'; text: string; postbackData: string }
  | { kind: 'openUrl'; text: string; url: string; postbackData: string }
  | { kind: 'dial'; text: string; phoneNumber: string; postbackData: string }
  /**
   * Ajouter un rendez-vous à l'agenda. `startAt`/`endAt` sont des date-heures ISO locales
   * (`2026-09-01T10:00:00`) OU une variable `{{champ}}` résolue par contact : un message de bibliothèque est
   * réutilisable, une date en dur y serait vraie une fois et fausse ensuite. Une date qui ne se résout pas
   * fait TOMBER LE BOUTON, jamais le message.
   */
  | { kind: 'calendar'; text: string; postbackData: string; title: string; description?: string; startAt: string; endAt: string }
  /** Ouvrir un lieu sur la carte du contact. */
  | { kind: 'showLocation'; text: string; postbackData: string; latitude: number; longitude: number; label?: string }
  /** Demander sa position au contact. Sa réponse arrive dans l'inbox avec ses coordonnées, PAS sur une
   *  branche de scénario : le provider ne renvoie aucune charge utile avec une position. */
  | { kind: 'requestLocation'; text: string; postbackData: string };

/**
 * Carte : le format à VISUEL, celui qui porte une image (ou une vidéo) au-dessus du texte.
 *
 * `title` est optionnel : une carte de campagne est le plus souvent une image + un texte + des boutons, sans
 * titre. Le provider exige « un titre OU un média », c'est le schéma zod qui tient cette règle.
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
  /** `suggestions` = les PASTILLES sous le message (11 max), éphémères, distinctes des 4 boutons pleine
   *  largeur de la carte (`card.suggestions`), qui eux restent affichés. */
  | { kind: 'card'; card: RcsCard; suggestions?: RcsSuggestion[] }
  | { kind: 'carousel'; cards: RcsCard[] };

/** Ce que l'appareil du destinataire sait faire. En V1 on ne lit que la PRÉSENCE de la réponse : joignable
 *  ou non. La liste servira le jour où l'on adapte le contenu aux capacités (carrousel vs carte simple). */
export interface RcsCapabilities {
  features: string[];
}

export interface RcsProvider {
  /**
   * Ce provider sait-il DIRE si un numéro est joignable AVANT d'envoyer ? Google le sait (`getCapabilities`),
   * smsmode NON : son `lookup` est l'opérateur renvoyé avec le rapport de livraison, donc après coup.
   * `false` -> l'appelant saute la vérification préalable au lieu de payer un aller-retour pour une constante,
   * et la sortie « non joignable » du bloc est alimentée par le rapport de livraison. Absent = true
   * (comportement historique du provider factice).
   */
  readonly canCheckReachability?: boolean;
  /** null = numéro NON joignable en RCS. Ce n'est PAS une erreur, c'est une information. */
  capabilities(tenantId: string, agentId: string, e164: string): Promise<RcsCapabilities | null>;
  /**
   * `messageId` est fourni par l'APPELANT : la plateforme RBM ignore un identifiant déjà utilisé pour cet
   * agent, ce qui rend l'envoi idempotent malgré un rejeu de la file. C'est la même garantie que le claim
   * atomique de `campaign_recipients`, mais côté opérateur.
   */
  send(tenantId: string, agentId: string, e164: string, msg: RcsOutbound, messageId: string): Promise<SendResult>;
}
