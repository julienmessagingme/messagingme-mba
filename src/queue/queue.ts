/**
 * Abstraction de file de jobs. Permet de mocker en test (FakeQueue) et de
 * swapper l'implémentation (pg-boss aujourd'hui, BullMQ/Redis en Phase 3).
 */
export interface Queue {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Empile un job (fire-and-forget, durable côté impl réelle). */
  enqueue(name: string, data: unknown): Promise<void>;
  /** Enregistre un worker qui traite les jobs de la file `name`. */
  work(name: string, handler: (data: unknown) => Promise<void>): Promise<void>;
}
