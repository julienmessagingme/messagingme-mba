import { parseWebhook } from './parse';
import { processStatuses } from './delivery';
import type { DeliveryStore } from './delivery';
import type { EventStore } from './store';

/**
 * Traitement d'un job webhook (côté worker) : parse le payload brut, insère chaque
 * événement de façon idempotente, puis (si `delivery` fourni) applique les statuts de
 * livraison Meta aux destinataires de campagne par message_id. Toute erreur est propagée
 * pour laisser pg-boss faire son retry -> DLQ.
 */
export async function handleWebhookJob(raw: unknown, store: EventStore, delivery?: DeliveryStore): Promise<void> {
  const events = parseWebhook(raw);
  for (const ev of events) {
    await store.insertEvent({ source: ev.source, dedupKey: ev.dedupKey, data: ev.data });
  }
  if (delivery) await processStatuses(events, delivery);
}
