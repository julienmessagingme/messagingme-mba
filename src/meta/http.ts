export interface HttpResponse {
  status: number;
  json: unknown;
  headers?: Record<string, string>;
}

/** Transport HTTP injectable (fetch en prod, fake en test). */
export interface HttpTransport {
  post(url: string, body: unknown, headers: Record<string, string>): Promise<HttpResponse>;
}

export class FetchTransport implements HttpTransport {
  async post(url: string, body: unknown, headers: Record<string, string>): Promise<HttpResponse> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
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
 * Respecte `Retry-After` si l'erreur Meta en porte un. Erreur terminale -> throw immédiat.
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
      await sleep(retryAfter ?? backoff);
      attempt += 1;
    }
  }
}

/** Limiteur de débit à intervalle minimal (throttle des envois par numéro). */
export class RateLimiter {
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
