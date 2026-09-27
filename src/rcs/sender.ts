import type { RcsProvider, RcsOutbound } from './types';
import type { Reachability } from './reachability';
import type { SendResult } from '../meta/types';
import { normaliserPostbacks } from './schema';
import { elaguerBoutonsInvalides } from './variables';
import { messageDe } from '../lib/erreur';

export interface RcsOptoutStore {
  isOptedOut(tenantId: string, e164: string): Promise<boolean>;
}

/**
 * Remplace les liens du message par nos adresses de redirection. Optionnel : absent, les messages partent
 * avec les adresses saisies et aucun clic n'est mesuré.
 */
export interface TraceurLiens {
  tracer(tenantId: string, msg: RcsOutbound, jeton?: string): Promise<RcsOutbound>;
}

export type RcsSendOutcome = SendResult | { skipped: 'not_rcs_reachable' | 'rcs_optout' };

/**
 * Point de passage unique de tout envoi RCS (campagne comme scénario).
 *
 * 🔴 Le refus d'opt-out vit ici, pas chez l'appelant : un appelant qui oublie la vérification, c'est un STOP
 * non respecté, donc un agent suspendu par l'opérateur. Opt-out d'abord, joignabilité ensuite : interroger
 * un numéro qui a dit STOP coûte un appel pour rien.
 */
export class RcsSender {
  constructor(
    private readonly provider: RcsProvider,
    private readonly reach: Reachability,
    private readonly optout: RcsOptoutStore,
    private readonly traceur?: TraceurLiens,
  ) {}

  /**
   * `jeton` = le jeton public du destinataire, qui dira qui a cliqué. Facultatif : sans lui le lien tracé est
   * anonyme, une dégradation de la mesure, jamais un échec d'envoi.
   */
  async sendTo(
    tenantId: string,
    agentId: string,
    e164: string,
    msg: RcsOutbound,
    messageId: string,
    jeton?: string,
  ): Promise<RcsSendOutcome> {
    if (await this.optout.isOptedOut(tenantId, e164)) return { skipped: 'rcs_optout' };
    // Vérification préalable seulement si le provider sait la faire : chez smsmode, la demander écrirait
    // « joignable » en cache pour tout le monde et rendrait muette la sortie « non joignable » du bloc.
    if (this.provider.canCheckReachability !== false && !(await this.reach.isReachable(tenantId, agentId, e164))) {
      return { skipped: 'not_rcs_reachable' };
    }
    // Mises en forme faites ici, pour tous les appelants :
    //   - `elaguerBoutonsInvalides` retire un bouton Agenda dont la date ne s'est pas résolue, plutôt que de voir
    //     le message entier refusé par le provider ;
    //   - `normaliserPostbacks` fait qu'un clic revient sur la bonne branche du scénario ;
    //   - le traceur remplace les liens par nos adresses de redirection, jeton du destinataire compris.
    const elague = elaguerBoutonsInvalides(msg);
    if (elague !== msg) {
      // On nomme la cause d'un bouton retiré, sans bloquer l'envoi : sinon il disparaîtrait sans trace.
      // eslint-disable-next-line no-console
      console.error(`RCS ${tenantId}: bouton Agenda retiré pour ${e164}, sa date ne s'est pas résolue`);
    }
    const normalise = normaliserPostbacks(elague);
    // Le traçage est le dernier geste : ce qui part est exactement ce qu'on a tracé. Un traceur en défaut ne
    // bloque pas l'envoi.
    const aEnvoyer = this.traceur
      ? await this.traceur.tracer(tenantId, normalise, jeton).catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error(`RCS ${tenantId}: traçage des liens ignoré:`, messageDe(err));
        return normalise;
      })
      : normalise;
    return this.provider.send(tenantId, agentId, e164, aEnvoyer, messageId);
  }
}
