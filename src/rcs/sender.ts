import type { RcsProvider, RcsOutbound } from './types';
import type { Reachability } from './reachability';
import type { SendResult } from '../meta/types';
import { normaliserPostbacks } from './schema';
import { elaguerBoutonsInvalides } from './variables';

export interface RcsOptoutStore {
  isOptedOut(tenantId: string, e164: string): Promise<boolean>;
}

/**
 * Remplace les liens du message par nos adresses de redirection (migration 0107). Optionnel : absent, les
 * messages partent avec les adresses saisies et aucun clic n'est mesuré, ce qui est le comportement d'avant.
 */
export interface TraceurLiens {
  tracer(tenantId: string, msg: RcsOutbound, jeton?: string): Promise<RcsOutbound>;
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
    private readonly traceur?: TraceurLiens,
  ) {}

  /**
   * `jeton` = le jeton public du destinataire, celui qui fera savoir QUI a cliqué. Facultatif à dessein : les
   * chemins qui ne connaissent pas le contact envoient un lien tracé mais ANONYME, et c'est une dégradation
   * de la mesure, jamais un échec d'envoi.
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
    // Vérification préalable SEULEMENT si le provider sait la faire. Chez smsmode elle n'existe pas : la
    // demander quand même reviendrait à écrire « joignable » en cache pour tout le monde, ce qui rendrait la
    // sortie « non joignable » du bloc muette tout en payant un aller-retour en base par destinataire.
    if (this.provider.canCheckReachability !== false && !(await this.reach.isReachable(tenantId, agentId, e164))) {
      return { skipped: 'not_rcs_reachable' };
    }
    // Deux mises en forme ICI, au dernier moment et pour TOUS les appelants, parce que c'est le point de
    // passage unique : y penser dans chaque appelant serait exactement le genre d'oubli qui se voit six mois
    // plus tard, sur le clic d'un client.
    //   - `elaguerBoutonsInvalides` retire un bouton Agenda dont la date ne s'est pas résolue. Le message
    //     part amputé de ce bouton plutôt que d'être refusé en entier par le provider.
    //   - `normaliserPostbacks` fait qu'un clic revient sur la bonne branche du scénario.
    //   - le traceur remplace les liens par nos adresses de redirection, jeton du destinataire compris. Ici et
    //     pas chez l'appelant, pour la même raison que les deux autres : quatre chemins envoient du RCS, et
    //     un traçage écrit quatre fois est un traçage oublié une fois.
    const elague = elaguerBoutonsInvalides(msg);
    if (elague !== msg) {
      // Un bouton qui disparaît sans un mot est indébogable : l'opérateur voit un message « parti » et un
      // client qui n'a jamais eu son bouton Agenda. On NOMME la cause, sans jamais bloquer l'envoi.
      // eslint-disable-next-line no-console
      console.error(`RCS ${tenantId}: bouton Agenda retiré pour ${e164}, sa date ne s'est pas résolue`);
    }
    const normalise = normaliserPostbacks(elague);
    // Le traçage est le DERNIER geste : ce qui part chez l'opérateur est exactement ce qu'on a tracé. Son
    // échec est déjà absorbé à l'intérieur (adresse d'origine conservée) ; le `catch` ici couvre le cas où le
    // traceur lui-même est en défaut, pour que l'envoi parte quand même.
    const aEnvoyer = this.traceur
      ? await this.traceur.tracer(tenantId, normalise, jeton).catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error(`RCS ${tenantId}: traçage des liens ignoré:`, err instanceof Error ? err.message : err);
        return normalise;
      })
      : normalise;
    return this.provider.send(tenantId, agentId, e164, aEnvoyer, messageId);
  }
}
