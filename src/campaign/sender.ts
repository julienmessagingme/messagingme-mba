import type { Recipient } from './types';
import type { SendResult } from '../meta/types';
import type { RcsSender } from '../rcs/sender';
import type { RcsOutbound } from '../rcs/types';
import { appliquerVariables } from '../rcs/variables';

/**
 * Seam d'envoi du moteur de campagne.
 *
 * Le moteur garde TOUS ses garde-fous (fréquence, claim atomique, markResult, recordOutbound) : ils sont déjà
 * canal-agnostiques. Seul l'ACTE d'envoyer varie d'un canal à l'autre, et c'est ce qu'on isole ici plutôt que
 * de dupliquer un moteur par canal.
 *
 * Le `messageId` passé au provider est l'id du DESTINATAIRE : il est stable d'un rejeu à l'autre, ce qui donne
 * l'idempotence côté opérateur en plus du claim atomique côté base.
 */
export interface CampaignSender {
  sendTo(recipient: Pick<Recipient, 'id' | 'toE164'>): Promise<SendResult | { skipped: string }>;
}

export interface RcsCampaignSenderOpts {
  channel: 'rcs';
  tenantId: string;
  agentId: string;
  message: RcsOutbound;
  rcs: RcsSender;
  /**
   * Table de substitution des variables `{{champ}}` de CE destinataire.
   *
   * Fourni SEULEMENT quand le message en porte : sinon la campagne paierait une lecture de fiche par
   * destinataire pour un message figé. Le chemin WhatsApp, lui, résout ses variables à la CONSTRUCTION de la
   * liste (`buildRecipients`), parce que Meta refuse un message dont une variable est vide et qu'il faut donc
   * pouvoir écarter le destinataire AVANT d'envoyer. Le RCS n'a pas cette contrainte : une variable vide
   * laisse un trou dans le texte, pas un rejet, donc on résout au moment de l'envoi, là où c'est le plus
   * simple à lire.
   */
  varsFor?: (tenantId: string, e164: string) => Promise<Record<string, string | null>>;
}

export function makeCampaignSender(o: RcsCampaignSenderOpts): CampaignSender {
  return {
    async sendTo(recipient) {
      const message = o.varsFor
        ? appliquerVariables(o.message, await o.varsFor(o.tenantId, recipient.toE164))
        : o.message;
      return o.rcs.sendTo(o.tenantId, o.agentId, recipient.toE164, message, recipient.id);
    },
  };
}
