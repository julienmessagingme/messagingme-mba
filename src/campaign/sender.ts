import type { Recipient } from './types';
import type { SendResult } from '../meta/types';
import type { RcsSender } from '../rcs/sender';
import type { RcsOutbound } from '../rcs/types';
import { aDesVariables, appliquerVariables, fusionnerVariables } from '../rcs/variables';
import { aDesLiensTracables } from '../links/rcs-liens';

/**
 * Seam d'envoi du moteur de campagne : les garde-fous du moteur (fréquence, claim atomique, markResult,
 * recordOutbound) sont indépendants du canal, seul l'acte d'envoyer varie.
 *
 * Le `messageId` passé au provider est l'id du destinataire : stable d'un rejeu à l'autre, il donne
 * l'idempotence côté opérateur en plus du claim atomique côté base.
 */
export interface CampaignSender {
  /** `jeton` = le jeton public du destinataire, écrit dans les liens tracés pour savoir qui a cliqué.
   *  Absent = lien tracé mais anonyme. */
  sendTo(recipient: Pick<Recipient, 'id' | 'toE164' | 'variables'>, jeton?: string): Promise<SendResult | { skipped: string }>;
  /**
   * Ce sender a-t-il besoin d'un jeton par destinataire ? Calculé une fois sur le message de la campagne, pour
   * ne pas fabriquer de jetons quand le message ne porte aucun lien.
   */
  readonly aBesoinDeJeton?: boolean;
}

export interface RcsCampaignSenderOpts {
  channel: 'rcs';
  tenantId: string;
  agentId: string;
  message: RcsOutbound;
  rcs: RcsSender;
  /**
   * Table de substitution des variables `{{champ}}` de ce destinataire, fournie seulement quand le message en
   * porte (sinon une lecture de fiche par destinataire pour rien). WhatsApp résout à la construction de la
   * liste parce que Meta refuse une variable vide ; en RCS, une variable vide laisse un trou, pas un rejet.
   */
  varsFor?: (tenantId: string, e164: string) => Promise<Record<string, string | null>>;
}

export function makeCampaignSender(o: RcsCampaignSenderOpts): CampaignSender {
  return {
    // Lu sur le message figé : la résolution des variables ne touche pas les URL (`src/rcs/variables.ts`).
    aBesoinDeJeton: aDesLiensTracables(o.message),
    async sendTo(recipient, jeton) {
      // Les variables du destinataire viennent de l'envoi, pas de la base : elles s'appliquent même sans
      // résolution de fiche câblée, la fiche ne complète que ce qu'elles ne disent pas.
      const aResoudre = o.varsFor !== undefined || (recipient.variables != null && aDesVariables(o.message));
      const message = aResoudre
        ? appliquerVariables(o.message, fusionnerVariables(o.varsFor ? await o.varsFor(o.tenantId, recipient.toE164) : {}, recipient.variables))
        : o.message;
      return o.rcs.sendTo(o.tenantId, o.agentId, recipient.toE164, message, recipient.id, jeton);
    },
  };
}
