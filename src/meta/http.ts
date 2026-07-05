import { MetaApiError } from './errors';

export interface HttpResponse {
  status: number;
  json: unknown;
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
    return { status: res.status, json };
  }
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface RetryOpts {
  maxRetries?: number;
  baseDelayMs?: number;
  factor?: number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Rejoue `fn` sur erreur rejouable (MetaApiError.retryable, ou erreur réseau non-Meta)
 * avec backoff exponentiel + jitter, jusqu'à `maxRetries`. Erreur terminale -> throw immédiat.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const maxRetries = opts.maxRetries ?? 4;
  const base = opts.baseDelayMs ?? 300;
  const factor = opts.factor ?? 2;
  const random = opts.random ?? Math.random;
  const sleep = opts.sleep ?? realSleep;

  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const retryable = err instanceof MetaApiError ? err.retryable : true; // non-Meta = réseau
      if (!retryable || attempt >= maxRetries) throw err;
      const delay = Math.round(base * factor ** attempt * (1 + random() * 0.1));
      await sleep(delay);
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
