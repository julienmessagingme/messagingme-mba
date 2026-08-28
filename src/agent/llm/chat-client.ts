import { FetchTransport, withRetry, parseRetryAfter, type HttpTransport } from '../../meta/http';
import { LlmApiError } from '../../llm/errors';

/**
 * Client Chat Completions du Vercel AI Gateway, pour l'agent.
 *
 * ⚠️ SECOND contrat, et non une extension de `LlmClient` (`src/analysis/llm-client.ts`). Celui-ci est
 * `complete(prompt): Promise<string>` : son seul canal de sortie est du texte, il ne peut donc porter ni
 * `usage`, ni appel d'outil, ni `finish_reason`, et `AnthropicClient.complete` JETTE déjà tout bloc non
 * texte. L'élargir imposerait de toucher deux fakes et deux consommateurs pour un besoin qu'aucun n'a.
 * Précédent maison recopié : `src/rcs/channel-info.ts` déclare une interface locale plutôt que d'élargir
 * `HttpTransport`.
 *
 * Le modèle est passé PAR APPEL et non au constructeur : c'est une colonne de la fiche d'agent, lue ligne
 * par ligne, alors que `createLlmClient` le fige au boot depuis `config.LLM_MODEL`.
 */

/** Un message de la conversation, au format Chat Completions. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Réponse à un appel d'outil : identifiant de l'appel auquel ce message répond. */
  tool_call_id?: string;
}

/** Un outil exposé au modèle. `parameters` est un JSON Schema déjà formé (sa dérivation est la tâche 15). */
export interface OutilExpose {
  name: string;
  description: string;
  parameters: unknown;
}

/** Un appel d'outil décidé par le modèle. `argumentsJson` est une CHAÎNE, telle que le modèle l'a produite. */
export interface AppelOutil {
  id: string;
  nom: string;
  argumentsJson: string;
}

export interface ReponseChat {
  /** Texte de la réponse, ou null si le modèle n'a produit que des appels d'outils. */
  texte: string | null;
  appelsOutils: AppelOutil[];
  /** `stop`, `length`, `tool_calls`... tel que rendu. Sert à distinguer une réponse tronquée d'une réponse finie. */
  finish: string | null;
  usage: {
    tokensIn: number;
    tokensOut: number;
    /**
     * Coût de CET appel, **en dollars**, tel que le Gateway le facture (hors surcharges).
     *
     * ⚠️ En DOLLARS, pas en euros. La colonne de budget s'appelle `budget_micro_eur` : la conversion (ou le
     * renommage) est une décision de facturation, pas du client. Elle est laissée à l'appelant, à trancher
     * avant la mise en service.
     */
    coutDollars: number;
  };
  /** Identifiant de génération du Gateway, pour réconcilier avec sa facturation. */
  generationId: string | null;
}

interface CorpsReponse {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string | null;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
      provider_metadata?: { gateway?: { cost?: string; generationId?: string } };
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
}

export class GatewayChatClient {
  private static readonly URL = 'https://ai-gateway.vercel.sh/v1/chat/completions';

  constructor(
    private readonly apiKey: string,
    private readonly transport: HttpTransport = new FetchTransport(),
  ) {}

  async completer(input: {
    modele: string;
    messages: ChatMessage[];
    outils?: OutilExpose[];
    /**
     * Force l'appel de CET outil, par son nom. Sert à la sortie structurée : plutôt que de demander du JSON
     * en prose et d'espérer, on déclare un outil dont les paramètres SONT le schéma attendu, et on oblige le
     * modèle à l'appeler. Le fournisseur valide alors le schéma pour nous.
     */
    toolChoice?: string;
    /** Coupe l'appel. Sans lui, un fournisseur qui pend immobilise un slot de worker pendant des minutes. */
    signal?: AbortSignal;
  }): Promise<ReponseChat> {
    return withRetry(
      async () => {
        const res = await this.transport.post(
          GatewayChatClient.URL,
          {
            model: input.modele,
            messages: input.messages,
            // Forme CHAT COMPLETIONS : le schéma vit sous `function.parameters`. La forme Responses, elle,
            // le met à la racine de l'outil ; se tromper fait refuser le corps en 400.
            ...(input.outils?.length
              ? { tools: input.outils.map((o) => ({ type: 'function', function: { name: o.name, description: o.description, parameters: o.parameters } })) }
              : {}),
            // Forme Chat Completions du choix d'outil forcé. Ignoré si aucun outil n'est déclaré : envoyer
            // `tool_choice` sans `tools` fait refuser le corps en 400 chez plusieurs fournisseurs.
            ...(input.toolChoice && input.outils?.length
              ? { tool_choice: { type: 'function', function: { name: input.toolChoice } } }
              : {}),
          },
          { authorization: `Bearer ${this.apiKey}` },
          input.signal ? { signal: input.signal } : undefined,
        );
        if (res.status < 200 || res.status >= 300) {
          // 429, 408 et 425 sont rejouables, comme le fait déjà `src/meta/errors.ts`. Un 400 (schéma d'outil
          // refusé), un 401 (clé), un 403 (aucun fournisseur disponible) et un 404 (modèle inconnu) sont
          // TERMINAUX : les rejouer paierait plusieurs fois la même erreur de configuration.
          const retryable = res.status === 429 || res.status === 408 || res.status === 425 || res.status >= 500;
          const msg = (res.json as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${res.status}`;
          throw new LlmApiError(res.status, msg, retryable, parseRetryAfter(res.headers));
        }
        const body = res.json as CorpsReponse | null;
        const choix = body?.choices?.[0];
        const message = choix?.message;
        const gateway = message?.provider_metadata?.gateway;
        return {
          texte: message?.content ?? null,
          appelsOutils: (message?.tool_calls ?? []).map((a) => ({
            id: String(a.id ?? ''),
            nom: String(a.function?.name ?? ''),
            argumentsJson: String(a.function?.arguments ?? ''),
          })),
          finish: choix?.finish_reason ?? null,
          usage: {
            // `usage` est à la RACINE du corps, en snake_case. Sur le message, on ne trouve que
            // `provider_metadata`.
            tokensIn: Number(body?.usage?.prompt_tokens ?? 0),
            tokensOut: Number(body?.usage?.completion_tokens ?? 0),
            // `gateway.cost` est une CHAÎNE décimale de dollars ; `usage.cost` porte la même valeur en
            // nombre. On lit la chaîne en premier (c'est le champ documenté), l'autre sert de repli.
            coutDollars: gateway?.cost !== undefined ? Number(gateway.cost) : Number(body?.usage?.cost ?? 0),
          },
          generationId: gateway?.generationId ?? null,
        };
      },
      // Options EXPLICITES, jamais les défauts. Ceux de `withRetry` sont `maxRetries: 4` et
      // `maxDelayMs: 30000`, et il dort jusqu'à 30 secondes sur un seul 429 portant un `Retry-After` long :
      // avec un budget de tour de 30 s, la seule attente de retry le consommerait en entier.
      { maxRetries: 2, baseDelayMs: 250, maxDelayMs: 2000 },
    );
  }
}
