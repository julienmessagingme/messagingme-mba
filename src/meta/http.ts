export interface HttpResponse {
  status: number;
  json: unknown;
  headers?: Record<string, string>;
}

/**
 * Transport HTTP injectable (fetch en prod, fake en test).
 *
 * `opts.signal` est OPTIONNEL et arrive en 4e position à dessein : une implémentation qui ne déclare que
 * trois paramètres reste assignable à ce type, donc les `FakeTransport` existants ne cassent pas. Sans lui,
 * un appel n'a AUCUN délai maximum (le défaut d'undici est de l'ordre de 300 s) : un fournisseur qui pend
 * immobiliserait un slot de worker pendant des minutes, sans la moindre trace.
 */
export interface HttpTransport {
  post(url: string, body: unknown, headers: Record<string, string>, opts?: { signal?: AbortSignal }): Promise<HttpResponse>;
}

/**
 * Le meme transport, plus `PATCH`.
 *
 * 🔴 UNE INTERFACE SÉPARÉE, ET PAS UN `patch` AJOUTÉ CI-DESSUS. Huit implémentations de `HttpTransport`
 * vivent dans ce dépôt, presque toutes des faux de test : y ajouter une méthode obligatoire les casserait
 * toutes, et l'ajouter en OPTIONNEL serait pire, un transport sans `patch` échouerait alors à l'exécution
 * sans que rien ne l'ait signalé à la compilation. Seul le module qui en a besoin (le plafond d'une clé du
 * Gateway) demande ce type, donc seul son faux doit le fournir, et le compilateur l'exige.
 */
export interface HttpTransportPatch extends HttpTransport {
  patch(url: string, body: unknown, headers: Record<string, string>, opts?: { signal?: AbortSignal }): Promise<HttpResponse>;
}

/**
 * Délai maximum d'un appel sortant quand l'appelant n'en impose pas.
 *
 * 30 s pour un fournisseur d'API ordinaire (Meta, HubSpot) : leurs réponses se comptent en centaines de
 * millisecondes, une seconde au pire. Ce plafond ne coupe donc jamais un appel sain, il ne coupe qu'un
 * SILENCE. 120 s pour un modèle de langage, qui a le droit d'être lent (une analyse de conversation longue,
 * un tour d'agent avec outils), et dont les appelants du chemin conversationnel imposent de toute façon leur
 * propre échéance, plus courte.
 */
export const HTTP_TIMEOUT_DEFAUT_MS = 30_000;
export const HTTP_TIMEOUT_MODELE_MS = 120_000;

/**
 * Notre propre plafond a coupé l'appel. `retryable` parce qu'un silence est le cas transitoire par
 * excellence : refuser de rejouer ferait échouer des envois parfaitement rejouables (c'est la mise en garde
 * explicite de l'audit du 2026-08-25).
 *
 * ⚠️ Ce que ça coûte, et qu'il faut savoir : la requête est PARTIE. Si le serveur l'a traitée puis a mis plus
 * de 30 s à répondre, le rejeu la traite une seconde fois, donc potentiellement un message WhatsApp envoyé
 * deux fois. Le dépôt acceptait déjà ce risque (`ECONNRESET` est rejoué et peut survenir après émission) ; le
 * plafond généreux est ce qui le garde théorique.
 */
export class HttpTimeoutError extends Error {
  readonly retryable = true;
  constructor(url: string, timeoutMs: number) {
    // L'URL est tronquée : celles de Meta portent des identifiants, et ce message finit dans les journaux.
    super(`délai dépassé (${timeoutMs} ms) sur ${url.split('?')[0]}`);
    this.name = 'HttpTimeoutError';
  }
}

/** Notre plafond a-t-il coupé cet appel ? `AbortSignal.timeout` fait rejeter `fetch` avec un `TimeoutError`. */
export function estAbandon(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

export class FetchTransport implements HttpTransportPatch {
  /**
   * ⚠️ Le délai est PAR INSTANCE, pas global : un client de modèle se construit avec
   * `new FetchTransport(HTTP_TIMEOUT_MODELE_MS)`. Un plafond unique serait forcément faux pour l'un des deux
   * usages, trop court pour un modèle ou inutilement long pour Meta.
   */
  constructor(private readonly timeoutMs: number = HTTP_TIMEOUT_DEFAUT_MS) {}

  post(url: string, body: unknown, headers: Record<string, string>, opts?: { signal?: AbortSignal }): Promise<HttpResponse> {
    return this.envoyer('POST', url, body, headers, opts);
  }

  /**
   * ⚠️ MÊME corps que `post`, verbe différent : tout ce que le commentaire ci-dessous dit du plafond, de
   * l'échéance de l'appelant et du corps coupé vaut identiquement. Les séparer en deux méthodes complètes
   * aurait fait deux endroits où corriger le prochain défaut de délai, et un seul l'aurait été.
   */
  patch(url: string, body: unknown, headers: Record<string, string>, opts?: { signal?: AbortSignal }): Promise<HttpResponse> {
    return this.envoyer('PATCH', url, body, headers, opts);
  }

  private async envoyer(methode: 'POST' | 'PATCH', url: string, body: unknown, headers: Record<string, string>, opts?: { signal?: AbortSignal }): Promise<HttpResponse> {
    // 🔴 Sans plafond, un fournisseur qui accepte la connexion et ne répond jamais immobilise le job (donc le
    // slot de worker) jusqu'au défaut d'undici, de l'ordre de cinq minutes. Sur la file `webhook`, sérialisée,
    // c'est l'entrant de TOUS les clients qui s'arrête derrière un seul appel pendu.
    //
    // L'échéance de l'APPELANT est prioritaire et laissée intacte : quand le cerveau d'un agent passe la
    // sienne, son abandon est une DÉCISION (« je n'ai plus le temps »), qu'il ne faut surtout pas convertir en
    // erreur rejouable, sinon la limite de temps serait multipliée par le nombre de tentatives.
    const notre = opts?.signal === undefined;
    const signal = opts?.signal ?? AbortSignal.timeout(this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: methode,
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (notre && estAbandon(err)) throw new HttpTimeoutError(url, this.timeoutMs);
      throw err;
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch (err) {
      // 🔴 Distinguer « corps illisible » de « corps COUPÉ ». Le plafond couvre aussi la lecture du corps : un
      // serveur qui envoie ses en-têtes puis se tait fait échouer ici. Sans ce test, le `catch` avalait
      // l'abandon et l'appel rendait `{ status: 200, json: null }`, c'est-à-dire un SUCCÈS au corps vide.
      if (notre && estAbandon(err)) throw new HttpTimeoutError(url, this.timeoutMs);
      json = null;
    }
    const respHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      respHeaders[k.toLowerCase()] = v;
    });
    return { status: res.status, json, headers: respHeaders };
  }
}

/** Extrait un délai (ms) d'un header Retry-After (secondes ou date HTTP). */
export function parseRetryAfter(headers: Record<string, string> | undefined): number | undefined {
  const v = headers?.['retry-after'];
  if (!v) return undefined;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(v);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/** Rejouable ? un flag `retryable === true` sur l'erreur (MetaApiError, LlmApiError, ...), OU une erreur réseau
 * RECONNAISSABLE uniquement (on ne rejoue pas un bug de programmation qui se déguiserait en throw). Le duck-typing
 * `retryable` préserve le comportement de MetaApiError (dont `retryable` est déjà un booléen) et généralise à tout
 * client réseau du repo. */
function isRetryable(err: unknown): boolean {
  if (err && typeof err === 'object' && (err as { retryable?: unknown }).retryable === true) return true;
  const code =
    (err as { cause?: { code?: string } })?.cause?.code ?? (err as { code?: string })?.code;
  if (code && NETWORK_CODES.has(code)) return true;
  if (err instanceof TypeError && /fetch failed|network/i.test(err.message)) return true;
  return false;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface RetryOpts {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Rejoue `fn` sur erreur rejouable avec backoff exponentiel BORNÉ + jitter.
 * Respecte `Retry-After` si l'erreur Meta en porte un, mais SANS DÉPASSER `maxDelayMs`. Erreur terminale ->
 * throw immédiat.
 *
 * Pourquoi plafonner un délai que Meta demande explicitement : ce sommeil a lieu DANS le job de la file
 * `webhook`, qui traite les entrants de TOUS les tenants en série (`batchSize: 1`, src/queue/pgboss.ts:141).
 * Un seul tenant à qui Meta répond `Retry-After: 3600` gèlerait donc l'inbox de tout le parc pendant une
 * heure, et autant de fois qu'il reste de tentatives. On préfère épuiser les tentatives en ~2 min et laisser
 * l'échec remonter à l'appelant, qui sait déjà le traiter (classification src/meta/errors.ts, mise en pause
 * de campagne). Le plafond ne touche pas le backoff, déjà borné par `cap` juste au-dessus.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const maxRetries = opts.maxRetries ?? 4;
  const base = opts.baseDelayMs ?? 300;
  const cap = opts.maxDelayMs ?? 30000;
  const factor = opts.factor ?? 2;
  const random = opts.random ?? Math.random;
  const sleep = opts.sleep ?? realSleep;

  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryable(err) || attempt >= maxRetries) throw err;
      const retryAfter = (err as { retryAfterMs?: number } | null)?.retryAfterMs;
      const capped = Math.min(cap, base * factor ** attempt);
      const backoff = Math.round(capped * (0.5 + random() * 0.5)); // jitter 50-100%
      await sleep(Math.min(retryAfter ?? backoff, cap));
      attempt += 1;
    }
  }
}

/** Limiteur de débit à intervalle minimal (throttle des envois par numéro). */
/**
 * Une porte de débit : « attends ton tour ». Déclarée ICI, dans la couche la plus basse, parce que le client
 * Meta en dépend et qu'il ne doit rien importer de la couche campagne. `RateLimiter` la satisfait, l'arbitre
 * par numéro aussi, et `RateGate` (campagne) a la même forme : le typage structurel les rend interchangeables
 * sans qu'aucune couche n'ait à connaître l'autre.
 */
export interface PorteDeDebit {
  acquire(): Promise<void>;
}

export class RateLimiter implements PorteDeDebit {
  private nextAllowed = 0;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly minIntervalMs: number,
    deps: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? realSleep;
  }

  async acquire(): Promise<void> {
    const t = this.now();
    const wait = Math.max(0, this.nextAllowed - t);
    this.nextAllowed = Math.max(t, this.nextAllowed) + this.minIntervalMs;
    if (wait > 0) await this.sleep(wait);
  }
}
