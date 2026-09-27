/** Abstraction de file de jobs : mockable en test (FakeQueue), implémentée par pg-boss. */
export interface Queue {
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Empile un job (fire-and-forget, durable côté implémentation réelle). `opts.expireInSeconds` : durée max du
   * job actif avant expiration et rejeu (par job, prime sur la policy de file), pour dimensionner un run de
   * campagne throttlé. `opts.groupId` : groupe du job (l'espace), plafonné côté `work`.
   *
   * 🔴 Aucune déduplication : les files sont en policy `standard`, où pg-boss ignore `singleton_key`, et une
   * policy est immuable après création. Deux enfilements = deux jobs qui tournent. Là où l'unicité compte, elle
   * est portée par un verrou applicatif posé à l'exécution (modèle : `src/campaign/run-lock.ts`).
   */
  enqueue(
    name: string,
    data: unknown,
    /**
     * `priority` : pg-boss prend les jobs par `priority desc`, puis par date de création. Absente = 0. Fait passer
     * les signaux de geste devant un arriéré d'accusés (`PRIORITE_SIGNAL`).
     * `startAfter` : le job n'est pas pris avant cet instant. Un job différé reste soumis à la rétention de
     * pg-boss (14 jours dans l'état « créé ») : ce n'est pas un agenda.
     */
    opts?: { expireInSeconds?: number; groupId?: string; priority?: number; startAfter?: Date },
  ): Promise<void>;
  /**
   * Enregistre un worker qui traite les jobs de la file `name`.
   *
   * `opts.concurrency` : jobs en vol pour cette file, tous groupes confondus (pg-boss `localConcurrency`). Chaque
   * unité sonde indépendamment : relever la concurrence multiplie le coût de sondage à vide (cf. `names.ts`).
   * Défaut : 1. `opts.groupConcurrency` : plafond par groupe (`groupId`), sans effet tant que `concurrency` vaut 1.
   */
  work(
    name: string,
    handler: (data: unknown) => Promise<void>,
    opts?: { concurrency?: number; groupConcurrency?: number },
  ): Promise<void>;
  /** Les files consommées par ce process, dans l'ordre : le message de démarrage du worker en dérive. */
  filesTravaillees(): readonly string[];
}
