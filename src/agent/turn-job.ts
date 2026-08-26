/**
 * File `agent-turn` : le tour de l'agent IA se joue en tache de fond, pas dans le handler.
 *
 * Un tour d'agent est un appel LLM plus N appels d'outils, donc 3 a 20 secondes. Le laisser en ligne
 * dans le handler de webhook Meta tiendrait la connexion ouverte tout ce temps et ferait retenter le
 * webhook pendant qu'on parle au modele. D'ou une file dediee, consommee par le worker (tache 13).
 */

export const AGENT_TURN_QUEUE = 'agent-turn';

/** Ce qui declenche un tour : demarrage de session, message entrant du contact, ou reveil apres inactivite. */
export type RaisonTour = 'demarrage' | 'message' | 'inactivite';

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
   * Numero de tour ATTENDU par le producteur. Sert de verrou optimiste cote consommateur : pg-boss est
   * at-least-once, et un job d'inactivite differe (programme puis reveille en retard) peut arriver APRES
   * que le contact a deja repondu et fait avancer le tour. Le consommateur compare ce numero au tour reel
   * de la session et ignore le job perime plutot que de rejouer une reponse obsolete.
   */
  tours: number;
}

const RAISONS: readonly RaisonTour[] = ['demarrage', 'message', 'inactivite'];

/**
 * Coerce defensivement le payload de la file (JSON opaque, potentiellement ecrit par une version
 * anterieure du code) en job valide. Rend `null` plutot que de lever : un payload inexploitable ne doit
 * pas faire boucler la file jusqu'a la DLQ (meme doctrine que parseAutomationEventJob).
 *
 * Le producteur DOIT relire ce parseur avant d'emettre un nouveau champ : une chaine s'est deja retrouvee
 * morte sur `automation-event` parce qu'un producteur ecrivait un champ que le consommateur n'attendait
 * pas (cf. `event-job.ts`, cas `hubspot_deal_stage`).
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
