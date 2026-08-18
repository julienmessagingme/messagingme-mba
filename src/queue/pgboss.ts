import { PgBoss } from 'pg-boss';
import type { MaintenanceOptions, SchedulingOptions } from 'pg-boss';
import type { Queue } from './queue';
import { dlqName, pollingSecondsFor } from './names';
import { pgSsl } from '../db/ssl';

export interface PgBossPoolOpts {
  /** Max de connexions du pool pg-boss. Budget du pooler Supabase partagé (cf. `src/config.ts`). */
  max?: number;
  /** Timeout d'ACQUISITION d'une connexion (ms). Sans lui, le polling pg-boss attend indéfiniment. */
  connectionTimeoutMillis?: number;
}

/**
 * Options de MAINTENANCE de l'instance pg-boss. Elles ne changent rien au fonctionnel, seulement le BRUIT que
 * l'instance produit sur la base. Deux instances tournent par service (l'API empile, le worker dépile) et
 * chacune supervise par défaut : c'est la moitié de l'egress de maintenance mesuré, pour rien côté API.
 */
export interface PgBossMaintenanceOpts {
  /**
   * `false` = cette instance ne fait AUCUNE maintenance (récupération des jobs expirés, monitoring, flow).
   * À poser sur une instance qui ne fait qu'EMPILER : l'API n'a rien à superviser, le worker s'en charge.
   * Défaut pg-boss : `true`.
   */
  supervise?: boolean;
  /**
   * Cadence (s) de la maintenance « flow » (jobs bloquants / parents). Défaut pg-boss : 5 s, soit ~17 000
   * requêtes/jour par instance pour une fonctionnalité que ce projet n'utilise pas dans un chemin sensible.
   */
  flowIntervalSeconds?: number;
}

/**
 * Options de MAINTENANCE passées à pg-boss. Fonction PURE et exportée pour être testée, même raison que
 * `poolOptions` : une option ABSENTE doit rester absente pour que pg-boss applique son défaut, et `supervise:
 * false` est une valeur explicite qu'un test de véracité avalerait en silence (d'où `!== undefined`).
 *
 * `schedule: false` est posé INCONDITIONNELLEMENT : le cron de pg-boss n'est utilisé nulle part dans ce repo
 * (les balayages sont des `setInterval` du worker, cf. `src/worker.ts`), et il coûte deux boucles de polling
 * permanentes par instance (`clockMonitor` + `cronWorker`). Si un jour on veut `boss.schedule()`, il faudra
 * repasser ce drapeau à true EN CONSCIENCE, et le test le rappelle.
 *
 * ⚠️ Le type de retour vient de pg-boss, il n'est PAS un `Record<string, unknown>` : un spread d'objet non typé
 * dans `new PgBoss({...})` échappe au contrôle des propriétés excédentaires, donc une option mal orthographiée
 * (`superviseX`) compilerait et ne ferait RIEN. C'est exactement le mode de panne qui a causé l'incident d'egress
 * (un réglage qu'on croit actif et qui n'existe pas). Typé ainsi, un nom d'option faux casse le typecheck.
 */
export function maintenanceOptions(opts: PgBossMaintenanceOpts): SchedulingOptions & MaintenanceOptions {
  return {
    schedule: false,
    ...(opts.supervise !== undefined ? { supervise: opts.supervise } : {}),
    ...(opts.flowIntervalSeconds !== undefined ? { flowIntervalSeconds: opts.flowIntervalSeconds } : {}),
  };
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

  constructor(connectionString: string, schema = 'pgboss', opts: PgBossPoolOpts & PgBossMaintenanceOpts & { retryLimit?: number } = {}) {
    this.retryLimit = opts.retryLimit ?? 5;
    this.boss = new PgBoss({
      connectionString,
      schema,
      ssl: pgSsl(),
      ...poolOptions(opts),
      ...maintenanceOptions(opts),
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
    // pollingIntervalSeconds : cadence PAR FILE (défaut pg-boss 2 s, trop bavard pour une base facturée à
    // l'egress). La valeur vient de `names.ts`, source unique, et non du call site : ajouter une file sans
    // penser à sa cadence retombe alors sur un défaut sûr au lieu de rouvrir la fuite.
    await this.boss.work<unknown>(name, { batchSize: 1, pollingIntervalSeconds: pollingSecondsFor(name) }, async (jobs) => {
      for (const job of jobs) {
        await handler(job.data);
      }
    });
  }
}
