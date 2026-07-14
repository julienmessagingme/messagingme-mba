import type { ClaimedConversation } from './store.pg';

/** Sous-ensemble de PgConversationAnalysisStore dont a besoin le balayage (injecté -> testable sans DB). */
export interface AnalysisSweepStore {
  reclaimStaleQueued(olderThanMs: number): Promise<number>;
  claimForAnalysis(inactivityMs: number, limit: number): Promise<ClaimedConversation[]>;
  reclaimQueued(conversationId: string): Promise<void>;
}

export interface AnalysisSweepDeps {
  store: AnalysisSweepStore;
  /** Met la conversation en file (pg-boss). Peut lever (transient) : géré par conversation, sans casser le lot. */
  enqueue: (conversationId: string, tenantId: string) => Promise<void>;
  staleMs: number;
  inactivityMs: number;
  batch: number;
  log?: (msg: string) => void;
  onError?: (msg: string, err: unknown) => void;
}

/**
 * Un tour de balayage d'analyse : ramène les `queued` périmés en `pending` (filet du worker mort), réclame les
 * conversations inactives (`pending` -> `queued`), puis met chacune en file. L'enqueue est isolé PAR conversation :
 * un échec transient ne bloque pas le reste du lot ET remet aussitôt CETTE conversation en `pending` (reprise au
 * prochain tour, quelques secondes) au lieu de la laisser coincée en `queued` jusqu'au reclaim (staleMs). Le
 * `claimForAnalysis` bascule tout le lot en `queued` d'un coup : sans cette compensation, un seul enqueue qui lève
 * orpheline toutes les conversations suivantes du lot.
 *
 * Pas de risque de boucle serrée : l'enqueue est un `boss.send` au payload trivial (conversationId/tenantId), un
 * échec PROPRE à une conversation est quasi impossible ; un échec réel est global (pg-boss/DB down) et fait alors
 * échouer aussi `claimForAnalysis`/`reclaimStaleQueued` (catch du haut), donc rien n'est re-réclamé en rafale. La
 * ré-tentative au tour suivant est le comportement voulu (le transient se résorbe). Et si l'insert du job avait
 * quand même commité avant que `send` ne lève, le `singletonKey = conversationId` (pg-boss) + l'idempotence du job
 * + la garde `reclaimQueued ... WHERE status='queued'` empêchent tout doublon ou écrasement d'un état déjà avancé.
 */
export async function runAnalysisSweep(deps: AnalysisSweepDeps): Promise<void> {
  const { store, enqueue, staleMs, inactivityMs, batch } = deps;
  const log = deps.log ?? (() => {});
  const onError = deps.onError ?? (() => {});
  try {
    const reclaimed = await store.reclaimStaleQueued(staleMs);
    if (reclaimed > 0) log(`analyse: ${reclaimed} conversation(s) 'queued' bloquée(s) -> 'pending'`);
    const claimed = await store.claimForAnalysis(inactivityMs, batch);
    for (const c of claimed) {
      try {
        await enqueue(c.conversationId, c.tenantId);
      } catch (err) {
        // Enqueue échoué (transient) : la conversation est en 'queued' sans job. On la relâche en 'pending' tout de
        // suite -> reprise au prochain tour. Best-effort : si le reset lève aussi, reclaimStaleQueued reste le filet.
        onError(`analyse enqueue échouée (conversation ${c.conversationId}), remise en 'pending'`, err);
        try {
          await store.reclaimQueued(c.conversationId);
        } catch (resetErr) {
          onError(`analyse remise en 'pending' échouée (conversation ${c.conversationId})`, resetErr);
        }
      }
    }
  } catch (err) {
    onError('analyse balayage erreur', err);
  }
}
