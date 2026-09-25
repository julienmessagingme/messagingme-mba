import { describe, it, expect } from 'vitest';
import { workConcurrencyOptions } from '../src/queue/pgboss';
import { FakeQueue } from './fake-queue';

/**
 * `workConcurrencyOptions` est le CÂBLAGE des plafonds de concurrence vers `boss.work` (mêmes cousins que
 * `poolOptions`/`maintenanceOptions`, tests dans `config-guards.test.ts`). Le tester est ce qui distingue un
 * vrai test d'un faux témoin : sans le cas `concurrency: 0`, on pourrait repasser à `opts.concurrency ? ...`
 * sans rien casser, et pg-boss reprendrait son défaut de 1 alors que l'appelant demandait l'inverse.
 */
describe('workConcurrencyOptions (concurrence passée à boss.work)', () => {
  it('une absence reste une absence (pg-boss garde son défaut : 1 job en vol)', () => {
    expect(workConcurrencyOptions({})).toEqual({});
  });

  it('concurrency: 0 est TRANSMIS : valeur explicite, pas une absence (même piège que max: 0)', () => {
    expect(workConcurrencyOptions({ concurrency: 0 })).toEqual({ localConcurrency: 0 });
  });

  it('mappe concurrency -> localConcurrency et groupConcurrency -> localGroupConcurrency', () => {
    expect(workConcurrencyOptions({ concurrency: 3, groupConcurrency: 2 })).toEqual({
      localConcurrency: 3,
      localGroupConcurrency: 2,
    });
  });

  it('groupConcurrency seul est transmis (l’appelant assume le couplage avec concurrency)', () => {
    expect(workConcurrencyOptions({ groupConcurrency: 2 })).toEqual({ localGroupConcurrency: 2 });
  });
});

/**
 * Passthrough côté abstraction : le tenant (`groupId`) et les plafonds doivent VRAIMENT traverser l'API,
 * sinon les tâches 10 et 13 poseraient un plafond qui ne partirait jamais à pg-boss. `FakeQueue` expose
 * `enqueued`/`workCalls` pour l'observer (un test qui n'observe rien ne peut pas échouer).
 */
describe('Queue : passthrough du groupe et de la concurrence', () => {
  it('enqueue transporte groupId dans les opts (absent reste absent)', async () => {
    const q = new FakeQueue();
    await q.enqueue('f', { a: 1 }, { groupId: 'tenant-a' });
    await q.enqueue('f', { a: 2 });
    expect(q.enqueued[0]?.opts?.groupId).toBe('tenant-a');
    expect(q.enqueued[1]?.opts).toBeUndefined();
  });

  it('work transporte concurrency et groupConcurrency dans les opts (absent reste absent)', async () => {
    const q = new FakeQueue();
    await q.work('f', async () => {}, { concurrency: 3, groupConcurrency: 2 });
    await q.work('g', async () => {});
    expect(q.workCalls[0]?.opts).toEqual({ concurrency: 3, groupConcurrency: 2 });
    expect(q.workCalls[1]?.opts).toBeUndefined();
  });
});
