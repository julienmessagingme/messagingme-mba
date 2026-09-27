import { FetchTransport, withRetry, parseRetryAfter, type HttpTransport, HTTP_TIMEOUT_MODELE_MS } from '../meta/http';
import { LlmApiError } from '../llm/errors';

/** Prompt structuré (system + user) attendu par un LLM de chat. */
export interface LlmPrompt {
  system: string;
  user: string;
}

/** Contrat minimal d'un client LLM : une complétion texte. Une seule implémentation existe (Anthropic). */
export interface LlmClient {
  complete(prompt: LlmPrompt): Promise<string>;
}

/**
 * Client Anthropic via l'API Messages en HTTP brut, sur le même transport injectable et `withRetry` que les clients
 * Meta. 429 et 5xx : LlmApiError rejouable (withRetry, puis pg-boss). `refusal` : erreur terminale.
 */
export class AnthropicClient implements LlmClient {
  private static readonly URL = 'https://api.anthropic.com/v1/messages';
  private static readonly VERSION = '2023-06-01';

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly maxTokens: number,
    // Plafond large : un modèle a le droit d'être lent, Meta non (cf. meta/http.ts).
    private readonly transport: HttpTransport = new FetchTransport(HTTP_TIMEOUT_MODELE_MS),
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
        // Refus des classifieurs de sûreté (HTTP 200) : contenu non exploitable, terminal.
        throw new LlmApiError(200, 'refus du modèle (safety)', false);
      }
      const text = body?.content?.find((b) => b.type === 'text')?.text ?? '';
      return text;
    });
  }
}
