import type { RcsProvider, RcsOutbound } from './types';
import type { Reachability } from './reachability';
import type { SendResult } from '../meta/types';

export interface RcsOptoutStore {
  isOptedOut(tenantId: string, e164: string): Promise<boolean>;
}

export type RcsSendOutcome = SendResult | { skipped: 'not_rcs_reachable' | 'rcs_optout' };

/**
 * Point de passage UNIQUE de tout envoi RCS (campagne comme scénario).
 *
 * Le refus d'opt-out vit ICI, pas chez l'appelant : un appelant qui oublie la vérification, c'est un STOP non
 * respecté, donc un agent suspendu par l'opérateur. L'ordre compte : opt-out d'abord, joignabilité ensuite,
 * car interroger la capacité d'un numéro qui nous a dit STOP est inutile et coûte un appel.
 */
export class RcsSender {
  constructor(
    private readonly provider: RcsProvider,
    private readonly reach: Reachability,
    private readonly optout: RcsOptoutStore,
  ) {}

  async sendTo(
    tenantId: string,
    agentId: string,
    e164: string,
    msg: RcsOutbound,
    messageId: string,
  ): Promise<RcsSendOutcome> {
    if (await this.optout.isOptedOut(tenantId, e164)) return { skipped: 'rcs_optout' };
    if (!(await this.reach.isReachable(agentId, e164))) return { skipped: 'not_rcs_reachable' };
    return this.provider.send(agentId, e164, msg, messageId);
  }
}
