import { FetchTransport, withRetry, parseRetryAfter, type HttpTransport } from '../meta/http';

/** Prompt structuré (system + user) attendu par un LLM de chat. */
export interface LlmPrompt {
  system: string;
  user: string;
}

/** Contrat minimal d'un client LLM : une complétion texte. Agnostique du provider (Claude par défaut, OpenAI possible). */
export interface LlmClient {
  complete(prompt: LlmPrompt): Promise<string>;
}

/** Erreur d'appel LLM. `retryable` (429/5xx) est reconnu par `withRetry` (duck-typing) + par le job (rethrow -> pg-boss). */
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

/**
 * Client Anthropic (Claude) via l'API Messages en HTTP brut, sur le MÊME transport injectable + `withRetry` que les
 * clients Meta du repo (testable via FakeTransport, pas de dépendance en plus, cohérent avec la stack). 429/5xx ->
 * LlmApiError retryable (rejoué par withRetry, puis par pg-boss si épuisé). `refusal` -> erreur terminale (contenu).
 */
export class AnthropicClient implements LlmClient {
  private static readonly URL = 'https://api.anthropic.com/v1/messages';
  private static readonly VERSION = '2023-06-01';

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly maxTokens: number,
    private readonly transport: HttpTransport = new FetchTransport(),
  ) {}

  async complete(prompt: LlmPrompt): Promise<string> {
    return withRetry(async () => {
      const res = await this.transport.post(
        AnthropicClient.URL,
        {
          model: this.model,
          max_tokens: this.maxTokens,
          system: prompt.system,
          messages: [{ role: 'user', content: prompt.user }],
        },
        { 'x-api-key': this.apiKey, 'anthropic-version': AnthropicClient.VERSION },
      );
      if (res.status < 200 || res.status >= 300) {
        const retryable = res.status === 429 || res.status >= 500;
        const msg = (res.json as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${res.status}`;
        throw new LlmApiError(res.status, msg, retryable, parseRetryAfter(res.headers));
      }
      const body = res.json as { content?: Array<{ type?: string; text?: string }>; stop_reason?: string } | null;
      if (body?.stop_reason === 'refusal') {
        // Refus des classifieurs de sûreté (HTTP 200) : contenu non exploitable -> terminal, pas de retry.
        throw new LlmApiError(200, 'refus du modèle (safety)', false);
      }
      const text = body?.content?.find((b) => b.type === 'text')?.text ?? '';
      return text;
    });
  }
}

/** Fabrique le client LLM d'après la config (provider en env). Throw si le provider est inconnu (fail-fast). */
export function createLlmClient(
  cfg: { provider: string; apiKey: string; model: string; maxTokens: number },
  transport?: HttpTransport,
): LlmClient {
  if (cfg.provider === 'anthropic') {
    return new AnthropicClient(cfg.apiKey, cfg.model, cfg.maxTokens, transport);
  }
  throw new Error(`LLM provider inconnu : ${cfg.provider}`);
}
