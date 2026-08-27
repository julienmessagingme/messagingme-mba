import type { AgentSessionStore } from './session-store';

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
  const sortie = deps.sortie ?? 'humain';
  return async ({ tenantId, waId, sessionId }) => {
    await deps.sessions.clore(tenantId, sessionId, 'sortie', sortie);
    await deps.sortirDuBlocAgent(tenantId, waId, sessionId, sortie);
    await deps.escalateToHuman(tenantId, waId);
  };
}
