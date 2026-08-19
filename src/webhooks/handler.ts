import { parseWebhook } from './parse';
import { processStatuses } from './delivery';
import type { NodeStatusSink } from './delivery';
import { processInbound } from './inbound';
import { processFlowCompletions } from './flow-mapping';
import { processWorkflowAdvance } from './workflow-advance';
import { processHandovers } from './handover';
import { processTriggers } from './triggers';
import { processTestTokens } from './test-token';
import type { DeliveryStore } from './delivery';
import type { InboxStore, InboundContactUpsert } from './inbound';
import type { FlowMappingLookup, ContactFieldWriter } from './flow-mapping';
import type { WorkflowAdvanceDeps } from './workflow-advance';
import type { HandoverDeps } from './handover';
import type { TriggerDeps } from './triggers';
import type { TestTokenDeps } from './test-token';
import type { EventStore } from './store';
import type { AuditSink } from '../audit/journal';

/** Report des valeurs d'un WhatsApp Flow rempli vers les user fields du contact (optionnel). */
export interface FlowMappingDeps {
  lookup: FlowMappingLookup;
  writer: ContactFieldWriter;
  /** Journal d'audit du consentement capté par le Flow. Optionnel -> aucune trace (câblages de test). */
  audit?: AuditSink;
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
  inboundContactUpsert?: InboundContactUpsert,
  handover?: HandoverDeps,
  /** Automations (Lot E). `isNewContact` est fourni ICI : il vient de l'upsert d'inbound, pas d'une requête. */
  triggers?: Omit<TriggerDeps, 'isNewContact'>,
  /** Jetons de test d'un scénario (Lot F). Prioritaires sur l'avance et sur les automations. */
  testTokens?: TestTokenDeps,
  /** Mesure par bloc (« Mes tableaux ») : rattache les accusés Meta au bloc qui a envoyé le message. */
  nodeEvents?: NodeStatusSink,
): Promise<void> {
  const events = parseWebhook(raw);
  // `insertEvent` renvoie false quand l'événement était DÉJÀ enregistré : c'est le signal « ce webhook est un
  // rejeu » (Meta redélivre quand l'ACK se perd, pg-boss réessaie un job interrompu). On le retient pour les
  // seules étapes NON idempotentes par ailleurs, aujourd'hui le démarrage d'un test (un rejeu renverrait la
  // séquence au testeur et facturerait les templates une seconde fois).
  const alreadySeen = new Set<string>();
  for (const ev of events) {
    const isNew = await store.insertEvent({ source: ev.source, dedupKey: ev.dedupKey, data: ev.data });
    if (!isNew && ev.dedupKey.startsWith('msg:')) alreadySeen.add(ev.dedupKey.slice(4));
  }
  if (delivery) await processStatuses(events, delivery, nodeEvents);
  // Contacts CRÉÉS par ce webhook (clé `tenant:waId`). Le signal « 1er message d'un contact inconnu » n'existe
  // qu'à l'instant de l'upsert : une fois la fiche créée, plus rien ne le distingue d'un habitué. On le capture
  // donc au vol, pour la durée de CE job (aucun état global, aucune requête supplémentaire).
  //
  // ⚠️ LIMITE ASSUMÉE : ce signal ne survit pas à un RETRY pg-boss du job. Si le webhook échoue après l'upsert
  // et qu'il est rejoué, la fiche existe déjà -> l'upsert renvoie 'updated' -> un déclencheur `new_contact` ne
  // partira pas pour ce contact. Le rendre infaillible imposerait une requête de comptage sur CHAQUE message
  // entrant, prix trop élevé pour un cas qui suppose déjà un job en échec. Le cas nominal est couvert.
  const createdContacts = new Set<string>();
  const upsert: InboundContactUpsert | undefined = inboundContactUpsert
    ? async (tenantId, m) => {
        const r = await inboundContactUpsert(tenantId, m);
        if (r === 'created') createdContacts.add(`${tenantId}:${m.waId}`);
        return r;
      }
    : undefined;
  if (inbox) await processInbound(raw, inbox, upsert);
  // Report Flow -> user fields. ISOLÉ : ne doit JAMAIS faire échouer le job (partagé avec les statuts de
  // livraison + l'inbox). Un throw ici rejouerait/DLQ tout le webhook, donc aussi les statuts déjà traités.
  if (flowMapping) {
    try {
      await processFlowCompletions(raw, flowMapping.lookup, flowMapping.writer, flowMapping.audit);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('handleWebhookJob: mapping flow ignoré:', err instanceof Error ? err.message : err);
    }
  }
  // Jetons de test d'un scénario (Lot F). AVANT l'avance et les automations, VOLONTAIREMENT : un jeton n'est
  // ni une réponse à un parcours en cours, ni un mot-clé ordinaire. Les messages qu'il consomme sont écartés
  // des deux étapes suivantes, sinon un seul message déclencherait deux choses. ISOLÉ comme les autres.
  let consumed: ReadonlySet<string> = new Set();
  if (testTokens) {
    try {
      consumed = await processTestTokens(raw, testTokens, alreadySeen);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('handleWebhookJob: jeton de test ignoré:', err instanceof Error ? err.message : err);
    }
  }
  // Avance des workflows sur les réponses. ISOLÉ également (même raison : ne pas DLQ le webhook partagé).
  if (workflowAdvance) {
    try {
      await processWorkflowAdvance(raw, workflowAdvance, consumed);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('handleWebhookJob: avance workflow ignorée:', err instanceof Error ? err.message : err);
    }
  }
  // Bascules de contrôle et messages de l'agent Meta (pré-câblage MBA). INERTE tant que MBA n'est activé
  // sur aucun numéro. ISOLÉ : ces événements sont les moins bien documentés de tous, donc les plus
  // susceptibles d'avoir une forme inattendue, et ils ne doivent surtout pas emporter les statuts de
  // livraison avec eux dans la DLQ.
  if (handover) {
    try {
      await processHandovers(raw, handover);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('handleWebhookJob: handover ignoré:', err instanceof Error ? err.message : err);
    }
  }
  // Automations déclenchées par un message (mot-clé, 1er message d'un nouveau contact). ISOLÉ, comme les
  // étapes ci-dessus : une automation mal configurée ne doit pas DLQ le webhook partagé. Volontairement en
  // DERNIER : l'inbox et l'avance de scénario passent d'abord, le déclenchement est un effet de bord.
  if (triggers) {
    try {
      await processTriggers(raw, {
        ...triggers,
        // CONSOMMÉ une seule fois : si Meta batche deux messages du même nouveau contact dans le même webhook,
        // seul le PREMIER est un « 1er message ». Sans le retrait, le second déclencherait aussi l'accueil.
        isNewContact: async (tenantId, waId) => createdContacts.delete(`${tenantId}:${waId}`),
      }, consumed);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('handleWebhookJob: automations ignorées:', err instanceof Error ? err.message : err);
    }
  }
}
