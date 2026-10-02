import { analyzeConversation, InvalidLlmOutputError, type AnalysisContext } from './analyzer';
import type { LlmClient } from './llm-client';
import type { OnConversationAnalyzed } from './events';
import type { ConversationAnalysis } from './schema';
import type { CopieFiche } from './fiche';

/** IO du job, injectée (sous-ensemble de PgConversationAnalysisStore). */
export interface AnalyzeStore {
  getContext(conversationId: string): Promise<AnalysisContext | null>;
  /** Rend ce que l'analyse a recopié sur la fiche du contact (`CopieFiche`), ou `null`. */
  save(conversationId: string, tenantId: string, a: ConversationAnalysis, model: { provider: string; model: string }, windowEnd: string | null): Promise<CopieFiche | null>;
  markDone(conversationId: string): Promise<void>;
  markFailed(conversationId: string): Promise<void>;
}

export interface AnalyzeJobDeps {
  store: AnalyzeStore;
  llm: LlmClient;
  onAnalyzed: OnConversationAnalyzed;
  model: { provider: string; model: string };
}

/**
 * Handler du job `analyze-conversation` : valide le payload, charge le contexte, analyse, persiste, appelle le point
 * de sortie. Sortie LLM invalide : markFailed sans rethrow (on ne rejoue pas un contenu cassé) ; réseau, 429, 5xx :
 * rethrow (pg-boss rejoue, DLQ à l'épuisement).
 */
export async function analyzeConversationJob(data: unknown, deps: AnalyzeJobDeps): Promise<void> {
  const d = data as { conversationId?: unknown; tenantId?: unknown } | null;
  const conversationId = d?.conversationId;
  const tenantId = d?.tenantId;
  if (typeof conversationId !== 'string' || conversationId === '' || typeof tenantId !== 'string' || tenantId === '') {
    throw new Error('analyze-conversation : conversationId/tenantId manquant dans le payload');
  }

  const ctx = await deps.store.getContext(conversationId);
  if (!ctx) return; // conversation disparue -> rien à faire (cascade de suppression fera le ménage)
  if (ctx.messages.length === 0) {
    await deps.store.markDone(conversationId); // rien de nouveau depuis la dernière analyse -> ne pas re-claim en boucle
    return;
  }

  let analysis: ConversationAnalysis;
  try {
    analysis = await analyzeConversation(ctx, { llm: deps.llm });
  } catch (err) {
    if (err instanceof InvalidLlmOutputError) {
      await deps.store.markFailed(conversationId);
      return; // terminal : pas de rethrow
    }
    throw err; // réseau/429/5xx : rethrow -> pg-boss retry + DLQ
  }

  // La copie rendue par `save` part avec l'événement, UN seul point d'appel, direct : un rejeu recopie la même
  // analyse (l'ancienne copie vaut la nouvelle), donc ne fait naître aucun « devient » ; un crash entre les deux
  // lignes perd une transition sans jamais la doubler.
  const copieFiche = await deps.store.save(conversationId, tenantId, analysis, deps.model, ctx.windowEnd ?? null);
  await deps.onAnalyzed({ ...analysis, conversationId, tenantId, copieFiche });
}
