/**
 * File `agent-turn` : le tour de l'agent IA (un appel LLM plus N outils, 3 à 20 s) se joue en tâche de fond.
 * En ligne dans le handler du webhook Meta, il tiendrait la connexion et ferait retenter le webhook.
 */

export const AGENT_TURN_QUEUE = 'agent-turn';

/**
 * Ce qui déclenche un tour : démarrage de session, ou message entrant du contact.
 *
 * Pas de raison « inactivité » : le réveil après silence passe par l'échéance du bloc Question (`resume_at`
 * puis le handle `timeout`) et ne produit aucun job. Un vocabulaire sans producteur finit remis en service
 * par erreur.
 */
export type RaisonTour = 'demarrage' | 'message';

/** Ce qui transite dans la file. `tenantId` porte explicitement : le worker ne le deduit de rien d'autre. */
export interface AgentTurnJob {
  tenantId: string;
  runId: string;
  sessionId: string;
  workflowId: string;
  nodeId: string;
  waId: string;
  raison: RaisonTour;
  /**
   * Numéro de tour attendu par le producteur, verrou optimiste : pg-boss est at-least-once, donc un job peut
   * être redélivré après que le contact a fait avancer le tour. Le consommateur ignore alors le job périmé.
   */
  tours: number;
}

const RAISONS: readonly RaisonTour[] = ['demarrage', 'message'];

/**
 * Relit défensivement le payload de la file (JSON opaque, parfois écrit par une version antérieure). Rend
 * `null` plutôt que de lever : un payload inexploitable ne doit pas boucler jusqu'à la DLQ. Un producteur
 * relit ce parseur avant de changer un champ : un job que le parseur refuse est perdu.
 */
export function parseAgentTurnJob(raw: unknown): AgentTurnJob | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const s = (k: string): string | null => (typeof o[k] === 'string' && o[k] ? (o[k] as string) : null);
  const tenantId = s('tenantId');
  const runId = s('runId');
  const sessionId = s('sessionId');
  const workflowId = s('workflowId');
  const nodeId = s('nodeId');
  const waId = s('waId');
  const raison = RAISONS.find((r) => r === o.raison) ?? null;
  const tours = typeof o.tours === 'number' && Number.isInteger(o.tours) && o.tours >= 0 ? o.tours : null;
  if (!tenantId || !runId || !sessionId || !workflowId || !nodeId || !waId || !raison || tours === null) {
    return null;
  }
  return { tenantId, runId, sessionId, workflowId, nodeId, waId, raison, tours };
}
