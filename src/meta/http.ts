import { setTimeout as dormir } from 'node:timers/promises';

export interface HttpResponse {
  status: number;
  json: unknown;
  headers?: Record<string, string>;
}

/**
 * Transport HTTP injectable (fetch en prod, faux en test). `opts.signal` est optionnel et en 4e position pour
 * que les faux à trois paramètres restent assignables. Sans échéance, un appel n'a aucun délai maximum
 * (environ 300 s chez undici) et un fournisseur qui pend immobilise un slot de worker.
 */
export interface HttpTransport {
  post(url: string, body: unknown, headers: Record<string, string>, opts?: { signal?: AbortSignal }): Promise<HttpResponse>;
}

/**
 * Le même transport, plus `PATCH`. Interface séparée plutôt qu'un `patch` ajouté ci-dessus : obligatoire, il
 * casserait tous les faux de test ; optionnel, un transport sans `patch` échouerait à l'exécution sans que le
 * compilateur le signale. Seul le module qui en a besoin demande ce type.
 */
export interface HttpTransportPatch extends HttpTransport {
  patch(url: string, body: unknown, headers: Record<string, string>, opts?: { signal?: AbortSignal }): Promise<HttpResponse>;
}

/**
 * Délai maximum d'un appel sortant quand l'appelant n'en impose pas. 30 s pour une API ordinaire (Meta,
 * HubSpot), qui répond en moins d'une seconde : ce plafond ne coupe qu'un silence. 120 s pour un modèle de
 * langage, qui a le droit d'être lent.
 */
export const HTTP_TIMEOUT_DEFAUT_MS = 30_000;
export const HTTP_TIMEOUT_MODELE_MS = 120_000;

/**
 * Notre propre plafond a coupé l'appel. Rejouable : un silence est le cas transitoire par excellence.
 * La requête est pourtant partie : si le serveur l'a traitée en plus de 30 s, le rejeu peut envoyer deux fois
 * le même message (risque déjà accepté pour `ECONNRESET`), et le plafond généreux le garde théorique.
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
   * Le délai est par instance, pas global : un client de modèle se construit avec
   * `new FetchTransport(HTTP_TIMEOUT_MODELE_MS)`. Un plafond unique serait faux pour l'un des deux usages.
   */
  constructor(private readonly timeoutMs: number = HTTP_TIMEOUT_DEFAUT_MS) {}

  post(url: string, body: unknown, headers: Record<string, string>, opts?: { signal?: AbortSignal }): Promise<HttpResponse> {
    return this.envoyer('POST', url, body, headers, opts);
  }

  /**
   * Même corps que `post`, verbe différent : un seul endroit pour le plafond, l'échéance de l'appelant et le
   * corps coupé.
   */
  patch(url: string, body: unknown, headers: Record<string, string>, opts?: { signal?: AbortSignal }): Promise<HttpResponse> {
    return this.envoyer('PATCH', url, body, headers, opts);
  }

  /**
   * `DELETE` sans corps et sans lecture de la réponse : les API qui suppriment rendent 204, et `envoyer`
   * échouerait à parser un corps vide. On ne rend que le statut.
   */
  async delete(url: string, headers: Record<string, string>): Promise<{ status: number }> {
    const res = await fetch(url, {
      method: 'DELETE',
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    return { status: res.status };
  }

  private async envoyer(methode: 'POST' | 'PATCH', url: string, body: unknown, headers: Record<string, string>, opts?: { signal?: AbortSignal }): Promise<HttpResponse> {
    // Sans plafond, un fournisseur qui ne répond jamais immobilise le job (donc le slot de worker) jusqu'au défaut
    // d'undici ; sur la file `webhook`, sérialisée, c'est l'entrant de tous les clients qui s'arrête.
    // L'échéance de l'appelant est prioritaire et laissée intacte : son abandon est une décision, qu'il ne faut pas
    // convertir en erreur rejouable (la limite de temps serait multipliée par le nombre de tentatives).
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
      // Distinguer « corps illisible » de « corps coupé » : le plafond couvre aussi la lecture du corps, et avaler
      // l'abandon rendrait un succès au corps vide.
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

/**
 * Rejouable ? Un drapeau `retryable === true` sur l'erreur (MetaApiError, LlmApiError...), ou une erreur réseau
 * reconnaissable uniquement : on ne rejoue pas un bug de programmation déguisé en throw.
 */
function isRetryable(err: unknown): boolean {
  if (err && typeof err === 'object' && (err as { retryable?: unknown }).retryable === true) return true;
  const code =
    (err as { cause?: { code?: string } })?.cause?.code ?? (err as { code?: string })?.code;
  if (code && NETWORK_CODES.has(code)) return true;
  if (err instanceof TypeError && /fetch failed|network/i.test(err.message)) return true;
  return false;
}

export interface RetryOpts {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Rejoue `fn` sur erreur rejouable, avec backoff exponentiel borné et jitter ; une erreur terminale est relancée
 * tout de suite. `Retry-After` est respecté sans dépasser `maxDelayMs` : ce sommeil a lieu dans le job de la file
 * `webhook`, qui traite les entrants de tous les tenants en série, et un `Retry-After: 3600` gèlerait l'inbox de
 * tout le parc. On épuise plutôt les tentatives en deux minutes environ, et l'échec remonte à l'appelant.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const maxRetries = opts.maxRetries ?? 4;
  const base = opts.baseDelayMs ?? 300;
  const cap = opts.maxDelayMs ?? 30000;
  const factor = opts.factor ?? 2;
  const random = opts.random ?? Math.random;
  const sleep = opts.sleep ?? dormir;

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

/**
 * Une porte de débit : « attends ton tour ». Déclarée dans cette couche basse parce que le client Meta en dépend
 * sans rien importer de la campagne ; `RateLimiter`, l'arbitre par numéro et `RateGate` ont la même forme.
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
    this.sleep = deps.sleep ?? dormir;
  }

  async acquire(): Promise<void> {
    const t = this.now();
    const wait = Math.max(0, this.nextAllowed - t);
    this.nextAllowed = Math.max(t, this.nextAllowed) + this.minIntervalMs;
    if (wait > 0) await this.sleep(wait);
  }
}
