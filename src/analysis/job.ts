import { analyzeConversation, InvalidLlmOutputError, type AnalysisContext } from './analyzer';
import type { LlmClient } from './llm-client';
import type { OnConversationAnalyzed } from './events';
import type { ConversationAnalysis } from './schema';

/** IO du job (injectée -> testable sans DB/réseau). Sous-ensemble de PgConversationAnalysisStore. */
export interface AnalyzeStore {
  getContext(conversationId: string): Promise<AnalysisContext | null>;
  save(conversationId: string, tenantId: string, a: ConversationAnalysis, model: { provider: string; model: string }, windowEnd: string | null): Promise<void>;
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
 * Handler du job `analyze-conversation` (miroir de campaign/run-job) : valide le payload, charge le contexte, analyse,
 * persiste, appelle le point de sortie. Distinction rejouable/terminal : une sortie LLM invalide (InvalidLlmOutputError)
 * -> markFailed SANS rethrow (on ne rejoue pas un contenu cassé) ; une erreur réseau/429/5xx -> rethrow (pg-boss
 * rejoue avec backoff, DLQ à l'épuisement).
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

  await deps.store.save(conversationId, tenantId, analysis, deps.model, ctx.windowEnd ?? null);
  await deps.onAnalyzed({ ...analysis, conversationId, tenantId });
}
