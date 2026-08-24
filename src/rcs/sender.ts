import type { RcsProvider, RcsOutbound } from './types';
import type { Reachability } from './reachability';
import type { SendResult } from '../meta/types';
import { normaliserPostbacks } from './schema';

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
    // Vérification préalable SEULEMENT si le provider sait la faire. Chez smsmode elle n'existe pas : la
    // demander quand même reviendrait à écrire « joignable » en cache pour tout le monde, ce qui rendrait la
    // sortie « non joignable » du bloc muette tout en payant un aller-retour en base par destinataire.
    if (this.provider.canCheckReachability !== false && !(await this.reach.isReachable(tenantId, agentId, e164))) {
      return { skipped: 'not_rcs_reachable' };
    }
    // Charges utiles des boutons normalisées ICI, au dernier moment et pour TOUS les appelants : c'est ce qui
    // fait qu'un clic revient sur la bonne branche du scénario (cf. `normaliserPostbacks`). Le faire au point
    // de passage unique évite d'avoir à y penser dans chaque appelant, ce qui est exactement le genre d'oubli
    // qui se voit six mois plus tard, sur le clic d'un client.
    return this.provider.send(tenantId, agentId, e164, normaliserPostbacks(msg), messageId);
  }
}
