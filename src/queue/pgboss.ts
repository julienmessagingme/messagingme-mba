import { PgBoss } from 'pg-boss';
import type { ConstructorOptions, MaintenanceOptions, SchedulingOptions, WorkOptions } from 'pg-boss';
import type { Queue } from './queue';
import { dlqName, filetNotifieSecondes, notifieePour, pollingSecondsFor, seuilRafalePour } from './names';
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
 * Option d'ÉCOUTE des notifications de l'instance pg-boss.
 */
export interface PgBossNotifyOpts {
  /**
   * `true` = cette instance OUVRE un écouteur LISTEN/NOTIFY, sur une connexion dédiée (pg-boss ne la prend pas
   * dans le pool de requêtes), et ses workers sont alors réveillés à l'instant où un job est créé sur une file
   * notifiée. À poser sur l'instance qui DÉPILE, exactement comme `supervise` : l'API ne fait qu'empiler, un
   * écouteur y consommerait une connexion pour rien. Côté producteur, aucune option n'est nécessaire, le
   * `pg_notify` est émis par pg-boss d'après le drapeau de la FILE.
   *
   * Défaut pg-boss : `false`.
   */
  ecouteNotifications?: boolean;
}

/**
 * Option d'écoute passée à pg-boss. Fonction PURE et exportée pour être testée, même raison et même piège que
 * `poolOptions` : `ecouteNotifications: false` est une valeur explicite, une option absente doit rester absente.
 *
 * ⚠️ Le type de retour vient de pg-boss pour la même raison que `maintenanceOptions` : un nom d'option mal
 * orthographié compilerait et ne ferait RIEN, et un écouteur qu'on croit actif alors qu'il ne l'est pas est
 * exactement le mode de panne que ce fichier passe son temps à éviter.
 */
export function notifyOptions(opts: PgBossNotifyOpts): Pick<ConstructorOptions, 'useListenNotify'> {
  return {
    ...(opts.ecouteNotifications !== undefined ? { useListenNotify: opts.ecouteNotifications } : {}),
  };
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
 * Options de CONCURRENCE passées à `boss.work`. Fonction PURE et exportée pour être testée, même raison et même
 * piège que `poolOptions` : une valeur explicite (`concurrency: 0`) doit être transmise, une option ABSENTE doit
 * rester absente pour que pg-boss applique son défaut (d'où `!== undefined`, jamais `?? valeur`).
 *
 * ⚠️ `localGroupConcurrency` (plafond par groupe, ex. par tenant) est un NO-OP tant que `localConcurrency` reste
 * à son défaut de 1 : un seul job en vol, tous groupes confondus, il n'y a rien à répartir. Le plafond par groupe
 * ne s'exprime que si le plafond global passe au-dessus de 1. Les deux se posent donc ENSEMBLE. On prend le suivi
 * EN MÉMOIRE (`local*`), gratuit : le worker est unique, la variante coordonnée par la base (`groupConcurrency`)
 * ne servirait qu'avec des réplicas et coûterait de l'egress pour rien.
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
 * Implémentation durable via pg-boss (Postgres/Supabase).
 * Chaque file a une dead-letter queue `<name>-dlq` et un retryLimit.
 */
export class PgBossQueue implements Queue {
  private readonly boss: PgBoss;
  private started = false;
  private readonly ensured = new Set<string>();
  /** Files consommées par CE process, dans l'ordre : le message de démarrage en dérive (jamais recopié). */
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
   * Branche un observateur sur les erreurs de pg-boss. SANS ça, pg-boss émet un event `error` (typiquement un
   * EMAXCONNSESSION sur son polling interne) qui, non capté, est une exception non gérée qui TUE le process.
   * C'est ce qui faisait redémarrer le conteneur en boucle. À appeler avant `start()`.
   */
  onError(cb: (err: unknown) => void): void {
    this.boss.on('error', cb);
  }

  /**
   * Branche un observateur sur les AVERTISSEMENTS de pg-boss. Le seul qui compte aujourd'hui est
   * `listen_notify_unavailable` : l'écouteur n'a pas pu s'établir, et l'instance retombe SILENCIEUSEMENT sur
   * le sondage seul. C'est un repli correct (cf. `notifyPollingIntervalSeconds` dans `work`), mais un repli
   * muet est un réglage qu'on croit actif : sans cet observateur, on croirait les entrants réveillés à
   * l'instant alors qu'ils attendraient leur tour d'horloge, et personne ne le saurait.
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
   * ⚠️ Les files sont créées SANS `policy`, donc en `standard` (pg-boss 12 : `manager.js`, `options.policy ||
   * QUEUE_POLICIES.standard`). Conséquence à connaître avant d'écrire quoi que ce soit qui compte dessus :
   * en `standard`, AUCUNE déduplication n'a lieu, ni par `singleton_key` ni autrement. Les index uniques qui
   * la rendraient (`job_i1`, `job_i2`, `job_i3`, `job_i6`, `job_i8`) sont tous partiels et filtrés sur une
   * autre policy que `standard`.
   *
   * 🔴 Et on ne peut PAS régler ça en ajoutant `policy` ici : pg-boss refuse tout changement de policy après
   * création (« queue policy cannot be changed after creation »), et les files de la production existent
   * déjà. Il faudrait de nouvelles files, donc de nouveaux noms, donc abandonner les jobs en vol. La
   * déduplication qui manque passera par un verrou applicatif, cf. `Queue.enqueue`.
   */
  private async ensure(name: string): Promise<void> {
    if (this.ensured.has(name)) return;
    const dlq = dlqName(name); // convention -dlq partagée avec src/queue/names.ts (source unique, cf. /ops)
    await this.boss.createQueue(dlq);
    await this.boss.createQueue(name, {
      deadLetter: dlq,
      retryLimit: this.retryLimit,
      retryBackoff: true,
    });
    // 🔴 `createQueue` est un `ON CONFLICT DO NOTHING` : sur une file qui EXISTE DÉJÀ (donc toutes celles de
    // la production), lui passer `notify: true` ne ferait strictement RIEN, en silence. C'est le mode de panne
    // que ce fichier passe son temps à éviter, et il se serait présenté ici sous sa forme la plus discrète : la
    // ligne aurait été écrite, relue, et n'aurait jamais réveillé personne. Le drapeau se pose donc par
    // `updateQueue`, que pg-boss applique bien à une file existante (contrairement à `policy` et `partition`,
    // qu'il refuse de changer après création).
    if (notifieePour(name)) await this.boss.updateQueue(name, { notify: true });
    this.ensured.add(name);
  }

  async enqueue(
    name: string,
    data: unknown,
    opts?: { expireInSeconds?: number; groupId?: string },
  ): Promise<void> {
    await this.ensure(name);
    // `expireInSeconds` PAR JOB (prime sur la policy de file) : dimensionne la durée max d'un run de campagne
    // throttlé sur son travail réel, sinon un run long expirerait et serait rejoué en parallèle.
    // `groupId` -> `group.id` : porte le tenant, sur lequel `work` applique un plafond de concurrence par groupe.
    await this.boss.send(name, data as object, {
      ...(opts?.expireInSeconds ? { expireInSeconds: opts.expireInSeconds } : {}),
      ...(opts?.groupId ? { group: { id: opts.groupId } } : {}),
    });
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
    // batchSize:1 verrouille l'invariant per-job de l'abstraction (un throw ne fait
    // pas échouer un lot entier / ne rejoue pas des jobs déjà réussis).
    // pollingIntervalSeconds : cadence PAR FILE (défaut pg-boss 2 s, trop bavard pour une base facturée à
    // l'egress). La valeur vient de `names.ts`, source unique, et non du call site : ajouter une file sans
    // penser à sa cadence retombe alors sur un défaut sûr au lieu de rouvrir la fuite.
    // Concurrence PAR GROUPE (ex. par tenant) : voir `workConcurrencyOptions`. Absente par défaut, donc les
    // files existantes (webhook, campaign-run, sweepers) gardent strictement le comportement d'aujourd'hui.
    // `notifyPollingIntervalSeconds` : la cadence de sondage QUAND la notification est active. C'est la
    // SECONDE décision que le commentaire précédent annonçait, et elle est prise le 2026-09-10 sur des
    // mesures de production : l'écouteur livre en 37 ms de moyenne sur 102 jobs réels, et le sondage à vide
    // pesait 88 % du trafic de la base. Le raisonnement complet, les chiffres et les deux vérifications dans
    // la source de pg-boss sont dans `names.ts` (`SONDAGE_FILET_NOTIFIE`).
    //
    // ⚠️ Ce qui rend le relâchement sûr n'est PAS ce filet, c'est `pollingIntervalSeconds` juste au-dessus,
    // qui ne bouge pas : pg-boss réévalue `isNotifyActive()` à chaque tour et y retombe seul si l'écouteur
    // meurt. Le pire cas reste donc le comportement d'hier.
    await this.boss.work<unknown>(
      name,
      {
        batchSize: 1,
        pollingIntervalSeconds: pollingSecondsFor(name),
        notifyPollingIntervalSeconds: filetNotifieSecondes(name),
        // 🔴 LA RAFALE. Sans elle, le débit d'une file vaut `concurrence / cadence de sondage` : deux jobs par
        // minute sur `webhook-status` (concurrence 1, cadence 30 s), MESURÉ en production, quand une campagne
        // de 5 000 destinataires en produit quinze mille.
        // ⚠️ Le facteur `concurrence` a longtemps manqué à cette phrase, et il n'est pas cosmétique : c'est
        // lui qui a fait sonder `agent-turn` six fois par seconde (cf. `SONDAGE_FILET_NOTIFIE` dans
        // `names.ts`). Chaque unité de concurrence est un worker avec sa propre boucle. La cadence lente reste juste au REPOS et devient absurde sous retard. Détail et
        // chiffres dans `names.ts` (`SEUIL_RAFALE`, `SEUILS_RAFALE`).
        // ⚠️ LE SEUIL EST PAR FILE DEPUIS LE 2026-09-15, et le défaut ne convient pas partout : calibré sur
        // l'avalanche d'une campagne, il laissait les PAQUETS ordinaires (trois accusés par message) hors
        // rafale, donc à un job toutes les trente secondes. Une file sans entrée dans `SEUILS_RAFALE` garde
        // le défaut, et une file qui n'atteint jamais son seuil ne déclenche simplement jamais la rafale.
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
