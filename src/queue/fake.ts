import type { Queue } from './queue';

/**
 * File en mémoire pour les tests unitaires du receiver.
 * `enqueue` enregistre les jobs ; `deliver` rejoue les jobs vers le handler.
 */
export class FakeQueue implements Queue {
  public readonly enqueued: Array<{
    name: string;
    data: unknown;
    opts?: { expireInSeconds?: number; groupId?: string; priority?: number };
  }> = [];
  /** Trace des appels à `work` : rend le passthrough des options de concurrence OBSERVABLE en test. */
  public readonly workCalls: Array<{ name: string; opts?: { concurrency?: number; groupConcurrency?: number } }> = [];
  private readonly handlers = new Map<string, (data: unknown) => Promise<void>>();

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async enqueue(
    name: string,
    data: unknown,
    opts?: { expireInSeconds?: number; groupId?: string; priority?: number },
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
    this.handlers.set(name, handler);
    this.workCalls.push({ name, ...(opts ? { opts } : {}) });
  }

  /** Rejoue les jobs empilés pour `name` vers le handler enregistré. */
  async deliver(name: string): Promise<void> {
    const handler = this.handlers.get(name);
    if (!handler) return;
    for (const job of this.enqueued.filter((j) => j.name === name)) {
      await handler(job.data);
    }
  }
}
