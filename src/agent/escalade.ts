import type { AgentSessionStore } from './session-store';
import { SORTIE_HUMAIN } from './sorties';

/**
 * L'escalade d'une conversation d'agent vers un humain, en TROIS effets et dans CET ordre.
 *
 * C'est un module à part, minuscule, parce que l'ordre est la seule chose qu'il apporte, et que cet ordre est
 * contre-intuitif : deux pièges vérifiés le commandent, chacun invisible depuis l'endroit d'où l'on appelle.
 *
 * 🔴 PIÈGE 1, pourquoi il ne suffit pas de basculer le fil. `runControlSweep` (`src/worker.ts`) rend
 * AUTOMATIQUEMENT au scénario un fil tenu par `app_human` après `CONTROL_HUMAN_TIMEOUT_MS`. Si l'outil se
 * contentait de changer le détenteur, l'humain traiterait, le balayage rendrait la main, et l'agent
 * reprendrait la conversation qu'un humain avait récupérée. Silencieux, et très désagréable côté client.
 *
 * 🔴 PIÈGE 2, pourquoi la bascule vient EN DERNIER. `advance` sort en premier sur `mayAct`
 * (`src/workflow/executor.ts`) : dès que le fil appartient à un humain, plus aucun parcours n'avance.
 * Basculer AVANT de sortir du bloc rendrait donc la sortie inopérante, et le run resterait planté pour
 * toujours sur un bloc agent dont la session est close, c'est-à-dire l'état incohérent qu'`advance` remonte
 * en inbox avec une trace d'erreur.
 *
 * La bascule reste faite MÊME si la sortie n'a rien trouvé à avancer : le but premier est qu'un humain
 * reprenne la conversation, et un run introuvable ne doit pas laisser le contact sans personne.
 *
 * ⚠️ POURQUOI CE CHEMIN NE PASSE PAS PAR `cloreEtSortir`, ET POURQUOI C'EST UN CHOIX (2026-09-03).
 *
 * Le contre-contre-rapport a raison sur les faits : c'est le SEUL couple « clore puis sortir » du dépôt qui
 * ne préserve pas la marque de tour en vol, donc une mort du processus entre les deux laisse un run planté
 * qu'aucun balayage ne désigne. On ne le corrige pas, et la raison n'est pas la paresse : **poser la marque
 * ici DÉGRADE le cas le plus probable.**
 *
 * Le rattrapage existe déjà, et il est meilleur que le balayage : au message suivant du contact, `advance`
 * reconnaît « un run sur un bloc agent sans session vivante », remonte la conversation en inbox ET appelle
 * `escalateToHuman`, c'est-à-dire exactement l'état visé. Or ce message suivant est ici le cas le PLUS
 * probable, à l'inverse du constat A1 : le contact vient de demander un humain et reste devant un silence
 * total, donc il réécrit. Avec la marque, le balayage prendrait la main à la quinzième minute et ferait
 * sortir le parcours ; si cette branche ne rappelle pas elle-même l'escalade, plus personne ne récupère le
 * fil, et on aurait remplacé une reprise correcte par une reprise muette.
 *
 * S'ajoute que la fenêtre est étroite : une exception ORDINAIRE de la sortie est rattrapée par le tronc
 * commun des outils, le tour continue et toutes ses suites reconvergent. Seule la mort du processus dans
 * l'intervalle d'un aller-retour SQL laisse l'état orphelin.
 *
 * 🔴 La règle générale, et elle vaut au-delà de ce fichier : **une reprise automatique ne vaut mieux qu'une
 * reprise existante que si elle produit le MÊME état final.** Ici elle produirait un état différent et moins
 * bon, donc l'uniformité serait une régression déguisée en cohérence.
 */
export function creerEscaladeVersHumain(deps: {
  sessions: Pick<AgentSessionStore, 'clore'>;
  /** `WorkflowExecutor.sortirDuBlocAgent`. Rend `false` si aucun parcours n'attendait sur un bloc agent. */
  sortirDuBlocAgent(tenantId: string, waId: string, sessionId: string, sortie: string): Promise<boolean>;
  /** La bascule du détenteur du fil (`escalateToHuman` du câblage, avec son `only: ['app_workflow']`). */
  escalateToHuman(tenantId: string, waId: string): Promise<void>;
  /** Handle emprunté à la sortie du bloc. Le client le câble vers ce qu'il veut voir après une escalade. */
  sortie?: string;
}): (input: { tenantId: string; waId: string; runId: string; sessionId: string }) => Promise<void> {
  const sortie = deps.sortie ?? SORTIE_HUMAIN;
  return async ({ tenantId, waId, sessionId }) => {
    await deps.sessions.clore(tenantId, sessionId, 'sortie', sortie);
    await deps.sortirDuBlocAgent(tenantId, waId, sessionId, sortie);
    await deps.escalateToHuman(tenantId, waId);
  };
}
