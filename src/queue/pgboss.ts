import { PgBoss } from 'pg-boss';
import type { ConstructorOptions, MaintenanceOptions, SchedulingOptions, WorkOptions } from 'pg-boss';
import type { Queue } from './queue';
import {
  BATTEMENT_SECONDES, RAFRAICHISSEMENT_BATTEMENT_SECONDES, SURVEILLANCE_FILES_SECONDES, dlqName, filetNotifieSecondes, notifieePour,
  pollingSecondsFor, seuilRafalePour, videeEnContinu,
} from './names';
import { pgSsl } from '../db/ssl';

export interface PgBossPoolOpts {
  /** Max de connexions du pool pg-boss. Budget du pooler Supabase partagé (cf. `src/config.ts`). */
  max?: number;
  /** Timeout d'acquisition d'une connexion (ms). Sans lui, le sondage pg-boss attend indéfiniment. */
  connectionTimeoutMillis?: number;
}

/**
 * Le pool qu'on PRÊTE à pg-boss au lieu de le laisser ouvrir le sien (`pg.Pool` le satisfait) : la seule méthode
 * dont pg-boss a besoin, celle de son interface `Db` (`executeSql`). Un `db` fourni n'ouvre AUCUN pool : pg-boss
 * n'ouvre le sien que pour son adaptateur interne (`_pgbdb`, `start()` de `pg-boss/dist/index.js`).
 */
export interface PoolPrete {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

/**
 * Options de maintenance de l'instance pg-boss : rien de fonctionnel, seulement le bruit produit sur la base.
 * Deux instances tournent par service (l'API empile, le worker dépile). Celle qui a son pool supervise par défaut ;
 * celle qui emprunte un pool (l'API) ne supervise jamais, le prêt l'éteint (`PgBossQueue`).
 */
export interface PgBossMaintenanceOpts {
  /**
   * `false` = aucune maintenance (jobs expirés, monitoring, flow), pour une instance qui a son pool mais ne fait
   * qu'empiler : le worker s'en charge. Défaut pg-boss : `true`.
   */
  supervise?: boolean;
  /** Cadence (s) de la maintenance « flow » (jobs bloquants / parents). Défaut pg-boss : 5 s, inutile ici. */
  flowIntervalSeconds?: number;
  /** Cadence (s) de la supervision, et du moniteur qu'elle lance (tâches expirées ou muettes, comptes). Défaut : 60 s. */
  superviseIntervalSeconds?: number;
  monitorIntervalSeconds?: number;
  /** Cadence (s) du cache des files de l'instance (le compte qui décide de la rafale). Défaut pg-boss : 60 s. */
  queueCacheIntervalSeconds?: number;
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
    ...(opts.superviseIntervalSeconds !== undefined ? { superviseIntervalSeconds: opts.superviseIntervalSeconds } : {}),
    ...(opts.monitorIntervalSeconds !== undefined ? { monitorIntervalSeconds: opts.monitorIntervalSeconds } : {}),
    ...(opts.queueCacheIntervalSeconds !== undefined ? { queueCacheIntervalSeconds: opts.queueCacheIntervalSeconds } : {}),
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

/** Les messages de `Contractor.check()` de pg-boss : un schéma absent, ou à une autre version que celle du code. */
const SCHEMA_PAS_PRET = /pg-boss is not installed|pg-boss database requires migrations/;

type OptsPoolPropre = PgBossPoolOpts & PgBossMaintenanceOpts & PgBossNotifyOpts & { retryLimit?: number };

/** Implémentation durable via pg-boss. Chaque file a une dead-letter queue `<name>-dlq` et un retryLimit. */
export class PgBossQueue implements Queue {
  private readonly boss: PgBoss;
  private started = false;
  private readonly ensured = new Set<string>();
  /** Files consommées par ce process, dans l'ordre : le message de démarrage en dérive (jamais recopié). */
  private readonly travaillees: string[] = [];
  /** Restriction des files CONSOMMEES par ce processus. Absente = toutes, le comportement historique. */
  private travaille?: (nom: string) => boolean;
  private readonly retryLimit: number;
  /** `false` = instance sur un pool PRÊTÉ, qui ne migre jamais le schéma : son échec au démarrage le dit. */
  private readonly migre: boolean;

  /**
   * Sur une chaîne de connexion, pg-boss ouvre SON pool (le worker : il dépile, supervise, écoute, et migre).
   *
   * Sur un pool PRÊTÉ (l'API), l'instance ne fait qu'EMPILER, et tout le reste est éteint ICI plutôt qu'au site
   * d'appel, parce que c'est ce que le prêt implique : aucun pool à elle (sinon chaque copie de l'API réserve des
   * connexions de SESSION et N copies saturent le pooler), `migrate: false` (le worker migre ; sinon chaque copie
   * retente la migration à son démarrage et fait tourner le sondeur de migrations asynchrones de pg-boss, une
   * requête par minute et par copie), ni supervision ni écoute de notifications (le pool prêté
   * est en mode TRANSACTION en production, où un `LISTEN` et la maintenance ne tiennent pas, et le worker les
   * fait déjà). Ce qui reste passe par le pool prêté : la vérification de version au démarrage, le cache des
   * files (un `select` par minute) et les `send`, chacun une instruction autonome. Aucune option de pool, de
   * maintenance ou d'écoute n'est acceptée avec un prêt : le type le refuse, rien n'est ignoré en silence.
   */
  constructor(connexion: string, schema?: string, opts?: OptsPoolPropre);
  constructor(connexion: PoolPrete, schema?: string, opts?: { retryLimit?: number });
  constructor(connexion: string | PoolPrete, schema = 'pgboss', opts: OptsPoolPropre = {}) {
    this.retryLimit = opts.retryLimit ?? 5;
    this.migre = typeof connexion === 'string';
    this.boss = new PgBoss(
      typeof connexion === 'string'
        ? {
            connectionString: connexion,
            schema,
            ssl: pgSsl(),
            ...poolOptions(opts),
            // La surveillance resserrée va avec le battement de cœur des files (`ensure`) : sans elle, une orpheline
            // attendrait encore jusqu'à deux minutes de plus. Une valeur passée par l'appelant l'emporte.
            ...maintenanceOptions({
              superviseIntervalSeconds: SURVEILLANCE_FILES_SECONDES,
              monitorIntervalSeconds: SURVEILLANCE_FILES_SECONDES,
              queueCacheIntervalSeconds: SURVEILLANCE_FILES_SECONDES,
              ...opts,
            }),
            ...notifyOptions(opts),
          }
        : {
            // Le résultat tel que `pg` le rend, comme l'adaptateur interne de pg-boss (`db.js`, `executeSql`) : pour
            // une requête à plusieurs instructions (création de file), `pg` rend un TABLEAU que pg-boss ignore.
            db: { executeSql: (text, values) => connexion.query(text, values) },
            schema,
            migrate: false,
            useListenNotify: false,
            ...maintenanceOptions({ supervise: false }),
          },
    );
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

  /**
   * Sans migration, pg-boss VÉRIFIE que le schéma est à la version exacte de son code et lève sinon (dans les deux
   * sens : pas encore migré, ou migré par un worker plus récent). Son message dit « requires migrations », ce qui
   * pousse à rallumer la migration sur l'API ; on dit plutôt qui migre. L'échec reste un échec : le processus
   * s'arrête et son hôte le relance, ce qui revient à attendre le worker.
   */
  async start(): Promise<void> {
    if (this.started) return;
    try {
      await this.boss.start();
    } catch (err) {
      if (!this.migre && err instanceof Error && SCHEMA_PAS_PRET.test(err.message)) {
        throw new Error(
          `pg-boss : ${err.message}. Cette instance ne migre jamais le schéma, c'est le WORKER qui le fait : ` +
            `le démarrer (ou attendre la fin de sa migration) avant l'API, sur la même version de pg-boss.`,
          { cause: err },
        );
      }
      throw err;
    }
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
    // Le battement de cœur, par `updateQueue` pour la même raison : posé sur `createQueue`, il n'atteindrait aucune
    // file existante. Les tâches le recopient de leur file à la création (`BATTEMENT_SECONDES`, `names.ts`).
    await this.boss.updateQueue(name, { heartbeatSeconds: BATTEMENT_SECONDES });
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

  /**
   * Restreint les files que ce processus CONSOMME. Sans appel, il les consomme toutes : le defaut est
   * exactement le comportement d avant, et l API ne pose jamais cette restriction.
   *
   * 🔴 LA RESTRICTION VIT ICI ET PAS AUX ENREGISTREMENTS, et ce n est pas un detail de style : dix tests du
   * depot DERIVENT les files consommees du TEXTE de `worker.ts` en y cherchant `queue.work(`. Filtrer en
   * renommant l appel cassait cinq de ces gardes d un coup (mesure le 2026-10-03), donc il aurait fallu
   * reecrire des tests dont le role est precisement de verifier qu aucune file ne perd son consommateur.
   * Ici, elles restent intactes, et `filesTravaillees()` (donc le journal de demarrage) dit la verite sur ce
   * que ce processus ecoute, sans qu on ait a y penser.
   */
  neTravailleQue(predicat: (nom: string) => boolean): void {
    this.travaille = predicat;
  }

  filesTravaillees(): readonly string[] {
    return [...this.travaillees];
  }

  async work(
    name: string,
    handler: (data: unknown) => Promise<void>,
    opts?: { concurrency?: number; groupConcurrency?: number },
  ): Promise<void> {
    // ⚠️ AVANT le `ensure`, et c'est sans risque parce que `enqueue` fait SON PROPRE `ensure` (plus haut) :
    // un rôle peut donc enfiler dans une file qu'il ne consomme pas, la première écriture la crée. Il le fait
    // vraiment, par des chemins indirects : une analyse (rôle `analyse`) émet un signal ou déclenche une
    // automation, qui enfilent dans des files du rôle `principal`. L'API fait de même depuis toujours.
    // (Ce commentaire affirmait le contraire, « mesuré » sur les seuls appels DIRECTS : relecture du 2026-10-03.)
    if (this.travaille !== undefined && !this.travaille(name)) return;
    await this.ensure(name);
    this.travaillees.push(name);
    // `batchSize: 1` garde l'invariant par job (un throw ne fait pas échouer un lot, ni rejouer des jobs réussis).
    // Cadences, filet et rafale viennent de `names.ts`, source unique : une file ajoutée sans y penser retombe sur
    // un défaut sûr. Le filet (`notifyPollingIntervalSeconds`) est sûr parce que `pollingIntervalSeconds` ne bouge
    // pas : pg-boss y retombe seul si l'écouteur meurt. Concurrence par groupe : voir `workConcurrencyOptions`.
    //
    // 🔴 VIDAGE CONTINU (`FILES_VIDEES_EN_CONTINU`, `names.ts`) : la file est enregistrée boucle par boucle, pour en
    // connaître chaque identifiant, et chaque message traité les réveille toutes. Le plafond par contact
    // (`localGroupConcurrency`) tient toujours : pg-boss le suit par NOM de file, quelle que soit la registration.
    const vidage = videeEnContinu(name);
    const boucles: string[] = [];
    const enregistrer = (): Promise<string> => this.boss.work<unknown>(
      name,
      {
        batchSize: 1,
        pollingIntervalSeconds: pollingSecondsFor(name),
        notifyPollingIntervalSeconds: filetNotifieSecondes(name),
        // La rafale : sans elle, le débit d'une file vaut `concurrence / cadence de sondage`, absurde sous retard.
        // Seuil par file (`SEUIL_RAFALE`, `SEUILS_RAFALE` dans `names.ts`).
        burstWhenReadyExceeds: seuilRafalePour(name),
        // Le rafraîchissement du battement pendant le traitement (cf. `BATTEMENT_SECONDES`).
        heartbeatRefreshSeconds: RAFRAICHISSEMENT_BATTEMENT_SECONDES,
        ...workConcurrencyOptions(vidage ? { ...opts, concurrency: 1 } : (opts ?? {})),
      },
      async (jobs) => {
        for (const job of jobs) {
          try {
            await handler(job.data);
          } finally {
            // Réussi ou non, le message est sorti de la file : il en reste peut-être d'autres, chaque boucle relit.
            if (vidage) for (const id of boucles) this.boss.notifyWorker(id);
          }
        }
      },
    );
    const nombre = vidage ? Math.max(1, opts?.concurrency ?? 1) : 1;
    for (let i = 0; i < nombre; i += 1) boucles.push(await enregistrer());
  }
}
