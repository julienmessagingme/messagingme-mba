import { parseWebhook } from './parse';
import type { EventStore } from './store';

/**
 * Traitement d'un job webhook (côté worker) : parse le payload brut, puis
 * insère chaque événement de façon idempotente. Toute erreur est propagée
 * pour laisser pg-boss faire son retry -> DLQ.
 */
export async function handleWebhookJob(raw: unknown, store: EventStore): Promise<void> {
  const events = parseWebhook(raw);
  for (const ev of events) {
    await store.insertEvent({ source: ev.source, dedupKey: ev.dedupKey, data: ev.data });
  }
}
