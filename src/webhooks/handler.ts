import { parseWebhook } from './parse';
import { processStatuses } from './delivery';
import { processInbound } from './inbound';
import { processFlowCompletions } from './flow-mapping';
import { processWorkflowAdvance } from './workflow-advance';
import type { DeliveryStore } from './delivery';
import type { InboxStore } from './inbound';
import type { FlowMappingLookup, ContactFieldWriter } from './flow-mapping';
import type { WorkflowAdvanceDeps } from './workflow-advance';
import type { EventStore } from './store';

/** Report des valeurs d'un WhatsApp Flow rempli vers les user fields du contact (optionnel). */
export interface FlowMappingDeps {
  lookup: FlowMappingLookup;
  writer: ContactFieldWriter;
}

/**
 * Traitement d'un job webhook (côté worker) : parse le payload brut, insère chaque
 * événement de façon idempotente, puis (si fournis) applique les statuts de livraison aux
 * destinataires (`delivery`) et enregistre les messages entrants en conversations (`inbox`).
 * Toute erreur des étapes cœur est propagée pour laisser pg-boss faire son retry -> DLQ.
 */
export async function handleWebhookJob(
  raw: unknown,
  store: EventStore,
  delivery?: DeliveryStore,
  inbox?: InboxStore,
  flowMapping?: FlowMappingDeps,
  workflowAdvance?: WorkflowAdvanceDeps,
): Promise<void> {
  const events = parseWebhook(raw);
  for (const ev of events) {
    await store.insertEvent({ source: ev.source, dedupKey: ev.dedupKey, data: ev.data });
  }
  if (delivery) await processStatuses(events, delivery);
  if (inbox) await processInbound(raw, inbox);
  // Report Flow -> user fields. ISOLÉ : ne doit JAMAIS faire échouer le job (partagé avec les statuts de
  // livraison + l'inbox). Un throw ici rejouerait/DLQ tout le webhook, donc aussi les statuts déjà traités.
  if (flowMapping) {
    try {
      await processFlowCompletions(raw, flowMapping.lookup, flowMapping.writer);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('handleWebhookJob: mapping flow ignoré:', err instanceof Error ? err.message : err);
    }
  }
  // Avance des workflows sur les réponses. ISOLÉ également (même raison : ne pas DLQ le webhook partagé).
  if (workflowAdvance) {
    try {
      await processWorkflowAdvance(raw, workflowAdvance);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('handleWebhookJob: avance workflow ignorée:', err instanceof Error ? err.message : err);
    }
  }
}
