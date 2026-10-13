/**
 * Adaptateur provider RCS, pur. `RcsProvider` est le seul point de contact avec l'extérieur. Le modèle du message
 * est partagé avec la console (`web/lib/partage/rcs.ts`) ; il est réexporté ici pour les modules du domaine RCS.
 */
import type { SendResult } from '../meta/types';
import type { RcsOutbound } from '../../web/lib/partage/rcs';

export type { RcsSuggestion, RcsCard, RcsOutbound } from '../../web/lib/partage/rcs';

/** Ce que l'appareil du destinataire sait faire. On ne lit que la présence de la réponse : joignable ou non. */
export interface RcsCapabilities {
  features: string[];
}

export interface RcsProvider {
  /**
   * Ce provider sait-il dire si un numéro est joignable avant d'envoyer ? Google oui (`getCapabilities`),
   * smsmode non (son `lookup` arrive avec le rapport de livraison). `false` : l'appelant saute la vérification,
   * et la sortie « non joignable » est alimentée par le rapport de livraison. Absent = true.
   */
  readonly canCheckReachability?: boolean;
  /** null = numéro non joignable en RCS. Ce n'est pas une erreur, c'est une information. */
  capabilities(tenantId: string, agentId: string, e164: string): Promise<RcsCapabilities | null>;
  /**
   * `messageId` est fourni par l'appelant : RBM ignore un identifiant déjà utilisé pour cet agent, ce qui rend
   * l'envoi idempotent malgré un rejeu de la file.
   */
  send(tenantId: string, agentId: string, e164: string, msg: RcsOutbound, messageId: string): Promise<SendResult>;
}
