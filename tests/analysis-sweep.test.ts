import { describe, it, expect } from 'vitest';
import { runAnalysisSweep, type AnalysisSweepStore } from '../src/analysis/sweep';
import type { ClaimedConversation } from '../src/analysis/store.pg';

interface Cap { reclaimedStale: number; claimCalls: Array<[number, number]>; reclaimQueued: string[] }

function fakeStore(claimed: ClaimedConversation[], opts: { staleReclaimed?: number } = {}): { store: AnalysisSweepStore; cap: Cap } {
  const cap: Cap = { reclaimedStale: opts.staleReclaimed ?? 0, claimCalls: [], reclaimQueued: [] };
  const store: AnalysisSweepStore = {
    reclaimStaleQueued: async () => cap.reclaimedStale,
    claimForAnalysis: async (inactivityMs, limit) => { cap.claimCalls.push([inactivityMs, limit]); return claimed; },
    reclaimQueued: async (id) => { cap.reclaimQueued.push(id); },
  };
  return { store, cap };
}

const cfg = { staleMs: 900_000, inactivityMs: 1_500_000, batch: 20 };
const conv = (n: number): ClaimedConversation => ({ conversationId: `c${n}`, tenantId: `t${n}` });

describe('runAnalysisSweep', () => {
  it('un enqueue qui échoue remet SA conversation en pending et n\'empêche pas les autres', async () => {
    const { store, cap } = fakeStore([conv(1), conv(2), conv(3)]);
    const enqueued: string[] = [];
    const enqueue = async (conversationId: string): Promise<void> => {
      enqueued.push(conversationId);
      if (conversationId === 'c2') throw new Error('transient');
    };
    await runAnalysisSweep({ store, enqueue, ...cfg });

    // La boucle ne s'arrête PAS sur c2 : c1 et c3 sont enqueue.
    expect(enqueued).toEqual(['c1', 'c2', 'c3']);
    // Seule c2 (enqueue échoué) est remise en pending ; c1/c3 n'y touchent pas.
    expect(cap.reclaimQueued).toEqual(['c2']);
  });

  it('tout réussit -> aucune remise en pending', async () => {
    const { store, cap } = fakeStore([conv(1), conv(2)]);
    const enqueued: string[] = [];
    await runAnalysisSweep({ store, enqueue: async (id) => { enqueued.push(id); }, ...cfg });
    expect(enqueued).toEqual(['c1', 'c2']);
    expect(cap.reclaimQueued).toEqual([]);
  });

  it('best-effort : si la remise en pending échoue aussi, le sweep ne rejette pas', async () => {
    const store: AnalysisSweepStore = {
      reclaimStaleQueued: async () => 0,
      claimForAnalysis: async () => [conv(1)],
      reclaimQueued: async () => { throw new Error('reset KO'); },
    };
    const errors: string[] = [];
    await expect(
      runAnalysisSweep({ store, enqueue: async () => { throw new Error('transient'); }, ...cfg, onError: (m) => errors.push(m) }),
    ).resolves.toBeUndefined();
    // Deux erreurs remontées : l'enqueue puis le reset (best-effort), le filet reste reclaimStaleQueued.
    expect(errors.length).toBe(2);
  });

  it('passe les bons paramètres au claim et applique le reclaim des queued périmés', async () => {
    const { store, cap } = fakeStore([], { staleReclaimed: 3 });
    const infos: string[] = [];
    await runAnalysisSweep({ store, enqueue: async () => {}, ...cfg, log: (m) => infos.push(m) });
    expect(cap.claimCalls).toEqual([[cfg.inactivityMs, cfg.batch]]);
    expect(infos.some((m) => m.includes('3'))).toBe(true); // log du nombre de queued ramenés en pending
  });
});
