import { FetchTransport, withRetry, parseRetryAfter, type HttpTransport, HTTP_TIMEOUT_MODELE_MS } from '../../meta/http';
import { LlmApiError, PlafondModeleAtteint } from '../../llm/errors';
import { estPlafondAtteint } from './cles-gateway';

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
 * par ligne, alors que le client d'analyse (`AnthropicClient`) le fige au boot depuis `config.LLM_MODEL`.
 */

/**
 * Un message de la conversation, au format Chat Completions.
 *
 * 🔴 UN ALLER-RETOUR D'OUTIL A UNE FORME IMPOSÉE, et s'en écarter fait refuser le corps en 400. Le message
 * `tool` doit répondre à un message `assistant` qui porte `tool_calls` : « messages with role 'tool' must be
 * a response to a preceding message with 'tool_calls' ». Un `assistant` qui se contenterait de DÉCRIRE
 * l'appel en texte libre ne compte pas, et un 400 est TERMINAL (pas rejoué) : la conversation s'arrêterait
 * au deuxième tour, exactement là où l'agent reformule à partir de ses sources.
 *
 * `content` est donc nullable : c'est ce que l'API attend sur un `assistant` qui n'appelle que des outils.
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /** `assistant` : les appels d'outils décidés par le modèle, RENVOYÉS TELS QUELS au tour suivant. */
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  /** `tool` : identifiant de l'appel auquel ce message répond. */
  tool_call_id?: string;
}

/**
 * Un message qui porte une IMAGE, forme multimodale de Chat Completions.
 *
 * 🔴 Type SÉPARÉ, et `ChatMessage` n'est PAS élargi. Élargir `content` en `string | Part[]` a été essayé le
 * 2026-08-31 : le compilateur a immédiatement sorti une dizaine d'endroits qui lisent ce champ comme une
 * chaîne, dans le runtime de l'agent et ses tests, pour un besoin qu'AUCUN d'eux n'a. Un `ChatMessage[]`
 * reste assignable au tableau d'union ci-dessous, donc rien de l'existant ne bouge.
 *
 * Il ne sert qu'à la lecture d'une pièce jointe image par l'assistant de construction : elle est lue UNE fois,
 * au moment où le client la joint, et ce qu'on en tire est du TEXTE. Aucune image ne circule dans un tour
 * d'agent ni dans l'entretien persisté ; l'y garder ferait grossir une ligne jsonb de plusieurs méga et
 * referait payer la lecture à chaque tour.
 */
export interface ChatMessageImage {
  role: 'user';
  content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
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
     * 🔴 TOKENS D'ENTRÉE SERVIS DEPUIS UN CACHE, et c'est LA mesure qui décide de tout le dimensionnement IA.
     *
     * Pourquoi elle compte plus qu'elle n'en a l'air. Un tour d'agent n'est pas un appel : c'est jusqu'à six
     * allers-retours (`MAX_ALLERS_RETOURS`), et CHACUN renvoie l'intégralité du prompt système, des
     * définitions d'outils et des résultats d'outils déjà accumulés. La partie CONSTANTE (prompt système +
     * outils), rigoureusement identique d'un aller-retour à l'autre et d'un tour à l'autre, est donc payée
     * six fois par tour. Si le fournisseur la cache automatiquement, elle ne l'est qu'une fois.
     *
     * ⚠️ On n'envoie AUCUNE instruction de cache (`cache_control` absent du dépôt). Il serait FAUX d'en
     * conclure que rien n'est caché : certains fournisseurs cachent les préfixes longs sans qu'on demande.
     * Ce champ est le seul moyen de le SAVOIR au lieu de le supposer, et il arrivait déjà dans la réponse
     * sans que personne le lise. `0` veut dire soit « pas de cache », soit « champ non rendu par ce
     * fournisseur » : les deux se distinguent en regardant si le nombre reste nul sur un prompt long répété.
     */
    tokensCaches: number;
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
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
    /** Format OpenAI-compatible du Gateway. Absent chez un fournisseur qui ne le rend pas : lu en `0`. */
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

/**
 * Un coût lisible, ou 0. Voir la justification au point d'appel : le neutre sûr d'un budget est 0, jamais
 * NaN, et la chaîne vide en fait partie (`Number('')` vaut 0, ce qui est le bon résultat ici).
 */
function nombreOuZero(v: string | number | undefined): number {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export class GatewayChatClient {
  private static readonly URL = 'https://ai-gateway.vercel.sh/v1/chat/completions';

  constructor(
    private readonly apiKey: string,
    // Plafond LARGE : un modele a le droit d'etre lent la ou Meta n'en a pas le droit (cf. meta/http.ts).
    private readonly transport: HttpTransport = new FetchTransport(HTTP_TIMEOUT_MODELE_MS),
    /**
     * La cle PROPRE a l'espace, resolue a CHAQUE appel (2026-09-09).
     *
     * 🔴 RESOLUE A CHAQUE APPEL, JAMAIS MEMORISEE, et c'est la meme raison que pour les cles RCS
     * (`src/rcs/smsmode.ts`) : une cle peut naitre (creation du premier agent) ou changer pendant la vie du
     * process, et un appel parti apres doit porter la nouvelle. Memoriser ferait tourner un client sur une
     * cle morte jusqu'au prochain redemarrage.
     *
     * Absente ou rendant `null` -> la cle MAISON. C'est le repli des espaces d'avant ce lot, exactement
     * comme un espace RCS qui n'a pas encore fait son activation.
     */
    private readonly apiKeyFor?: (tenantId: string) => Promise<string | null>,
  ) {}

  /** La cle a poser sur CET appel : celle de l'espace si elle existe, sinon la notre. */
  private async cleDe(tenantId: string): Promise<string> {
    if (!this.apiKeyFor) return this.apiKey;
    const propre = await this.apiKeyFor(tenantId);
    return propre !== null && propre !== '' ? propre : this.apiKey;
  }

  async completer(input: {
    /**
     * L'espace pour le compte de qui cet appel est fait, et donc QUI LE PAIE.
     *
     * 🔴 OBLIGATOIRE, et ce n'est pas une coquetterie de type. Optionnel, il aurait ete oublie sur l'un des
     * appelants et cet appelant-la serait retombe en silence sur la cle maison : la depense d'un client
     * aurait continue de tomber dans le pot commun, sans aucun signe. Le rendre obligatoire fait dire au
     * COMPILATEUR quels sites de construction restent a cabler, ce qui est precisement la garde que le depot
     * reclame pour toute capacite ajoutee (« cablee PARTOUT ? »).
     */
    tenantId: string;
    modele: string;
    /** Un `ChatMessage[]` ordinaire convient : l'union n'existe que pour la lecture d'une image. */
    messages: Array<ChatMessage | ChatMessageImage>;
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
    // Resolue ICI, hors de `withRetry` : une cle relue a chaque tentative ferait une lecture de base par
    // rejeu, pour une valeur qui ne change pas pendant les quelques secondes d'un rejeu.
    const cle = await this.cleDe(input.tenantId);
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
          { authorization: `Bearer ${cle}` },
          input.signal ? { signal: input.signal } : undefined,
        );
        if (res.status < 200 || res.status >= 300) {
          // 🔴 LE PLAFOND AVANT LE STATUT. Vercel refuse un plafond atteint en 429, et 429 est rejouable
          // trois lignes plus bas : sans ce test AVANT, un client a sec repayait trois tentatives par
          // message recu, toutes perdues. Le TYPE est lu, jamais le message, qui porte des montants.
          if (estPlafondAtteint(res.json)) {
            throw new PlafondModeleAtteint(res.status, 'plafond de credit atteint pour cet espace');
          }
          // 429, 408 et 425 sont rejouables, comme le fait déjà `src/meta/errors.ts`. Un 400 (schéma d'outil
          // refusé), un 401 (clé), un 403 (aucun fournisseur disponible) et un 404 (modèle inconnu) sont
          // TERMINAUX : les rejouer paierait plusieurs fois la même erreur de configuration.
          // ⚠️ SAUF LE 429 D'UN PLAFOND ATTEINT, intercepté JUSTE AU-DESSUS. C'est le seul cas où le statut
          // ne suffit pas à décider : le même 429 dit « ralentis » (transitoire, on rejoue) ou « tu as
          // consommé ton crédit » (définitif, rejouer ne fait que perdre trois appels par message reçu).
          // Seul le corps les distingue, et c'est pour ça que sa lecture passe avant.
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
            // Le champ arrivait déjà et n'était pas lu : on ne SAVAIT donc pas si le cache tournait.
            tokensCaches: Number(body?.usage?.prompt_tokens_details?.cached_tokens ?? 0),
            // `gateway.cost` est une CHAÎNE décimale de dollars ; `usage.cost` porte la même valeur en
            // nombre. On lit la chaîne en premier (c'est le champ documenté), l'autre sert de repli.
            //
            // ⚠️ UN COÛT ILLISIBLE VAUT 0 ICI, ET `null` DANS LA TRANSCRIPTION : deux réponses différentes
            // à la même question, et les deux sont justes parce que le chiffre ne sert pas à la même chose.
            // Là-bas il est AFFICHÉ et journalisé, donc « on ne sait pas » doit se distinguer de « gratuit ».
            // Ici il est ADDITIONNÉ dans le budget du tour : il n'existe aucune façon de débiter un montant
            // inconnu, et refuser le tour priverait le contact d'une réponse déjà payée. 0 est le neutre sûr.
            //
            // ⚠️ EXPLICITE PLUTÔT QUE PAR ACCIDENT : `Number('gratuit')` rend NaN, qui se propageait jusqu'à
            // `microEurosDepuisDollars` où un `Number.isFinite` le rattrapait. Ça marchait, mais par un
            // garde-fou situé trois fichiers plus loin, et un NaN qui voyage dans un objet de comptabilité
            // finit par ressortir sur un écran.
            coutDollars: nombreOuZero(gateway?.cost ?? body?.usage?.cost),
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
