import { FetchTransport, withRetry, parseRetryAfter, type HttpTransport, HTTP_TIMEOUT_MODELE_MS } from '../../meta/http';
import { LlmApiError, PlafondModeleAtteint } from '../../llm/errors';
import { estPlafondAtteint } from './cles-gateway';

/**
 * Client Chat Completions du Vercel AI Gateway, pour l'agent.
 *
 * Un second contrat plutôt qu'une extension de `LlmClient` (`src/analysis/llm-client.ts`), dont le seul canal
 * est du texte : ni `usage`, ni appel d'outil, ni `finish_reason`. Le modèle est passé par appel : c'est une
 * colonne de la fiche d'agent.
 */

/**
 * Un message de la conversation, au format Chat Completions.
 *
 * Un aller-retour d'outil a une forme imposée : le message `tool` doit répondre à un `assistant` qui porte
 * `tool_calls`, sinon le corps est refusé en 400 (terminal, donc conversation arrêtée). `content` est
 * nullable : c'est ce que l'API attend d'un `assistant` qui n'appelle que des outils.
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /** `assistant` : les appels d'outils décidés par le modèle, renvoyés tels quels au tour suivant. */
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  /** `tool` : identifiant de l'appel auquel ce message répond. */
  tool_call_id?: string;
}

/**
 * Un message qui porte une image, forme multimodale de Chat Completions. Type séparé pour ne pas élargir
 * `content` de `ChatMessage`, lu comme une chaîne partout. Sert seulement à lire une pièce jointe image de
 * l'assistant de construction, une fois : aucune image ne circule dans un tour ni dans l'entretien persisté.
 */
export interface ChatMessageImage {
  role: 'user';
  content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
}

/** Un outil exposé au modèle. `parameters` est un JSON Schema déjà formé (`llm/tool-schema.ts`). */
export interface OutilExpose {
  name: string;
  description: string;
  parameters: unknown;
}

/** Un appel d'outil décidé par le modèle. `argumentsJson` est une chaîne, telle que le modèle l'a produite. */
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
     * Tokens d'entrée servis depuis un cache. Un tour renvoie jusqu'à six fois le prompt système et les
     * outils : c'est la mesure qui dit si le fournisseur les cache. On n'envoie aucune instruction de cache ;
     * `0` veut dire « pas de cache » ou « champ non rendu par ce fournisseur ».
     */
    tokensCaches: number;
    /**
     * Coût de cet appel, en dollars, tel que le Gateway le facture. La conversion en euros est faite par
     * l'appelant (`devise.ts`).
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
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
    /** Format OpenAI-compatible du Gateway. Absent chez un fournisseur qui ne le rend pas : lu en `0`. */
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

/** Un coût lisible, ou 0 : le neutre sûr d'un budget est 0, jamais NaN (voir le point d'appel). */
function nombreOuZero(v: string | number | undefined): number {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export class GatewayChatClient {
  private static readonly URL = 'https://ai-gateway.vercel.sh/v1/chat/completions';

  constructor(
    private readonly apiKey: string,
    // Plafond large : un modèle a le droit d'être lent là où Meta n'en a pas le droit (cf. meta/http.ts).
    private readonly transport: HttpTransport = new FetchTransport(HTTP_TIMEOUT_MODELE_MS),
    /**
     * La clé propre à l'espace, résolue à chaque appel, jamais mémorisée : une clé peut naître ou changer
     * pendant la vie du process. Absente ou `null` : la clé maison.
     */
    private readonly apiKeyFor?: (tenantId: string) => Promise<string | null>,
  ) {}

  /** La clé à poser sur cet appel : celle de l'espace si elle existe, sinon la nôtre. */
  private async cleDe(tenantId: string): Promise<string> {
    if (!this.apiKeyFor) return this.apiKey;
    const propre = await this.apiKeyFor(tenantId);
    return propre !== null && propre !== '' ? propre : this.apiKey;
  }

  async completer(input: {
    /**
     * L'espace pour le compte de qui cet appel est fait, donc qui le paie. 🔴 Obligatoire : optionnel, un
     * appelant l'oublierait et la dépense de ce client tomberait en silence sur la clé maison.
     */
    tenantId: string;
    modele: string;
    /** Un `ChatMessage[]` ordinaire convient : l'union n'existe que pour la lecture d'une image. */
    messages: Array<ChatMessage | ChatMessageImage>;
    outils?: OutilExpose[];
    /**
     * Force l'appel de cet outil, par son nom : pour une sortie structurée, on déclare un outil dont les
     * paramètres sont le schéma attendu, et le fournisseur valide le schéma pour nous.
     */
    toolChoice?: string;
    /** Coupe l'appel. Sans lui, un fournisseur qui pend immobilise un slot de worker pendant des minutes. */
    signal?: AbortSignal;
  }): Promise<ReponseChat> {
    // Résolue ici, hors de `withRetry` : pas une lecture de base par rejeu pour une valeur qui ne change pas.
    const cle = await this.cleDe(input.tenantId);
    return withRetry(
      async () => {
        const res = await this.transport.post(
          GatewayChatClient.URL,
          {
            model: input.modele,
            messages: input.messages,
            // Forme Chat Completions : le schéma vit sous `function.parameters` (la forme Responses le met à la
            // racine) ; se tromper fait refuser le corps en 400.
            ...(input.outils?.length
              ? { tools: input.outils.map((o) => ({ type: 'function', function: { name: o.name, description: o.description, parameters: o.parameters } })) }
              : {}),
            // Forme Chat Completions du choix d'outil forcé. Ignoré si aucun outil n'est déclaré : envoyer
            // `tool_choice` sans `tools` fait refuser le corps en 400 chez plusieurs fournisseurs.
            ...(input.toolChoice && input.outils?.length
              ? { tool_choice: { type: 'function', function: { name: input.toolChoice } } }
              : {}),
          },
          { authorization: `Bearer ${cle}` },
          input.signal ? { signal: input.signal } : undefined,
        );
        if (res.status < 200 || res.status >= 300) {
          // 🔴 Le plafond avant le statut : Vercel refuse un plafond atteint en 429, rejouable plus bas, et un
          // client à sec repaierait trois tentatives par message reçu. On lit le type, jamais le message (il porte
          // des montants).
          if (estPlafondAtteint(res.json)) {
            throw new PlafondModeleAtteint(res.status, 'plafond de credit atteint pour cet espace');
          }
          // 429, 408, 425 et 5xx sont rejouables ; 400 (schéma d'outil), 401 (clé), 403 (aucun fournisseur) et
          // 404 (modèle inconnu) sont terminaux, les rejouer paierait la même erreur. Le 429 d'un plafond atteint
          // est intercepté juste au-dessus : seul le corps le distingue d'un « ralentis ».
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
            // `usage` est à la racine du corps, en snake_case ; sur le message, seulement `provider_metadata`.
            tokensIn: Number(body?.usage?.prompt_tokens ?? 0),
            tokensOut: Number(body?.usage?.completion_tokens ?? 0),
            tokensCaches: Number(body?.usage?.prompt_tokens_details?.cached_tokens ?? 0),
            // `gateway.cost` est une chaîne décimale de dollars, `usage.cost` la même valeur en nombre (repli).
            // Illisible, il vaut 0 ici et `null` dans la transcription : ici il est additionné au budget, et refuser
            // le tour priverait le contact d'une réponse déjà payée.
            coutDollars: nombreOuZero(gateway?.cost ?? body?.usage?.cost),
          },
          generationId: gateway?.generationId ?? null,
        };
      },
      // Options explicites : les défauts de `withRetry` (4 rejeux, jusqu'à 30 s d'attente sur un `Retry-After`)
      // consommeraient à eux seuls le budget de 30 s d'un tour.
      { maxRetries: 2, baseDelayMs: 250, maxDelayMs: 2000 },
    );
  }
}
