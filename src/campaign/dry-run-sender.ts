import { randomUUID } from 'node:crypto';
import type { MessageSender } from './engine';
import type { SendResult, MarketingParams, TemplateSpec } from '../meta/types';

/**
 * Sender de DÉMO : n'appelle jamais Meta, renvoie un message-id synthétique. Permet de faire
 * tourner une campagne de bout en bout (statuts pending -> sent) sans numéro réel ni token.
 * En prod réelle, remplacé par MetaClient (DRY_RUN=false).
 */
export class DryRunSender implements MessageSender {
  async sendMarketing(params: MarketingParams): Promise<SendResult> {
    return { messageId: `dryrun-${params.to ?? params.recipient ?? 'x'}-${randomUUID()}` };
  }
  async sendTemplate(to: string, _tpl: TemplateSpec): Promise<SendResult> {
    return { messageId: `dryrun-${to}-${randomUUID()}` };
  }
}
