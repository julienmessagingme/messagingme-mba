import type { Queue } from '../src/queue/queue';

/**
 * File en mémoire pour les tests : `enqueue` enregistre les jobs, `work` enregistre les abonnements.
 */
export class FakeQueue implements Queue {
  public readonly enqueued: Array<{
    name: string;
    data: unknown;
    opts?: { expireInSeconds?: number; groupId?: string; priority?: number; startAfter?: Date };
  }> = [];
  /** Trace des appels à `work` : rend le passthrough des options de concurrence OBSERVABLE en test. */
  public readonly workCalls: Array<{ name: string; opts?: { concurrency?: number; groupConcurrency?: number } }> = [];

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async enqueue(
    name: string,
    data: unknown,
    opts?: { expireInSeconds?: number; groupId?: string; priority?: number; startAfter?: Date },
  ): Promise<void> {
    this.enqueued.push({ name, data, ...(opts ? { opts } : {}) });
  }

  /** Dérivée de `workCalls`, comme en production : la fausse file ne tient pas une seconde liste. */
  filesTravaillees(): readonly string[] {
    return this.workCalls.map((c) => c.name);
  }

  async work(
    name: string,
    handler: (data: unknown) => Promise<void>,
    opts?: { concurrency?: number; groupConcurrency?: number },
  ): Promise<void> {
    this.workCalls.push({ name, ...(opts ? { opts } : {}) });
  }
}
