/**
 * Erreur d'appel à un modèle de langage, partagée par TOUS les clients LLM du repo.
 *
 * Extraite de `src/analysis/llm-client.ts` quand un second client est arrivé (l'agent) : la garder là-bas
 * aurait obligé le client de l'agent à importer depuis le module d'analyse de conversation, qui n'a rien à
 * voir. `analysis/llm-client.ts` la RÉ-EXPORTE, donc aucun import existant ne casse.
 *
 * `retryable` est reconnu par `withRetry` en duck-typing (`src/meta/http.ts`), et par les jobs qui laissent
 * remonter l'erreur jusqu'à pg-boss quand les tentatives sont épuisées.
 */
export class LlmApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'LlmApiError';
  }
}
