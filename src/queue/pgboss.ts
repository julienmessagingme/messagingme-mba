import { PgBoss } from 'pg-boss';
import type { Queue } from './queue';
import { dlqName } from './names';
import { pgSsl } from '../db/ssl';

export interface PgBossPoolOpts {
  /** Max de connexions du pool pg-boss. Budget du pooler Supabase partagé (cf. `src/config.ts`). */
  max?: number;
  /** Timeout d'ACQUISITION d'une connexion (ms). Sans lui, le polling pg-boss attend indéfiniment. */
  connectionTimeoutMillis?: number;
}

/**
 * Options de POOL passées à pg-boss. Fonction PURE et exportée pour être testée : c'est ici que se joue le
 * piège `max: 0`, une valeur explicite (« aucune connexion ») qu'un test de véracité (`opts.max ? ...`)
 * avalerait en silence, redonnant à pg-boss son défaut de 10 alors que l'appelant demandait l'inverse.
 * Une option ABSENTE doit rester absente pour que pg-boss applique son propre défaut : d'où `!== undefined`
 * et non `?? valeur`.
 */
export function poolOptions(opts: PgBossPoolOpts): PgBossPoolOpts {
  return {
    ...(opts.max !== undefined ? { max: opts.max } : {}),
    ...(opts.connectionTimeoutMillis !== undefined ? { connectionTimeoutMillis: opts.connectionTimeoutMillis } : {}),
  };
}

/**
 * Implémentation durable via pg-boss (Postgres/Supabase).
 * Chaque file a une dead-letter queue `<name>-dlq` et un retryLimit.
 */
export class PgBossQueue implements Queue {
  private readonly boss: PgBoss;
  private started = false;
  private readonly ensured = new Set<string>();
  private readonly retryLimit: number;

  constructor(connectionString: string, schema = 'pgboss', opts: PgBossPoolOpts & { retryLimit?: number } = {}) {
    this.retryLimit = opts.retryLimit ?? 5;
    this.boss = new PgBoss({
      connectionString,
      schema,
      ssl: pgSsl(),
      ...poolOptions(opts),
    });
  }

  /**
   * Branche un observateur sur les erreurs de pg-boss. SANS ça, pg-boss émet un event `error` (typiquement un
   * EMAXCONNSESSION sur son polling interne) qui, non capté, est une exception non gérée qui TUE le process.
   * C'est ce qui faisait redémarrer le conteneur en boucle. À appeler avant `start()`.
   */
  onError(cb: (err: unknown) => void): void {
    this.boss.on('error', cb);
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
    const dlq = dlqName(name); // convention -dlq partagée avec src/queue/names.ts (source unique, cf. /ops)
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
