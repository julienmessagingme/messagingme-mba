import { describe, it, expect } from 'vitest';
import { runRetrySweep, type RetrySweepDeps } from '../src/campaign/retry-sweep';
import type { AutoRetryRecipient } from '../src/campaign/store.pg';

const R = (id: string, campaignId = `c-${id}`): AutoRetryRecipient => ({ id, campaignId, tenantId: `t-${id}`, toE164: `+3360${id}` });

function deps(over: Partial<RetrySweepDeps> = {}): {
  d: RetrySweepDeps; enqueued: string[]; reset: string[]; flagged: Array<[string, string]>; marked: string[];
} {
  const enqueued: string[] = [];
  const reset: string[] = [];
  const flagged: Array<[string, string]> = [];
  const marked: string[] = [];
  const d: RetrySweepDeps = {
    isMorningWindow: () => true,
    list131049: async () => [],
    list131026: async () => [],
    list131026SecondFail: async () => [],
    resetForRetry: async (id) => { reset.push(id); return true; },
    markUnreachableDone: async (id) => { marked.push(id); return true; },
    enqueueRun: async (id) => { enqueued.push(id); },
    flagUnreachable: async (tenantId, e164) => { flagged.push([tenantId, e164]); },
    ...over,
  };
  return { d, enqueued, reset, flagged, marked };
}

describe('runRetrySweep (F6)', () => {
  it('131049 : relancé (reset + enqueue) SEULEMENT en fenêtre matinale', async () => {
    const morning = deps({ isMorningWindow: () => true, list131049: async () => [R('1')] });
    expect(await runRetrySweep(morning.d)).toMatchObject({ retried: 1 });
    expect(morning.reset).toEqual(['1']);
    expect(morning.enqueued).toEqual(['c-1']);

    const night = deps({ isMorningWindow: () => false, list131049: async () => [R('1')] });
    const res = await runRetrySweep(night.d);
    expect(res.retried).toBe(0);
    expect(night.reset).toEqual([]); // hors fenêtre : pas de relance 131049
  });

  it('131026 : relancé une fois (reset + enqueue), quelle que soit l\'heure', async () => {
    const d = deps({ isMorningWindow: () => false, list131026: async () => [R('a'), R('b')] });
    expect((await runRetrySweep(d.d)).retried).toBe(2);
    expect(d.reset).toEqual(['a', 'b']);
    expect(d.enqueued).toEqual(['c-a', 'c-b']);
  });

  it('131026 2e échec : flag injoignable PUIS markUnreachableDone (dans cet ordre)', async () => {
    const order: string[] = [];
    const d = deps({
      list131026SecondFail: async () => [R('z')],
      flagUnreachable: async () => { order.push('flag'); },
      markUnreachableDone: async (id) => { order.push(`mark:${id}`); return true; },
    });
    expect((await runRetrySweep(d.d)).flagged).toBe(1);
    expect(order).toEqual(['flag', 'mark:z']);
  });

  it('flagUnreachable qui throw -> PAS de markUnreachableDone (réessayé au tour suivant)', async () => {
    const d = deps({
      list131026SecondFail: async () => [R('z')],
      flagUnreachable: async () => { throw new Error('connecteur down'); },
    });
    const res = await runRetrySweep(d.d);
    expect(res.flagged).toBe(0);
    expect(d.marked).toEqual([]); // pas marqué : on ne clôt pas sur un flag échoué
  });

  it('resetForRetry qui renvoie false (conflit) -> pas d\'enqueue', async () => {
    const d = deps({ list131026: async () => [R('a')], resetForRetry: async () => false });
    expect((await runRetrySweep(d.d)).retried).toBe(0);
    expect(d.enqueued).toEqual([]);
  });

  it('un échec par destinataire n\'interrompt pas le balayage', async () => {
    const d = deps({
      list131026: async () => [R('a'), R('b')],
      resetForRetry: async (id) => { if (id === 'a') throw new Error('boom'); return true; },
    });
    // 'a' throw, mais 'b' est quand même traité.
    expect((await runRetrySweep(d.d)).retried).toBe(1);
    expect(d.enqueued).toEqual(['c-b']);
  });
});
