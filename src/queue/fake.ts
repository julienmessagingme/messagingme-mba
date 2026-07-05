import type { Queue } from './queue';

/**
 * File en mémoire pour les tests unitaires du receiver.
 * `enqueue` enregistre les jobs ; `deliver` rejoue les jobs vers le handler.
 */
export class FakeQueue implements Queue {
  public readonly enqueued: Array<{ name: string; data: unknown }> = [];
  private readonly handlers = new Map<string, (data: unknown) => Promise<void>>();

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async enqueue(name: string, data: unknown, _opts?: { singletonKey?: string }): Promise<void> {
    this.enqueued.push({ name, data });
  }

  async work(name: string, handler: (data: unknown) => Promise<void>): Promise<void> {
    this.handlers.set(name, handler);
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
