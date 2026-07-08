import { parseWebhook } from './parse';
import { processStatuses } from './delivery';
import { processInbound } from './inbound';
import type { DeliveryStore } from './delivery';
import type { InboxStore } from './inbound';
import type { EventStore } from './store';

/**
 * Traitement d'un job webhook (côté worker) : parse le payload brut, insère chaque
 * événement de façon idempotente, puis (si fournis) applique les statuts de livraison aux
 * destinataires (`delivery`) et enregistre les messages entrants en conversations (`inbox`).
 * Toute erreur est propagée pour laisser pg-boss faire son retry -> DLQ.
 */
export async function handleWebhookJob(
  raw: unknown,
  store: EventStore,
  delivery?: DeliveryStore,
  inbox?: InboxStore,
): Promise<void> {
  const events = parseWebhook(raw);
  for (const ev of events) {
    await store.insertEvent({ source: ev.source, dedupKey: ev.dedupKey, data: ev.data });
  }
  if (delivery) await processStatuses(events, delivery);
  if (inbox) await processInbound(raw, inbox);
}
