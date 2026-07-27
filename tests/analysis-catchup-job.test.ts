import { describe, it, expect } from 'vitest';
import { hubspotCatchupJob, type CatchupJobDeps } from '../src/analysis/catchup-job';

function deps(ids: string[]): { d: CatchupJobDeps; enqueued: Array<{ conversationId: string; tenantId: string }>; logs: string[] } {
  const enqueued: Array<{ conversationId: string; tenantId: string }> = [];
  const logs: string[] = [];
  const d: CatchupJobDeps = {
    listPendingCatchup: async () => ids,
    enqueuePush: async (ref) => { enqueued.push(ref); },
    log: (m) => logs.push(m),
  };
  return { d, enqueued, logs };
}

describe('hubspotCatchupJob', () => {
  it('re-enfile un push (ref) par conversation marquée, dans l\'ordre du store', async () => {
    const { d, enqueued } = deps(['a', 'b', 'c']);
    await hubspotCatchupJob({ tenantId: 't1' }, d);
    expect(enqueued).toEqual([
      { conversationId: 'a', tenantId: 't1' },
      { conversationId: 'b', tenantId: 't1' },
      { conversationId: 'c', tenantId: 't1' },
    ]);
  });

  it('liste vide -> 0 enqueue, log émis quand même (compte 0)', async () => {
    const { d, enqueued, logs } = deps([]);
    await hubspotCatchupJob({ tenantId: 't1' }, d);
    expect(enqueued).toHaveLength(0);
    expect(logs.some((l) => /0 conversation/.test(l))).toBe(true);
  });

  it('payload sans tenantId -> throw', async () => {
    const { d } = deps(['a']);
    await expect(hubspotCatchupJob({}, d)).rejects.toThrow(/invalide/);
    await expect(hubspotCatchupJob({ tenantId: '' }, d)).rejects.toThrow(/invalide/);
    await expect(hubspotCatchupJob(null, d)).rejects.toThrow(/invalide/);
  });
});
