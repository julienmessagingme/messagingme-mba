import type { Recipient } from './types';
import type { SendResult } from '../meta/types';
import type { RcsSender } from '../rcs/sender';
import type { RcsOutbound } from '../rcs/types';

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
}

export function makeCampaignSender(o: RcsCampaignSenderOpts): CampaignSender {
  return {
    async sendTo(recipient) {
      return o.rcs.sendTo(o.tenantId, o.agentId, recipient.toE164, o.message, recipient.id);
    },
  };
}
