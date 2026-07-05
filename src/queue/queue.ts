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
   * concurrents de la même campagne.
   */
  enqueue(name: string, data: unknown, opts?: { singletonKey?: string }): Promise<void>;
  /** Enregistre un worker qui traite les jobs de la file `name`. */
  work(name: string, handler: (data: unknown) => Promise<void>): Promise<void>;
}
