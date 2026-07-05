import { PgBoss } from 'pg-boss';
import type { Queue } from './queue';
import { pgSsl } from '../db/ssl';

/**
 * Implémentation durable via pg-boss (Postgres/Supabase).
 * Chaque file a une dead-letter queue `<name>-dlq` et un retryLimit.
 */
export class PgBossQueue implements Queue {
  private readonly boss: PgBoss;
  private started = false;
  private readonly ensured = new Set<string>();

  constructor(connectionString: string, schema = 'pgboss') {
    this.boss = new PgBoss({
      connectionString,
      schema,
      ssl: pgSsl(),
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.boss.start();
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await this.boss.stop({ graceful: true });
    this.started = false;
  }

  private async ensure(name: string): Promise<void> {
    if (this.ensured.has(name)) return;
    const dlq = `${name}-dlq`;
    await this.boss.createQueue(dlq);
    await this.boss.createQueue(name, {
      deadLetter: dlq,
      retryLimit: 5,
      retryBackoff: true,
    });
    this.ensured.add(name);
  }

  async enqueue(name: string, data: unknown): Promise<void> {
    await this.ensure(name);
    await this.boss.send(name, data as object);
  }

  async work(name: string, handler: (data: unknown) => Promise<void>): Promise<void> {
    await this.ensure(name);
    // batchSize:1 verrouille l'invariant per-job de l'abstraction (un throw ne fait
    // pas échouer un lot entier / ne rejoue pas des jobs déjà réussis).
    await this.boss.work<unknown>(name, { batchSize: 1 }, async (jobs) => {
      for (const job of jobs) {
        await handler(job.data);
      }
    });
  }
}
