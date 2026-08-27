/**
 * Abstraction de file de jobs. Permet de mocker en test (FakeQueue) et de
 * swapper l'implémentation (pg-boss aujourd'hui, BullMQ/Redis en Phase 3).
 */
export interface Queue {
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Empile un job (fire-and-forget, durable côté impl réelle). `opts.singletonKey` :
   * dédup côté file (un seul job actif pour cette clé), utile pour ne pas lancer deux runs
   * concurrents de la même campagne. `opts.expireInSeconds` : durée max du job ACTIF avant qu'il
   * soit considéré expiré et rejoué (par-job, prime sur la policy de file). Sert à dimensionner un
   * run de campagne throttlé sur son travail réel (sinon un run long expire et est rejoué en parallèle).
   * `opts.groupId` : groupe du job (ex. le tenant), pour un plafond de concurrence PAR GROUPE côté `work`.
   */
  enqueue(
    name: string,
    data: unknown,
    opts?: { singletonKey?: string; expireInSeconds?: number; groupId?: string },
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
}
