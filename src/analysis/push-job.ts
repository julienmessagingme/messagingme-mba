import { buildEvent, type EnrichedAnalyzedEvent } from './connector-push';
import type { StoredConversationAnalysis } from './events';
import type { Enrichment } from './enrichment';

export interface PushJobDeps {
  getEnrichment: (conversationId: string) => Promise<Enrichment | null>;
  post: (event: EnrichedAnalyzedEvent) => Promise<void>;
}

/**
 * Handler du job `push-analysis` : charge l'enrichissement de la conversation, assemble l'événement, le POST au
 * connecteur. Conversation disparue -> no-op. Une erreur de POST (429/5xx/réseau) REMONTE -> pg-boss rejoue (DLQ).
 */
export async function pushAnalysisJob(data: unknown, deps: PushJobDeps): Promise<void> {
  const stored = data as StoredConversationAnalysis | null;
  if (!stored || typeof stored.conversationId !== 'string' || typeof stored.tenantId !== 'string') {
    throw new Error('push-analysis : payload invalide (conversationId/tenantId manquant)');
  }
  const enr = await deps.getEnrichment(stored.conversationId);
  if (!enr) return; // conversation supprimée entre l'analyse et le push -> rien à pousser
  await deps.post(buildEvent(stored, enr));
}
