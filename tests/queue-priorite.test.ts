import { describe, it, expect } from 'vitest';
import { sendOptions } from '../src/queue/pgboss';
import { FakeQueue } from './fake-queue';

/**
 * LA PRIORITÉ D'UN JOB (lot 6 de l'API publique) : elle doit VRAIMENT atteindre `boss.send`, sinon les réponses
 * d'un client attendent derrière les accusés d'une campagne sans que rien ne le signale. Même patron que
 * `workConcurrencyOptions` (`tests/queue-group-concurrency.test.ts`) : la fonction PURE est le câblage.
 */
describe('sendOptions (options passées à boss.send)', () => {
  it('une absence reste une absence', () => {
    expect(sendOptions()).toEqual({});
    expect(sendOptions({})).toEqual({});
  });

  it('groupId devient group.id, expireInSeconds passe tel quel (comportement d’avant)', () => {
    expect(sendOptions({ groupId: 't', expireInSeconds: 600 })).toEqual({ group: { id: 't' }, expireInSeconds: 600 });
  });

  it('🔴 priority est transmise dès qu’elle est DÉFINIE, 0 compris (une valeur explicite n’est pas une absence)', () => {
    expect(sendOptions({ priority: 0 })).toEqual({ priority: 0 });
    expect(sendOptions({ groupId: 't', priority: 1 })).toEqual({ group: { id: 't' }, priority: 1 });
  });

  it('🔴 startAfter atteint boss.send tel quel : sans lui, l’automation « risque élevé » partirait pendant le balayage de nuit', () => {
    const neufHeures = new Date('2026-09-25T07:00:00.000Z');
    expect(sendOptions({ groupId: 't', startAfter: neufHeures })).toEqual({ group: { id: 't' }, startAfter: neufHeures });
    expect(sendOptions({ groupId: 't' })).toEqual({ group: { id: 't' } });
  });
});

describe('FakeQueue : la priorité traverse l’abstraction', () => {
  it('enqueue transporte priority dans les opts', async () => {
    const q = new FakeQueue();
    await q.enqueue('f', { a: 1 }, { groupId: 't', priority: 1 });
    expect(q.enqueued[0]?.opts).toEqual({ groupId: 't', priority: 1 });
  });
});
