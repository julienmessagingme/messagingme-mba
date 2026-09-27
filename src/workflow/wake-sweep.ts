import type { RunStatus } from './run-store.pg';
import type { WorkflowGraph } from './graph';

/** Un parcours au repos que le balayage vient de réserver. */
export interface DueRun {
  id: string;
  workflowId: string;
  tenantId: string;
  waId: string;
  contactId?: string | null;
  currentNode: string | null;
  /**
   * Le graphe figé du parcours, `null` pour tout parcours réel. Il doit traverser le balayage : un parcours de
   * test endormi sur un bloc Attente est réveillé par ce chemin, et sans la colonne la reprise retomberait sur
   * le publié. Requis, pour que le compilateur oblige chaque réclamation à la lire.
   */
  grapheFige: WorkflowGraph | null;
  /**
   * Ce qui est arrivé à échéance, donc par où reprendre : `sleeping` = bloc Attente (reprise au bloc suivant),
   * `waiting` = délai « pas de réponse » d'un bloc Question (sortie `timeout`). Absent = `sleeping`.
   */
  status?: RunStatus;
}

export interface WakeSweepDeps {
  /** Les parcours et leurs échéances. */
  runs: {
    /** Réserve les runs dormants dus (claim atomique côté store) et les rend. Jamais deux fois la même ligne. */
    claimDueSleeping(limit: number): Promise<DueRun[]>;
    /**
     * Réserve les parcours dont le délai « pas de réponse » d'un bloc Question a expiré. Absente -> pas de
     * balayage. Séparée de `claimDueSleeping` parce que la mécanique diffère, et c'est elle qui décide de la
     * sûreté : l'une pose un bail sur un run dormant, invisible de `advance` ; l'autre consomme l'échéance d'un
     * run qui doit rester joignable par une réponse du contact.
     */
    claimDueQuestions?(limit: number): Promise<DueRun[]>;
    /** Clôt les parcours dormants trop vieux (chaîne d'attentes sans fin). Absente -> pas de nettoyage. */
    closeStaleSleeping?(): Promise<number>;
  };
  /** Reprend un parcours au bloc suivant. Rend false si la reprise a été refusée. */
  executor: { resume(run: DueRun): Promise<boolean> };
  /** Nombre max de parcours réveillés par passage. Absent -> 50. */
  batchSize?: number;
}

/**
 * Réveille les parcours dont l'attente est arrivée à échéance. Logique pure, toute l'IO passe par les deps.
 *
 * Le claim se fait avant la reprise, en une requête, sous forme de bail : l'échéance est repoussée (durée
 * posée par `claimDueSleeping`, seul endroit où elle est écrite) et le run reste `sleeping`. Deux workers ne
 * peuvent donc pas prendre le même parcours, et le run reste invisible de l'avance par message entrant pendant
 * la reprise (en `waiting`, `advance` rejouerait le même bloc). Un worker tué en pleine reprise ne perd rien :
 * le bail expire et le parcours redevient dû.
 *
 * Un échec sur un parcours n'interrompt pas le balayage. Retourne le nombre de parcours repris.
 */
export async function runWorkflowWakeSweep(deps: WakeSweepDeps): Promise<number> {
  // Nettoyage avant le claim : deux blocs Attente qui se pointent l'un l'autre se rendorment pour toujours.
  // Best-effort : un échec de nettoyage ne doit pas empêcher les réveils légitimes.
  if (deps.runs.closeStaleSleeping) {
    try {
      const clos = await deps.runs.closeStaleSleeping();
      // eslint-disable-next-line no-console
      if (clos > 0) console.log(`wake-sweep: ${clos} parcours dormant(s) trop vieux clos`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('wake-sweep: nettoyage des vieux parcours en échec', err);
    }
  }
  const taille = deps.batchSize ?? 50;
  // Les deux familles d'échéance sont réclamées séparément puis reprises par la même boucle (`status` dit par
  // où repartir). Un échec de la réclamation des questions n'empêche pas les réveils du sommeil.
  const due = await deps.runs.claimDueSleeping(taille);
  if (deps.runs.claimDueQuestions) {
    try {
      due.push(...(await deps.runs.claimDueQuestions(taille)));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('wake-sweep: réclamation des questions sans réponse en échec', err);
    }
  }
  let repris = 0;
  for (const run of due) {
    try {
      if (await deps.executor.resume(run)) repris += 1;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`wake-sweep: échec de la reprise du parcours ${run.id}`, err);
    }
  }
  return repris;
}
