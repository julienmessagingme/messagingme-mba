import { buildTranscript, buildPrompt, parseLlmOutput, deduceHandledBy, countExchanges, type AnalysisMessage, type HandledBySignals } from './engine';
import type { LlmClient } from './llm-client';
import type { ConversationAnalysis } from './schema';

/** Sortie LLM invalide après le rejeu : erreur terminale (contenu cassé), le job marque 'failed' sans rejouer. */
export class InvalidLlmOutputError extends Error {
  constructor() {
    super('sortie LLM invalide après retry');
    this.name = 'InvalidLlmOutputError';
  }
}

export interface AnalysisContext {
  messages: AnalysisMessage[];
  signals: HandledBySignals;
  /**
   * Borne de la fenêtre analysée : `created_at` du dernier message lu, en chaîne timestamptz (un Date JS tronquerait
   * les µs et ferait boucler la réanalyse). `analyzed_at` n'avance que jusqu'ici, jamais jusqu'à now() : un message
   * arrivé pendant l'analyse ne serait jamais réanalysé.
   */
  windowEnd?: string | null;
}

/**
 * Analyse une conversation (IO injectée) : transcript et prompt, appel au LLM, validation, un rejeu avec rappel sur
 * JSON invalide, puis fusion avec les faits déterministes (handled_by, exchanges_count). Lève InvalidLlmOutputError
 * (terminal) après deux sorties invalides.
 */
export async function analyzeConversation(ctx: AnalysisContext, deps: { llm: LlmClient }): Promise<ConversationAnalysis> {
  const transcript = buildTranscript(ctx.messages);
  const prompt = buildPrompt(transcript);

  let out = parseLlmOutput(await deps.llm.complete(prompt));
  if (!out) {
    const corrective = { system: prompt.system, user: `${prompt.user}\n\nRAPPEL : réponds UNIQUEMENT par l'objet JSON valide demandé, rien d'autre.` };
    out = parseLlmOutput(await deps.llm.complete(corrective));
  }
  if (!out) throw new InvalidLlmOutputError();

  return { ...out, handled_by: deduceHandledBy(ctx.signals), exchanges_count: countExchanges(ctx.messages) };
}
