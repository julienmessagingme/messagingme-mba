import type { DueRun } from './wake-sweep';

/**
 * Au-delà, une pause reste au seul balayage (`WORKFLOW_WAKE_SWEEP_INTERVAL_MS`, une passe par minute) : le réveil
 * court ne sert qu'aux pauses qu'il ne saurait pas tenir.
 */
export const REVEIL_COURT_MAX_MS = 60_000;

/** Ce que l'arrêt d'un processus accorde aux reprises en vol, sous le filet de 25 s (`FILET_ARRET_MS`). */
export const ATTENTE_REVEIL_COURT_A_L_ARRET_MS = 10_000;

export interface ReveilCourt {
  /**
   * Pose la minuterie d'un parcours qui vient de s'endormir, à appeler APRÈS l'écriture réussie de son état
   * `sleeping` : armé sur une écriture refusée, il réveillerait un parcours clos. Sans effet au-delà de
   * `REVEIL_COURT_MAX_MS`. `maintenant` : l'horloge qui a calculé `resumeAt`.
   */
  armer(tenantId: string, runId: string, resumeAt: Date, maintenant: number): void;
  /**
   * L'arrêt du processus : plus AUCUNE réclamation (une minuterie qui sonne encore, ou armée après, ne fait rien), puis
   * l'attente des reprises en vol, au plus `borneMs`. Rend le nombre de reprises encore en vol à la fin (0 = tout est
   * fini). À appeler AVANT de fermer la file et le pool dont les reprises ont besoin.
   */
  arreter(borneMs: number): Promise<number>;
}

export interface DepsReveilCourt {
  /** Réclame CE parcours sous le bail du balayage (`claimSleepingById`) ; `null` s'il n'est plus à prendre. */
  reclamer(tenantId: string, id: string): Promise<DueRun | null>;
  /** La reprise du balayage (`WorkflowExecutor.resume`). */
  reprendre(run: DueRun): Promise<boolean>;
  /** Reprises simultanées au plus, par processus (`WORKFLOW_REVEIL_COURT_CONCURRENCY`). */
  concurrence: number;
  /** Pose une minuterie. Défaut : `setTimeout` puis `unref()`, pour ne pas retenir l'arrêt du processus. */
  poser?(ms: number, f: () => void): void;
}

/**
 * Le réveil des pauses en secondes : une minuterie locale par parcours endormi, et à l'échéance la réclamation de
 * CE parcours puis la même reprise que le balayage.
 *
 * Rien n'est tenu ailleurs qu'en mémoire, délibérément : un processus arrêté (déploiement, conteneur gelé) perd ses
 * minuteries, et le balayage, inchangé, rattrape le parcours dans la minute. La réclamation passe par le même bail
 * que lui, donc les deux ne reprennent jamais le même parcours deux fois.
 *
 * Les échéances arrivées attendent dans une file en mémoire, à `concurrence` reprises simultanées : une pause posée
 * dans une campagne finit au même instant pour des milliers de destinataires, et chaque reprise prend des
 * connexions au pool. Le bail n'étant posé qu'à la réclamation, un parcours qui attend trop dans la file est repris
 * par le balayage, sans doublon.
 */
export function creerReveilCourt(deps: DepsReveilCourt): ReveilCourt {
  const poser = deps.poser ?? ((ms: number, f: () => void) => { setTimeout(f, ms).unref(); });
  const echus: Array<{ tenantId: string; runId: string }> = [];
  const reprises = new Set<Promise<void>>();
  let enVol = 0;
  let arrete = false;

  async function reveiller(tenantId: string, runId: string): Promise<void> {
    try {
      const run = await deps.reclamer(tenantId, runId);
      if (run) await deps.reprendre(run);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`reveil-court: échec de la reprise du parcours ${runId}, le balayage le rattrapera`, err);
    }
  }

  function vider(): void {
    // Arrêté : ce qui attend dans la file reste au balayage du prochain processus, sans avoir été réclamé.
    if (arrete) { echus.length = 0; return; }
    while (enVol < deps.concurrence && echus.length > 0) {
      const { tenantId, runId } = echus.shift()!;
      enVol += 1;
      const reprise: Promise<void> = reveiller(tenantId, runId).finally(() => {
        enVol -= 1;
        reprises.delete(reprise);
        vider();
      });
      reprises.add(reprise);
    }
  }

  return {
    armer(tenantId, runId, resumeAt, maintenant) {
      const ms = resumeAt.getTime() - maintenant;
      if (arrete || ms >= REVEIL_COURT_MAX_MS) return;
      poser(Math.max(0, ms), () => {
        echus.push({ tenantId, runId });
        vider();
      });
    },
    async arreter(borneMs) {
      arrete = true;
      echus.length = 0;
      let minuterie: ReturnType<typeof setTimeout> | undefined;
      const delai = new Promise<void>((r) => { minuterie = setTimeout(r, borneMs); });
      await Promise.race([Promise.all([...reprises]), delai]);
      clearTimeout(minuterie);
      return reprises.size;
    },
  };
}
