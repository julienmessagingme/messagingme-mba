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

export type RcsSuggestion =
  | { kind: 'reply'; text: string; postbackData: string }
  | { kind: 'openUrl'; text: string; url: string; postbackData: string }
  | { kind: 'dial'; text: string; phoneNumber: string; postbackData: string };

export interface RcsCard {
  title: string;
  description?: string;
  mediaUrl?: string;
  suggestions?: RcsSuggestion[];
}

export type RcsOutbound =
  | { kind: 'text'; text: string; suggestions?: RcsSuggestion[] }
  | { kind: 'card'; card: RcsCard }
  | { kind: 'carousel'; cards: RcsCard[] };

/** Ce que l'appareil du destinataire sait faire. En V1 on ne lit que la PRÉSENCE de la réponse : joignable
 *  ou non. La liste servira le jour où l'on adapte le contenu aux capacités (carrousel vs carte simple). */
export interface RcsCapabilities {
  features: string[];
}

export interface RcsProvider {
  /** null = numéro NON joignable en RCS. Ce n'est PAS une erreur, c'est une information. */
  capabilities(agentId: string, e164: string): Promise<RcsCapabilities | null>;
  /**
   * `messageId` est fourni par l'APPELANT : la plateforme RBM ignore un identifiant déjà utilisé pour cet
   * agent, ce qui rend l'envoi idempotent malgré un rejeu de la file. C'est la même garantie que le claim
   * atomique de `campaign_recipients`, mais côté opérateur.
   */
  send(agentId: string, e164: string, msg: RcsOutbound, messageId: string): Promise<SendResult>;
}
