import type { ClaimedConversation } from './store.pg';

/** Sous-ensemble de PgConversationAnalysisStore dont a besoin le balayage (injecté). */
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
 * conversations inactives (`pending` -> `queued`), puis met chacune en file.
 *
 * `claimForAnalysis` bascule tout le lot en `queued` d'un coup : un enfilement qui lève remet donc aussitôt sa
 * conversation en `pending`, sinon elle resterait orpheline jusqu'au reclaim. La file ne déduplique pas : si l'insert
 * avait commité avant l'erreur, ce sont l'idempotence du job et la garde `WHERE status='queued'` de `reclaimQueued`
 * qui empêchent doublon et écrasement.
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
        // Conversation en 'queued' sans job : relâchée en 'pending' pour le tour suivant. Si le reset lève aussi,
        // reclaimStaleQueued reste le filet.
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
