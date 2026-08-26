import type { RunStatus } from './run-store.pg';

/** Un parcours au repos que le balayage vient de réserver. */
export interface DueRun {
  id: string;
  workflowId: string;
  tenantId: string;
  waId: string;
  contactId?: string | null;
  currentNode: string | null;
  /**
   * Ce qui est arrivé à échéance, donc par où reprendre : `sleeping` = bloc Attente (reprise au bloc
   * suivant), `waiting` = délai « pas de réponse » d'un bloc Question (sortie `timeout`). Absent =
   * `sleeping`, pour que tout appelant écrit avant le bloc Question garde son comportement.
   */
  status?: RunStatus;
}

export interface WakeSweepDeps {
  /** RÉSERVE les runs dormants dus (claim atomique côté store) et les rend. Jamais deux fois la même ligne. */
  claimDue(limit: number): Promise<DueRun[]>;
  /**
   * RÉSERVE les parcours dont le délai « pas de réponse » d'un bloc Question a expiré. Absente -> ce balayage
   * n'a pas lieu, comportement d'avant le bloc Question.
   *
   * Séparée de `claimDue` parce que les deux réclamations n'ont pas la même mécanique : l'une pose un BAIL
   * sur un run dormant, invisible de `advance` ; l'autre CONSOMME l'échéance d'un run qui, lui, doit rester
   * joignable par une réponse du contact. Les fondre derrière une seule signature masquerait cette
   * différence, qui est précisément ce qui décide de la sûreté.
   */
  claimDueQuestions?(limit: number): Promise<DueRun[]>;
  /** Reprend UN parcours au bloc suivant (executor.resume). Rend false si la reprise a été refusée. */
  resume(run: DueRun): Promise<boolean>;
  /** Nombre max de parcours réveillés par passage. Absent -> 50. */
  batchSize?: number;
  /** Clôt les parcours dormants trop vieux (chaîne d'attentes sans fin). Absente -> pas de nettoyage. */
  closeStale?: () => Promise<number>;
}

/**
 * Réveille les parcours dont l'attente est arrivée à échéance. Miroir de `campaign/schedule-sweep.ts` :
 * fonction PURE de logique, toute l'IO passe par les deps -> testable sans base.
 *
 * Le claim se fait AVANT la reprise, en une requête, et prend la forme d'un BAIL : l'échéance est repoussée
 * (durée posée par `claimDueSleeping`, seul endroit où elle est écrite), le run RESTE `sleeping`. Deux workers
 * qui balaient en même temps ne peuvent donc pas prendre le
 * même parcours, et le run reste invisible de l'avance par message entrant pendant toute la reprise (le passer
 * à `waiting` l'aurait exposé à `advance`, qui aurait rejoué le même bloc). Un worker tué en pleine reprise ne
 * perd pas le parcours : le bail expire et il redevient dû.
 *
 * Un échec sur un parcours n'interrompt PAS le balayage. Retourne le nombre de parcours effectivement repris.
 */
export async function runWorkflowWakeSweep(deps: WakeSweepDeps): Promise<number> {
  // Nettoyage AVANT le claim : deux blocs Attente qui se pointent l'un l'autre se rendorment à chaque réveil,
  // pour toujours. Le claim les ignore déjà par leur âge ; ceci les clôt pour de bon au lieu de les laisser
  // traîner en base. Best-effort : un échec de nettoyage ne doit pas empêcher les réveils légitimes.
  if (deps.closeStale) {
    try {
      const clos = await deps.closeStale();
      // eslint-disable-next-line no-console
      if (clos > 0) console.log(`wake-sweep: ${clos} parcours dormant(s) trop vieux clos`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('wake-sweep: nettoyage des vieux parcours en échec', err);
    }
  }
  const taille = deps.batchSize ?? 50;
  // Les deux familles d'échéance sont réclamées SÉPARÉMENT puis reprises par la même boucle : c'est `status`
  // qui dit à l'executor par où repartir. Un échec de l'une ne doit pas empêcher l'autre, d'où le try autour
  // de la seule réclamation des questions (celle du sommeil est le chemin historique, on la laisse remonter).
  const due = await deps.claimDue(taille);
  if (deps.claimDueQuestions) {
    try {
      due.push(...(await deps.claimDueQuestions(taille)));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('wake-sweep: réclamation des questions sans réponse en échec', err);
    }
  }
  let repris = 0;
  for (const run of due) {
    try {
      if (await deps.resume(run)) repris += 1;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`wake-sweep: échec de la reprise du parcours ${run.id}`, err);
    }
  }
  return repris;
}
