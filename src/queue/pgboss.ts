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
  private readonly retryLimit: number;

  constructor(connectionString: string, schema = 'pgboss', opts: { retryLimit?: number; max?: number } = {}) {
    this.retryLimit = opts.retryLimit ?? 5;
    this.boss = new PgBoss({
      connectionString,
      schema,
      ssl: pgSsl(),
      ...(opts.max ? { max: opts.max } : {}),
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
      retryLimit: this.retryLimit,
      retryBackoff: true,
    });
    this.ensured.add(name);
  }

  /**
   * Test-only : retire (fetch) et compte les jobs disponibles sur une file. Sert à vérifier
   * qu'un job a bien atterri en DLQ. Effet de bord : marque les jobs récupérés `active`.
   */
  async pullPending(name: string): Promise<number> {
    const jobs = await this.boss.fetch(name, { batchSize: 100 });
    return jobs?.length ?? 0;
  }

  async enqueue(name: string, data: unknown, opts?: { singletonKey?: string; expireInSeconds?: number }): Promise<void> {
    await this.ensure(name);
    // `expireInSeconds` PAR JOB (prime sur la policy de file) : dimensionne la durée max d'un run de campagne
    // throttlé sur son travail réel, sinon un run long expirerait et serait rejoué en parallèle.
    await this.boss.send(name, data as object, {
      ...(opts?.singletonKey ? { singletonKey: opts.singletonKey } : {}),
      ...(opts?.expireInSeconds ? { expireInSeconds: opts.expireInSeconds } : {}),
    });
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
