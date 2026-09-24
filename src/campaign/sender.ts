import type { Recipient } from './types';
import type { SendResult } from '../meta/types';
import type { RcsSender } from '../rcs/sender';
import type { RcsOutbound } from '../rcs/types';
import { aDesVariables, appliquerVariables, fusionnerVariables } from '../rcs/variables';
import { aDesLiensTracables } from '../links/rcs-liens';

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
  /** `jeton` = le jeton public du destinataire, écrit dans les liens tracés du message pour savoir QUI a
   *  cliqué. Absent = lien tracé mais anonyme. */
  sendTo(recipient: Pick<Recipient, 'id' | 'toE164' | 'variables'>, jeton?: string): Promise<SendResult | { skipped: string }>;
  /**
   * Ce sender a-t-il besoin qu'on lui fournisse un jeton par destinataire ?
   *
   * Calculé UNE fois sur le message de la campagne, pas par destinataire : c'est ce qui évite au moteur de
   * fabriquer des jetons pour toute une liste quand le message ne porte aucun lien. On ne crée pas
   * d'identifiants pour des gens à qui on n'envoie rien à cliquer.
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
    // Lu sur le message FIGÉ de la campagne : la résolution des variables par destinataire ne touche pas les
    // URL (règle de `src/rcs/variables.ts`), donc la réponse est la même pour tout le monde.
    aBesoinDeJeton: aDesLiensTracables(o.message),
    async sendTo(recipient, jeton) {
      // Les variables du DESTINATAIRE s'appliquent même sans résolution de fiche câblée : elles viennent de
      // l'envoi, pas de la base. La fiche ne complète que ce qu'elles ne disent pas.
      const aResoudre = o.varsFor !== undefined || (recipient.variables != null && aDesVariables(o.message));
      const message = aResoudre
        ? appliquerVariables(o.message, fusionnerVariables(o.varsFor ? await o.varsFor(o.tenantId, recipient.toE164) : {}, recipient.variables))
        : o.message;
      return o.rcs.sendTo(o.tenantId, o.agentId, recipient.toE164, message, recipient.id, jeton);
    },
  };
}
