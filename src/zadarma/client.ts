import { createHash, createHmac } from 'node:crypto';
import type { FetchLike } from '../meta/templates';

/** Échec d'un appel Zadarma. `retryable` pilote `withRetry` (réseau/429/5xx), comme MetaApiError. */
export class ZadarmaApiError extends Error {
  readonly retryable: boolean;
  constructor(readonly status: number, readonly body: string) {
    // Le corps FAIT PARTIE du message : c'est lui qui porte la cause réelle (« option non souscrite »,
    // « numéro inconnu »). Un message réduit au code HTTP obligerait à rejouer l'appel pour comprendre.
    super(`zadarma HTTP ${status}${body ? ` : ${body}` : ''}`);
    this.name = 'ZadarmaApiError';
    this.retryable = status === 429 || status >= 500;
  }
}

/**
 * Chaîne de paramètres attendue par Zadarma : triée par NOM DE CLÉ, encodée RFC 1738.
 *
 * Deux détails font échouer la signature si on les rate, et ils sont invisibles à la lecture :
 * le tri (`ksort` côté PHP) et l'espace encodé en `+` (RFC 1738) et non en `%20` (RFC 3986, ce que
 * fait `encodeURIComponent`). La même chaîne sert à signer ET à appeler : les dériver deux fois
 * séparément est le moyen le plus sûr de produire une signature qui ne correspond pas à l'URL.
 */
export function zadarmaQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k] ?? '').replace(/%20/g, '+')}`)
    .join('&');
}

/**
 * Signature d'une requête Zadarma : `base64( hex( hmac_sha1( method + params + md5(params), secret ) ) )`.
 *
 * ⚠️ LE piège, et il coûte des heures : on encode en base64 la représentation HEXADÉCIMALE du HMAC, pas ses
 * octets bruts. `hash_hmac('sha1', ...)` rend de l'hexadécimal par défaut côté PHP, l'exemple officiel le passe
 * tel quel à `base64_encode`. Une signature correcte fait 56 caractères ; 28 signifie qu'on a signé les octets,
 * et l'API répond alors 401 sans dire pourquoi (on croit ses clés mauvaises alors que c'est le code).
 * Vérifié en réel sur `/v1/info/balance/` le 2026-08-16.
 */
export function signZadarma(secret: string, method: string, paramsStr: string): string {
  const data = method + paramsStr + createHash('md5').update(paramsStr, 'utf8').digest('hex');
  const hex = createHmac('sha1', secret).update(data, 'utf8').digest('hex');
  return Buffer.from(hex, 'utf8').toString('base64');
}

/**
 * Client HTTP Zadarma. `fetch` injectable et `now` figeable, comme les autres clients externes du repo
 * (MetaPhoneNumberClient, MetaTemplateClient) : testable sans réseau.
 *
 * Toutes les méthodes (y compris PUT) passent leurs paramètres en QUERY STRING : c'est ce que l'API attend,
 * et c'est ce sur quoi porte la signature.
 */
export class ZadarmaClient {
  constructor(
    private readonly key: string,
    private readonly secret: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly baseUrl = 'https://api.zadarma.com',
  ) {}

  /**
   * ⚠️ EN LECTURE les paramètres vont dans l'URL, EN ÉCRITURE dans le CORPS (`x-www-form-urlencoded`), avec
   * l'URL nue. La signature porte sur la même chaîne dans les deux cas.
   *
   * Ce n'est pas un détail de style : un PUT dont les paramètres restent dans l'URL est reçu par Zadarma
   * SANS paramètres, sa signature est donc recalculée sur une chaîne vide et la réponse est un
   * « 401 Not authorized » qui accuse les clés alors qu'elles sont bonnes. Mesuré le 2026-08-16 : à
   * paramètres identiques, le GET répondait 404 (authentifié, ressource absente) et le PUT 401 ; les
   * paramètres passés dans le corps, le PUT répond 404 lui aussi.
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
    // Zadarma répond 200 avec `status:"error"` dans le corps : sans ce contrôle, un échec métier
    // (numéro inconnu, option non souscrite) passerait pour un succès et rendrait un objet vide.
    const j = json as { status?: unknown; message?: unknown };
    if (j?.status === 'error') throw new ZadarmaApiError(200, String(j.message ?? 'erreur zadarma'));
    return json;
  }
}
