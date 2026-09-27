import { createHash, createHmac } from 'node:crypto';
import type { FetchLike } from '../meta/templates';

/** Échec d'un appel Zadarma. `retryable` pilote `withRetry` (réseau, 429, 5xx), comme MetaApiError. */
export class ZadarmaApiError extends Error {
  readonly retryable: boolean;
  constructor(readonly status: number, readonly body: string) {
    // Le corps fait partie du message : c'est lui qui porte la cause réelle (« option non souscrite »...).
    super(`zadarma HTTP ${status}${body ? ` : ${body}` : ''}`);
    this.name = 'ZadarmaApiError';
    this.retryable = status === 429 || status >= 500;
  }
}

/**
 * Chaîne de paramètres attendue par Zadarma : triée par nom de clé (`ksort` côté PHP), encodée RFC 1738 (espace en
 * `+`, pas en `%20` comme `encodeURIComponent`). La même chaîne sert à signer et à appeler : la dériver deux fois
 * produirait une signature qui ne correspond pas à l'URL.
 */
export function zadarmaQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k] ?? '').replace(/%20/g, '+')}`)
    .join('&');
}

/**
 * Signature d'une requête Zadarma : `base64( hex( hmac_sha1( method + params + md5(params), secret ) ) )`.
 * On encode en base64 la représentation hexadécimale du HMAC, pas ses octets (une signature correcte fait 56
 * caractères, 28 veut dire octets bruts) : sinon l'API répond 401 sans dire pourquoi.
 */
export function signZadarma(secret: string, method: string, paramsStr: string): string {
  const data = method + paramsStr + createHash('md5').update(paramsStr, 'utf8').digest('hex');
  const hex = createHmac('sha1', secret).update(data, 'utf8').digest('hex');
  return Buffer.from(hex, 'utf8').toString('base64');
}

/**
 * Client HTTP Zadarma, `fetch` injectable, testable sans réseau. Les paramètres voyagent en chaîne de requête,
 * celle que porte la signature.
 */
export class ZadarmaClient {
  constructor(
    private readonly key: string,
    private readonly secret: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly baseUrl = 'https://api.zadarma.com',
  ) {}

  /**
   * En lecture, les paramètres vont dans l'URL ; en écriture, dans le corps (`x-www-form-urlencoded`) avec l'URL
   * nue. La signature porte sur la même chaîne. Un PUT aux paramètres dans l'URL est reçu sans paramètres, et la
   * réponse est un « 401 Not authorized » qui accuse les clés à tort.
   */
  async call(method: 'GET' | 'POST' | 'PUT', path: string, params: Record<string, string> = {}): Promise<unknown> {
    // `format=json` sur toutes les requêtes : sans lui certaines routes répondent en XML.
    const paramsStr = zadarmaQuery({ format: 'json', ...params });
    const auth = { Authorization: `${this.key}:${signZadarma(this.secret, path, paramsStr)}` };
    const enLecture = method === 'GET';
    const res = await this.fetchImpl(
      `${this.baseUrl}${path}${enLecture ? `?${paramsStr}` : ''}`,
      enLecture
        ? { method, headers: auth }
        : { method, headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' }, body: paramsStr },
    );
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new ZadarmaApiError(res.status, text.slice(0, 500));
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ZadarmaApiError(res.status, `réponse illisible: ${text.slice(0, 200)}`);
    }
    // Zadarma répond 200 avec `status:"error"` : sans ce contrôle, un échec métier passerait pour un succès.
    const j = json as { status?: unknown; message?: unknown };
    if (j?.status === 'error') throw new ZadarmaApiError(200, String(j.message ?? 'erreur zadarma'));
    return json;
  }
}
