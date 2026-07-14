import { buildTranscript, buildPrompt, parseLlmOutput, deduceHandledBy, countExchanges, type AnalysisMessage, type HandledBySignals } from './engine';
import type { LlmClient } from './llm-client';
import type { ConversationAnalysis } from './schema';

/** Sortie LLM invalide après le retry : ERREUR TERMINALE (contenu cassé) -> le job marque 'failed', ne rejoue pas. */
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
   * Borne de la fenêtre analysée = created_at du DERNIER message lu (null si aucun). Sert à la persistance : on
   * n'avance `analyzed_at` que jusqu'ici (PAS jusqu'à now()), sinon un message arrivé pendant l'analyse (statut encore
   * 'queued' -> la réouverture inbox ne le touche pas) passerait sous la borne et ne serait jamais réanalysé.
   */
  windowEnd?: Date | null;
}

/**
 * Analyse UNE conversation (orchestrateur, IO injectée -> testable sans réseau). Construit le transcript + le prompt,
 * appelle le LLM, valide la sortie, RETRY 1x sur JSON invalide (2e appel avec un rappel), puis fusionne avec les faits
 * déterministes (handled_by, exchanges_count). Throw InvalidLlmOutputError (terminal) si 2 sorties invalides.
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
