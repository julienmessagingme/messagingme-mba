/**
 * Abstraction de file de jobs. Permet de mocker en test (FakeQueue) et de
 * swapper l'implémentation (pg-boss aujourd'hui, BullMQ/Redis en Phase 3).
 */
export interface Queue {
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Empile un job (fire-and-forget, durable côté impl réelle). `opts.expireInSeconds` : durée max du job
   * ACTIF avant qu'il soit considéré expiré et rejoué (par-job, prime sur la policy de file). Sert à
   * dimensionner un run de campagne throttlé sur son travail réel (sinon un run long expire et est rejoué en
   * parallèle). `opts.groupId` : groupe du job (ex. le tenant), pour un plafond de concurrence PAR GROUPE
   * côté `work`.
   *
   * 🔴 **Il n'y a AUCUNE déduplication ici, et `singletonKey` a été RETIRÉ le 2026-08-31 parce qu'il n'en
   * apportait aucune.** Le dépôt en posait un sur sept enfilements en croyant garantir « un seul job vivant
   * par campagne / par conversation ». C'était faux depuis toujours : pg-boss ne déduplique sur
   * `singleton_key` que via des index uniques PARTIELS, tous conditionnés à une policy de file (`short`,
   * `singleton`, `stately`, `exclusive`, `key_strict_fifo`), or `PgBossQueue.ensure()` crée les files sans
   * policy, donc en `standard`, où aucun de ces index ne s'applique. Le paramètre était accepté, écrit en
   * base, et ignoré.
   *
   * Ne pas le remettre : la policy d'une file est IMMUABLE après création, la reposer ne suffirait donc pas.
   * Là où l'unicité compte vraiment, elle est portée par un verrou APPLICATIF, pas par la file : pour les
   * campagnes, `src/campaign/run-lock.ts` (même patron qu'`api_idempotency`), posé à l'EXÉCUTION du job et non
   * à son enfilement. Écrire le même verrou pour une autre file se fait sur ce modèle.
   *
   * Toute file SANS verrou de ce genre n'a donc aucune unicité : deux enfilements = deux jobs qui tournent.
   */
  enqueue(
    name: string,
    data: unknown,
    opts?: { expireInSeconds?: number; groupId?: string },
  ): Promise<void>;
  /**
   * Enregistre un worker qui traite les jobs de la file `name`.
   *
   * `opts.concurrency` : nombre de jobs EN VOL simultanément pour CETTE file, tous groupes confondus
   * (pg-boss `localConcurrency`). Chaque unité spawn un worker qui POLLE INDÉPENDAMMENT : relever la
   * concurrence multiplie d'autant le coût de polling à vide de cette file (cf. `names.ts` sur l'egress).
   * Défaut : 1, soit le comportement actuel. `opts.groupConcurrency` : plafond de jobs simultanés POUR UN
   * MÊME groupe (le `groupId` posé à l'enqueue). SANS EFFET tant que `concurrency` reste à 1 : les deux se
   * posent ENSEMBLE.
   */
  work(
    name: string,
    handler: (data: unknown) => Promise<void>,
    opts?: { concurrency?: number; groupConcurrency?: number },
  ): Promise<void>;
  /**
   * Les files RÉELLEMENT consommées par ce process, dans l'ordre d'enregistrement.
   *
   * Existe pour que le message de démarrage du worker soit DÉRIVÉ et non recopié. Il l'était : une liste
   * écrite à la main, avec ses propres conditions (`si le Gateway est configuré`...), donc une seconde vérité
   * qui a menti le jour même de l'ajout de `webhook-status`, en annonçant sept files pour huit consommées.
   */
  filesTravaillees(): readonly string[];
}
