import { buildEvent, type EnrichedAnalyzedEvent } from './connector-push';
import type { StoredConversationAnalysis } from './events';
import type { Enrichment } from './enrichment';

export interface PushJobDeps {
  getEnrichment: (conversationId: string) => Promise<Enrichment | null>;
  /** GATE par numéro : la synchro HubSpot est-elle active pour la ligne (`whatsappLine`) du tenant ? false -> skip. */
  isHubspotConnected: (tenantId: string, whatsappLine: string) => Promise<boolean>;
  post: (event: EnrichedAnalyzedEvent) => Promise<void>;
  /** Journalisation optionnelle (skip HubSpot). */
  log?: (msg: string) => void;
}

/**
 * Handler du job `push-analysis` : charge l'enrichissement de la conversation, VÉRIFIE que la synchro HubSpot est
 * active pour le numéro concerné (toggle par numéro), assemble l'événement, le POST au connecteur. Conversation
 * disparue OU numéro non connecté à HubSpot -> no-op (skip). Une erreur de POST (429/5xx/réseau) REMONTE -> pg-boss
 * rejoue (DLQ). Le gate lit l'état LIVE à l'exécution : couper le toggle stoppe les push suivants immédiatement.
 */
export async function pushAnalysisJob(data: unknown, deps: PushJobDeps): Promise<void> {
  const stored = data as StoredConversationAnalysis | null;
  if (!stored || typeof stored.conversationId !== 'string' || typeof stored.tenantId !== 'string') {
    throw new Error('push-analysis : payload invalide (conversationId/tenantId manquant)');
  }
  const enr = await deps.getEnrichment(stored.conversationId);
  if (!enr) return; // conversation supprimée entre l'analyse et le push -> rien à pousser
  // GATE HubSpot par numéro : on ne pousse QUE si la ligne du tenant est connectée (backfill 0028 -> live préservée).
  const connected = await deps.isHubspotConnected(stored.tenantId, enr.whatsappLine);
  if (!connected) {
    deps.log?.(`push-analysis: ligne ${enr.whatsappLine} non connectée à HubSpot -> skip (conversation ${stored.conversationId})`);
    return;
  }
  await deps.post(buildEvent(stored, enr));
}
