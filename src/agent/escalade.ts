import type { AgentSessionStore } from './session-store';
import { SORTIE_HUMAIN } from './sorties';

/**
 * L'escalade d'une conversation d'agent vers un humain : clore la session, sortir du bloc, puis basculer le
 * fil. L'ordre est la seule chose que ce module apporte.
 *
 * 🔴 Basculer le fil ne suffit pas : `runControlSweep` rend au scénario un fil `app_human` après
 * `CONTROL_HUMAN_TIMEOUT_MS`, et l'agent reprendrait la conversation. D'où la session close et la sortie.
 * La bascule vient en dernier : `advance` s'arrête sur `mayAct` dès que le fil appartient à un humain, donc
 * basculer avant de sortir laisserait le run planté sur un bloc agent sans session. Elle se fait même si la
 * sortie n'a rien trouvé : le contact ne doit pas rester sans personne.
 *
 * Seul couple « clore puis sortir » qui ne pose pas la marque de tour en vol, et c'est voulu : une mort du
 * processus entre les deux est rattrapée au message suivant du contact (le cas probable, il vient de
 * demander un humain), où `advance` remonte la conversation en inbox et escalade. Le balayage qu'armerait
 * la marque ferait sortir le parcours sans escalader, donc une reprise muette. Une reprise automatique ne
 * vaut mieux que si elle produit le même état final.
 */
export function creerEscaladeVersHumain(deps: {
  sessions: Pick<AgentSessionStore, 'clore'>;
  /** Les parcours. `sortirDuBlocAgent` rend `false` si aucun parcours n'attendait sur un bloc agent. */
  parcours: { sortirDuBlocAgent(tenantId: string, waId: string, sessionId: string, sortie: string): Promise<boolean> };
  /**
   * La bascule du détenteur du fil (`escalateToHuman` du câblage, `only: ['app_workflow']`). Rend `true`
   * seulement si elle a vraiment basculé : le tour s'en sert pour savoir s'il peut écrire une dernière
   * phrase, et relire le détenteur à la place rouvrirait la course avec un opérateur. `agentId` : l'agent qui
   * passe la main, que le câblage nomme dans la cause de l'événement `escaladee` (migration 0194).
   */
  escalateToHuman(tenantId: string, waId: string, agentId: string): Promise<boolean>;
  /** Handle emprunté à la sortie du bloc. Le client le câble vers ce qu'il veut voir après une escalade. */
  sortie?: string;
}): (input: { tenantId: string; waId: string; runId: string; sessionId: string; agentId: string }) => Promise<boolean> {
  const sortie = deps.sortie ?? SORTIE_HUMAIN;
  return async ({ tenantId, waId, sessionId, agentId }) => {
    await deps.sessions.clore(tenantId, sessionId, 'sortie', sortie);
    await deps.parcours.sortirDuBlocAgent(tenantId, waId, sessionId, sortie);
    return deps.escalateToHuman(tenantId, waId, agentId);
  };
}
