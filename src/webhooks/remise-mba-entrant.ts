import { messageDe } from '../lib/erreur';
import type { EntrantRattache } from './rattachement';

/**
 * L'agent de Meta reprend la main quand un client revient et que personne ne suit. L'agent ne peut prendre un
 * fil que dans une session ouverte, qui s'ouvre exactement quand le client écrit : décidée à l'arrivée du
 * message, la passation fonctionne quel que soit le temps écoulé ; décidée avant, sur un fil muet, elle ne
 * transmet rien. Elle répare aussi une conversation née d'un envoi sortant (`control_owner = 'app_workflow'` par
 * défaut, `control_changed_at` null), que le balayage ignore et que « À traiter » exclut.
 */
export interface RemiseMbaEntrantDeps {
  /**
   * Rend le fil à l'agent de Meta si personne d'autre ne s'en occupe. Les gardes (agent allumé, aucun parcours en
   * attente, aucun humain dessus) vivent dans le câblage ; ce module ne sait que lire un payload Meta.
   */
  remettre(tenantId: string, waId: string): Promise<void>;
}

/**
 * Pour chaque message entrant d'un payload, rend le fil à l'agent de Meta quand personne ne suit.
 * `standby` est exclu : l'agent tient déjà le fil, un release serait au mieux inutile, au pire une reprise.
 * `consumed` est respecté : un message qui vient de démarrer un parcours, ou avalé par un jeton de test, n'est
 * pas un client qui revient sans que rien ne soit prévu. Isolé par message (Meta groupe plusieurs contacts) ; un
 * échec n'est jamais fatal, le balayage reste le filet.
 */
export async function processRemiseMbaEntrant(
  entrants: readonly EntrantRattache[],
  deps: RemiseMbaEntrantDeps,
  consumed?: ReadonlySet<string>,
): Promise<void> {
  for (const { message: m, tenantId } of entrants) {
    if (consumed?.has(m.messageId)) continue;
    // `field` absent = anciennes fixtures, traitées comme des messages normaux (rétro-compat, comme l'avance).
    if (m.field && m.field !== 'messages') continue;
    try {
      if (tenantId) await deps.remettre(tenantId, m.waId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('processRemiseMbaEntrant: remise ignorée:', messageDe(err));
    }
  }
}
