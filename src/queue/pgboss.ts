import { PgBoss } from 'pg-boss';
import type { ConstructorOptions, MaintenanceOptions, SchedulingOptions, WorkOptions } from 'pg-boss';
import type { Queue } from './queue';
import { dlqName, filetNotifieSecondes, notifieePour, pollingSecondsFor, seuilRafalePour } from './names';
import { pgSsl } from '../db/ssl';

export interface PgBossPoolOpts {
  /** Max de connexions du pool pg-boss. Budget du pooler Supabase partagé (cf. `src/config.ts`). */
  max?: number;
  /** Timeout d'acquisition d'une connexion (ms). Sans lui, le sondage pg-boss attend indéfiniment. */
  connectionTimeoutMillis?: number;
}

/**
 * Options de maintenance de l'instance pg-boss : rien de fonctionnel, seulement le bruit produit sur la base.
 * Deux instances tournent par service (l'API empile, le worker dépile) et chacune supervise par défaut.
 */
export interface PgBossMaintenanceOpts {
  /**
   * `false` = aucune maintenance (jobs expirés, monitoring, flow), à poser sur une instance qui ne fait
   * qu'empiler : le worker s'en charge. Défaut pg-boss : `true`.
   */
  supervise?: boolean;
  /** Cadence (s) de la maintenance « flow » (jobs bloquants / parents). Défaut pg-boss : 5 s, inutile ici. */
  flowIntervalSeconds?: number;
}

/** Option d'écoute des notifications de l'instance pg-boss. */
export interface PgBossNotifyOpts {
  /**
   * `true` = l'instance ouvre un écouteur LISTEN/NOTIFY sur une connexion dédiée, et ses workers sont réveillés
   * dès qu'un job est créé sur une file notifiée. À poser sur l'instance qui dépile, comme `supervise` ; le
   * producteur n'a besoin de rien, pg-boss émet le `pg_notify` d'après le drapeau de la file. Défaut : `false`.
   */
  ecouteNotifications?: boolean;
}

/**
 * Option d'écoute passée à pg-boss, pure et testée. `false` est une valeur explicite, une option absente reste
 * absente. Le type de retour vient de pg-boss : un nom d'option mal orthographié casse le typecheck au lieu de ne
 * rien faire.
 */
export function notifyOptions(opts: PgBossNotifyOpts): Pick<ConstructorOptions, 'useListenNotify'> {
  return {
    ...(opts.ecouteNotifications !== undefined ? { useListenNotify: opts.ecouteNotifications } : {}),
  };
}

/**
 * Options de maintenance passées à pg-boss, pures et testées. Une option absente reste absente (pg-boss applique
 * son défaut) et `supervise: false` est une valeur explicite, d'où `!== undefined`.
 *
 * `schedule: false` inconditionnel : le cron de pg-boss n'est utilisé nulle part (les balayages sont des
 * `setInterval` du worker) et coûte deux boucles de sondage permanentes par instance. Le repasser à true se fait
 * en conscience, le test le rappelle.
 * Le type de retour vient de pg-boss : un spread non typé dans `new PgBoss({...})` échappe au contrôle des
 * propriétés excédentaires, et une option mal orthographiée compilerait sans rien faire.
 */
export function maintenanceOptions(opts: PgBossMaintenanceOpts): SchedulingOptions & MaintenanceOptions {
  return {
    schedule: false,
    ...(opts.supervise !== undefined ? { supervise: opts.supervise } : {}),
    ...(opts.flowIntervalSeconds !== undefined ? { flowIntervalSeconds: opts.flowIntervalSeconds } : {}),
  };
}

/**
 * Options de pool passées à pg-boss, pures et testées. `max: 0` est une valeur explicite qu'un test de véracité
 * avalerait (pg-boss reprendrait son défaut de 10) ; une option absente reste absente. D'où `!== undefined` et
 * non `?? valeur`.
 */
export function poolOptions(opts: PgBossPoolOpts): PgBossPoolOpts {
  return {
    ...(opts.max !== undefined ? { max: opts.max } : {}),
    ...(opts.connectionTimeoutMillis !== undefined ? { connectionTimeoutMillis: opts.connectionTimeoutMillis } : {}),
  };
}

/**
 * Options de concurrence passées à `boss.work`, pures et testées, même règle que `poolOptions`.
 *
 * `localGroupConcurrency` (plafond par groupe, par exemple par espace) est sans effet tant que `localConcurrency`
 * reste à 1 : les deux se posent ensemble. Suivi en mémoire (`local*`), gratuit avec un worker unique ; la
 * variante coordonnée par la base ne servirait qu'avec des réplicas et coûterait de l'egress.
 */
export function workConcurrencyOptions(opts: {
  concurrency?: number;
  groupConcurrency?: number;
}): Pick<WorkOptions, 'localConcurrency' | 'localGroupConcurrency'> {
  return {
    ...(opts.concurrency !== undefined ? { localConcurrency: opts.concurrency } : {}),
    ...(opts.groupConcurrency !== undefined ? { localGroupConcurrency: opts.groupConcurrency } : {}),
  };
}

/**
 * Options d'envoi passées à `boss.send`, pures et testées (`tests/queue-priorite.test.ts`). `priority` est
 * transmise dès qu'elle est définie, 0 compris. `startAfter` passe tel quel : un instant passé veut dire « tout
 * de suite ».
 */
export function sendOptions(opts: { expireInSeconds?: number; groupId?: string; priority?: number; startAfter?: Date } = {}): {
  expireInSeconds?: number;
  group?: { id: string };
  priority?: number;
  startAfter?: Date;
} {
  return {
    ...(opts.expireInSeconds ? { expireInSeconds: opts.expireInSeconds } : {}),
    ...(opts.groupId ? { group: { id: opts.groupId } } : {}),
    ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
    ...(opts.startAfter !== undefined ? { startAfter: opts.startAfter } : {}),
  };
}

/** Implémentation durable via pg-boss. Chaque file a une dead-letter queue `<name>-dlq` et un retryLimit. */
export class PgBossQueue implements Queue {
  private readonly boss: PgBoss;
  private started = false;
  private readonly ensured = new Set<string>();
  /** Files consommées par ce process, dans l'ordre : le message de démarrage en dérive (jamais recopié). */
  private readonly travaillees: string[] = [];
  private readonly retryLimit: number;

  constructor(
    connectionString: string,
    schema = 'pgboss',
    opts: PgBossPoolOpts & PgBossMaintenanceOpts & PgBossNotifyOpts & { retryLimit?: number } = {},
  ) {
    this.retryLimit = opts.retryLimit ?? 5;
    this.boss = new PgBoss({
      connectionString,
      schema,
      ssl: pgSsl(),
      ...poolOptions(opts),
      ...maintenanceOptions(opts),
      ...notifyOptions(opts),
    });
  }

  /**
   * Branche un observateur sur les erreurs de pg-boss : non capté, l'event `error` (par exemple EMAXCONNSESSION
   * sur son sondage interne) est une exception non gérée qui tue le process. À appeler avant `start()`.
   */
  onError(cb: (err: unknown) => void): void {
    this.boss.on('error', cb);
  }

  /**
   * Branche un observateur sur les avertissements de pg-boss, surtout `listen_notify_unavailable` : l'écouteur n'a
   * pas pu s'établir et l'instance retombe en silence sur le sondage seul. Sans lui, on croirait les entrants
   * réveillés à l'instant.
   */
  onWarning(cb: (avertissement: unknown) => void): void {
    this.boss.on('warning', cb);
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

  /**
   * Les files sont créées sans `policy`, donc en `standard` : pg-boss n'y déduplique rien, ni par `singleton_key`
   * ni autrement (ses index uniques sont filtrés sur d'autres policies).
   * On ne peut pas l'ajouter ici : pg-boss refuse tout changement de policy après création, et les files de
   * production existent déjà. La déduplication passe par un verrou applicatif, cf. `Queue.enqueue`.
   */
  private async ensure(name: string): Promise<void> {
    if (this.ensured.has(name)) return;
    const dlq = dlqName(name); // convention -dlq partagée avec src/queue/names.ts
    await this.boss.createQueue(dlq);
    await this.boss.createQueue(name, {
      deadLetter: dlq,
      retryLimit: this.retryLimit,
      retryBackoff: true,
    });
    // `createQueue` est un `ON CONFLICT DO NOTHING` : sur une file qui existe déjà, `notify: true` n'y ferait rien,
    // en silence. Le drapeau se pose donc par `updateQueue`, que pg-boss applique à une file existante.
    if (notifieePour(name)) await this.boss.updateQueue(name, { notify: true });
    this.ensured.add(name);
  }

  async enqueue(
    name: string,
    data: unknown,
    opts?: { expireInSeconds?: number; groupId?: string; priority?: number; startAfter?: Date },
  ): Promise<void> {
    await this.ensure(name);
    // `expireInSeconds` par job : dimensionne la durée max d'un run de campagne throttlé, sinon un run long
    // expirerait et serait rejoué en parallèle. `groupId` -> `group.id` : l'espace, sur lequel `work` plafonne la
    // concurrence. `priority` : voir `sendOptions` et `PRIORITE_SIGNAL`.
    await this.boss.send(name, data as object, sendOptions(opts));
  }

  filesTravaillees(): readonly string[] {
    return [...this.travaillees];
  }

  async work(
    name: string,
    handler: (data: unknown) => Promise<void>,
    opts?: { concurrency?: number; groupConcurrency?: number },
  ): Promise<void> {
    await this.ensure(name);
    this.travaillees.push(name);
    // `batchSize: 1` garde l'invariant par job (un throw ne fait pas échouer un lot, ni rejouer des jobs réussis).
    // Cadences, filet et rafale viennent de `names.ts`, source unique : une file ajoutée sans y penser retombe sur
    // un défaut sûr. Le filet (`notifyPollingIntervalSeconds`) est sûr parce que `pollingIntervalSeconds` ne bouge
    // pas : pg-boss y retombe seul si l'écouteur meurt. Concurrence par groupe : voir `workConcurrencyOptions`.
    await this.boss.work<unknown>(
      name,
      {
        batchSize: 1,
        pollingIntervalSeconds: pollingSecondsFor(name),
        notifyPollingIntervalSeconds: filetNotifieSecondes(name),
        // La rafale : sans elle, le débit d'une file vaut `concurrence / cadence de sondage`, absurde sous retard.
        // Seuil par file (`SEUIL_RAFALE`, `SEUILS_RAFALE` dans `names.ts`).
        burstWhenReadyExceeds: seuilRafalePour(name),
        ...workConcurrencyOptions(opts ?? {}),
      },
      async (jobs) => {
        for (const job of jobs) {
          await handler(job.data);
        }
      },
    );
  }
}
