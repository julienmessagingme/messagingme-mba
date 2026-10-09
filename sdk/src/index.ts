/**
 * @messagingme/sdk : le client TypeScript de l'API Messaging Me (lot 16, livraison B).
 *
 * Aucune dépendance d'exécution : `fetch` natif, Web Crypto pour les signatures (Node 20 ou plus, Deno, Bun, Workers).
 * ESM seulement. Aucun import de `node:*` : le paquet se met en bundle tel quel pour un runtime qui n'est pas Node.
 * Les types viennent du contrat OpenAPI de l'API (`./schema.ts`, généré par `npm run sdk:contrat` dans le dépôt de
 * l'API) : un chemin, une méthode, un corps ou une réponse qui n'existent pas ne compilent pas.
 *
 * Aucune relance automatique (décision du 2026-10-09) : une erreur lève `ApiError`, avec `retryAfter` quand l'API dit
 * combien attendre, et l'application décide.
 */
import type { components, paths, webhooks } from './schema.js';

export type { components, paths, webhooks } from './schema.js';

/** L'adresse de l'API en production. */
export const DEFAULT_BASE_URL = 'https://api.messagingme.app';

// ---------------------------------------------------------------------------------------------------------------------
// Les types tirés du contrat.
// ---------------------------------------------------------------------------------------------------------------------

export type HttpMethod = 'get' | 'post' | 'patch' | 'delete';

/** Les chemins qui acceptent cette méthode. */
export type PathsWith<M extends HttpMethod> = {
  [P in keyof paths]: paths[P][M] extends { responses: unknown } ? P : never;
}[keyof paths];

type Operation<P extends keyof paths, M extends HttpMethod> = NonNullable<paths[P][M]>;
type Json<C> = C extends { content: { 'application/json': infer B } } ? B : never;

/** Le corps JSON qu'attend une route. */
export type RequestBody<P extends PathsWith<M>, M extends HttpMethod> =
  Operation<P, M> extends { requestBody: infer R } ? Json<R> : never;

type Succes<O> = O extends { responses: infer R } ? R[Extract<keyof R, 200 | 201 | 202 | 204>] : never;
type Contenu<X> = X extends { content: { 'application/json': infer B } } ? B
  : X extends { content: { '*/*': unknown } } ? Blob
    : undefined;

/** Ce que rend une route en cas de succès : son JSON, un `Blob` pour un fichier, `undefined` pour un 204. */
export type ResponseBody<P extends PathsWith<M>, M extends HttpMethod> = Contenu<Succes<Operation<P, M>>>;

type ParamsChemin<O> = O extends { parameters: { path: infer X } } ? X : never;
type ParamsRequete<O> = O extends { parameters: { query?: infer Q } } ? NonNullable<Q> : never;

/** Les options d'un appel : le corps, les paramètres de chemin et de requête quand la route en a. */
export type RequestOptions<P extends PathsWith<M>, M extends HttpMethod> =
  ([RequestBody<P, M>] extends [never] ? { body?: never } : { body: RequestBody<P, M> })
  & ([ParamsChemin<Operation<P, M>>] extends [never] ? { path?: never } : { path: ParamsChemin<Operation<P, M>> })
  & ([ParamsRequete<Operation<P, M>>] extends [never] ? { query?: never } : { query?: ParamsRequete<Operation<P, M>> })
  & {
    /** `Idempotency-Key` : rejouer l'appel avec la même clé rend le premier résultat (`POST /v1/sends`). */
    idempotencyKey?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  };

type Arguments<P extends PathsWith<M>, M extends HttpMethod> =
  {} extends RequestOptions<P, M> ? [options?: RequestOptions<P, M>] : [options: RequestOptions<P, M>];

/** Un code d'erreur de l'API (`invalid_body`, `window_closed`…). */
export type ErrorCode = NonNullable<components['schemas']['Error']['code']>;

// ---------------------------------------------------------------------------------------------------------------------
// Les erreurs.
// ---------------------------------------------------------------------------------------------------------------------

/** Une réponse hors 2xx. `code` est `null` sur une panne générique (JSON illisible, erreur interne, réponse non JSON). */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  constructor(
    readonly status: number,
    readonly code: ErrorCode | null,
    message: string,
    /** Secondes à attendre avant de réessayer (`Retry-After`), sur un 429 surtout ; `null` si l'API ne le dit pas. */
    readonly retryAfter: number | null,
    /** Sur un 402 : la page où l'offre se change. */
    readonly upgradeUrl: string | null,
    /** Le corps reçu, tel quel (l'objet JSON, ou le texte s'il n'en était pas un). */
    readonly body: unknown,
  ) {
    super(message);
  }
}

/** `Retry-After` en secondes : un nombre, ou une date HTTP. */
function secondesAAttendre(valeur: string | null, maintenant: number): number | null {
  if (valeur === null) return null;
  const v = valeur.trim();
  if (/^\d+$/.test(v)) return Number(v);
  const date = Date.parse(v);
  return Number.isNaN(date) ? null : Math.max(0, Math.ceil((date - maintenant) / 1000));
}

async function erreurDe(res: Response): Promise<ApiError> {
  const texte = await res.text().catch(() => '');
  let corps: unknown = texte;
  try { corps = texte === '' ? null : JSON.parse(texte); } catch { /* le texte tel quel */ }
  const objet = typeof corps === 'object' && corps !== null ? corps as Record<string, unknown> : null;
  const message = typeof objet?.error === 'string' ? objet.error : `HTTP ${res.status}${texte !== '' && objet === null ? ` : ${texte.slice(0, 200)}` : ''}`;
  return new ApiError(
    res.status,
    typeof objet?.code === 'string' ? objet.code as ErrorCode : null,
    message,
    secondesAAttendre(res.headers.get('retry-after'), Date.now()),
    typeof objet?.upgradeUrl === 'string' ? objet.upgradeUrl : null,
    corps,
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Le client.
// ---------------------------------------------------------------------------------------------------------------------

export interface ClientOptions {
  /** La clé d'API (`mba_…`), créée dans la console (Developers > Clés d'API). */
  apiKey: string;
  /** Par défaut `https://api.messagingme.app`. */
  baseUrl?: string;
  /** Un `fetch` à la place du `fetch` global (tests, proxy). */
  fetch?: typeof fetch;
}

export interface Client {
  GET<P extends PathsWith<'get'>>(path: P, ...args: Arguments<P, 'get'>): Promise<ResponseBody<P, 'get'>>;
  POST<P extends PathsWith<'post'>>(path: P, ...args: Arguments<P, 'post'>): Promise<ResponseBody<P, 'post'>>;
  PATCH<P extends PathsWith<'patch'>>(path: P, ...args: Arguments<P, 'patch'>): Promise<ResponseBody<P, 'patch'>>;
  DELETE<P extends PathsWith<'delete'>>(path: P, ...args: Arguments<P, 'delete'>): Promise<ResponseBody<P, 'delete'>>;
}

interface OptionsInternes {
  body?: unknown;
  path?: Record<string, string | number>;
  query?: Record<string, string | number | boolean | undefined>;
  idempotencyKey?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/** `/v1/contacts/{contactId}` et `{ contactId }` : chaque paramètre encodé, un paramètre manquant est une erreur. */
function remplirChemin(chemin: string, params: Record<string, string | number> | undefined): string {
  return chemin.replace(/\{(\w+)\}/g, (_, nom: string) => {
    const v = params?.[nom];
    if (v === undefined) throw new TypeError(`paramètre de chemin manquant : ${nom}`);
    return encodeURIComponent(String(v));
  });
}

export function createClient(options: ClientOptions): Client {
  if (typeof options.apiKey !== 'string' || options.apiKey.trim() === '') throw new TypeError('apiKey requise');
  const base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const appelerFetch = options.fetch ?? ((entree: RequestInfo | URL, init?: RequestInit) => fetch(entree, init));

  async function appeler(methode: string, chemin: string, o: OptionsInternes = {}): Promise<unknown> {
    const url = new URL(base + remplirChemin(chemin, o.path));
    for (const [cle, valeur] of Object.entries(o.query ?? {})) if (valeur !== undefined) url.searchParams.set(cle, String(valeur));
    const entetes = new Headers(o.headers);
    entetes.set('authorization', `Bearer ${options.apiKey}`);
    entetes.set('accept', 'application/json');
    if (o.idempotencyKey !== undefined) entetes.set('idempotency-key', o.idempotencyKey);
    let corps: string | undefined;
    if (o.body !== undefined) {
      entetes.set('content-type', 'application/json');
      corps = JSON.stringify(o.body);
    }
    const res = await appelerFetch(url, { method: methode, headers: entetes, body: corps, ...(o.signal ? { signal: o.signal } : {}) });
    if (!res.ok) throw await erreurDe(res);
    if (res.status === 204) return undefined;
    return (res.headers.get('content-type') ?? '').includes('json') ? res.json() : res.blob();
  }

  // Une seule implémentation, quatre signatures typées : les types disent ce que chaque route accepte et rend.
  const methode = (m: string) => (chemin: string, o?: OptionsInternes) => appeler(m, chemin, o);
  return { GET: methode('GET'), POST: methode('POST'), PATCH: methode('PATCH'), DELETE: methode('DELETE') } as unknown as Client;
}

// ---------------------------------------------------------------------------------------------------------------------
// Les webhooks.
// ---------------------------------------------------------------------------------------------------------------------

export type WebhookEventType = keyof webhooks;

/** Un événement reçu, par type : `type` le discrimine. */
export type WebhookEvent<T extends WebhookEventType = WebhookEventType> = T extends WebhookEventType
  ? webhooks[T]['post']['requestBody']['content']['application/json']
  : never;

/** La signature est absente, fausse, trop vieille, ou le corps n'est pas un événement. */
export class WebhookVerificationError extends Error {
  override readonly name = 'WebhookVerificationError';
}

export interface VerifyWebhookOptions {
  /** Le secret de l'adresse (`whsec_…`) ; plusieurs pendant une rotation (l'ancien signe encore 24 h). */
  secret: string | readonly string[];
  /** Les en-têtes reçus : un `Headers`, ou un objet (Express, Node `IncomingMessage.headers`). */
  headers: Headers | Record<string, string | readonly string[] | undefined>;
  /** Le corps BRUT, tel que reçu : la signature porte sur ses octets, un JSON reformaté ne se vérifie plus. */
  body: string | Uint8Array;
  /** L'écart toléré entre l'horodatage signé et maintenant, en secondes (300 par défaut). */
  toleranceSeconds?: number;
  /** Pour les tests : l'heure courante, en millisecondes. */
  now?: number;
}

const TOLERANCE_DEFAUT_S = 300;
/** Un HMAC-SHA256 fait 32 octets : une signature d'une autre longueur ne peut pas être la nôtre. */
const OCTETS_SIGNATURE = 32;
/**
 * Au plus tant de signatures examinées : nous en envoyons une, deux pendant une rotation. Sans plafond, un en-tête
 * rempli de candidates ferait calculer un HMAC du corps par candidate, sans connaître aucun secret.
 */
const MAX_SIGNATURES = 10;

function entete(headers: VerifyWebhookOptions['headers'], nom: string): string | null {
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(nom);
  const brut = Object.entries(headers as Record<string, string | readonly string[] | undefined>)
    .find(([cle]) => cle.toLowerCase() === nom)?.[1];
  if (brut === undefined) return null;
  return typeof brut === 'string' ? brut : brut.join(' ');
}

function octetsDuBase64(b64: string): Uint8Array<ArrayBuffer> {
  const binaire = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(binaire.length));
  for (let i = 0; i < binaire.length; i += 1) out[i] = binaire.charCodeAt(i);
  return out;
}

/**
 * Les clés des secrets. Un secret vide ou illisible est une erreur de CONFIGURATION de l'intégrateur, pas une
 * signature fausse : `TypeError`, pour qu'elle se voie (un 500 chez lui) au lieu de se confondre avec un 401.
 */
function clesDesSecrets(secret: string | readonly string[]): Uint8Array<ArrayBuffer>[] {
  const secrets = typeof secret === 'string' ? [secret] : secret;
  if (secrets.length === 0) throw new TypeError('secret requis');
  return secrets.map((s) => {
    let cle: Uint8Array<ArrayBuffer>;
    try { cle = octetsDuBase64(s.startsWith('whsec_') ? s.slice('whsec_'.length) : s); } catch { throw new TypeError('secret illisible : attendu whsec_ suivi de base64'); }
    if (cle.length === 0) throw new TypeError('secret vide');
    return cle;
  });
}

/**
 * Vérifie un événement reçu (Standard Webhooks) et le rend typé. Lève `WebhookVerificationError` si la signature ne
 * correspond à aucun secret, si l'horodatage sort de la tolérance, ou si le corps n'est pas un événement ; `TypeError`
 * sur une erreur de configuration (secret vide ou illisible, tolérance qui n'est pas un nombre).
 *
 * La comparaison se fait par `subtle.verify`, en temps constant. Un même événement peut être reçu deux fois (réessai,
 * rejeu dans la fenêtre) : dédoublonner par `webhook-id`.
 */
export async function verifyWebhook(o: VerifyWebhookOptions): Promise<WebhookEvent> {
  const tolerance = o.toleranceSeconds ?? TOLERANCE_DEFAUT_S;
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new TypeError('toleranceSeconds : un nombre de secondes, positif ou nul');
  const maintenant = o.now ?? Date.now();
  if (!Number.isFinite(maintenant)) throw new TypeError('now : un horodatage en millisecondes');
  const cles = clesDesSecrets(o.secret);
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) throw new TypeError('Web Crypto indisponible : Node 20 ou plus, Deno, Bun ou Workers');

  const id = entete(o.headers, 'webhook-id');
  const horodatage = entete(o.headers, 'webhook-timestamp');
  const signatures = entete(o.headers, 'webhook-signature');
  if (id === null || horodatage === null || signatures === null) throw new WebhookVerificationError('en-têtes webhook-id, webhook-timestamp ou webhook-signature absents');
  if (!/^\d+$/.test(horodatage)) throw new WebhookVerificationError('webhook-timestamp illisible');
  if (Math.abs(maintenant / 1000 - Number(horodatage)) > tolerance) throw new WebhookVerificationError('horodatage hors tolérance : événement trop ancien ou rejoué');

  // La préimage porte sur les octets REÇUS : un corps en octets n'est ni décodé ni réencodé avant d'être signé.
  const corps = typeof o.body === 'string' ? new TextEncoder().encode(o.body) : o.body;
  const prefixe = new TextEncoder().encode(`${id}.${horodatage}.`);
  const signe = new Uint8Array(prefixe.length + corps.length);
  signe.set(prefixe);
  signe.set(corps, prefixe.length);

  const vues = new Set<string>();
  const recues: Uint8Array<ArrayBuffer>[] = [];
  for (const s of signatures.split(' ')) {
    const [version, valeur] = s.split(',');
    if (version !== 'v1' || valeur === undefined || vues.has(valeur)) continue;
    vues.add(valeur);
    let octets: Uint8Array<ArrayBuffer>;
    try { octets = octetsDuBase64(valeur); } catch { continue; }
    if (octets.length === OCTETS_SIGNATURE) recues.push(octets);
    if (recues.length === MAX_SIGNATURES) break;
  }
  for (const cle of cles) {
    const k = await subtle.importKey('raw', cle, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    for (const recue of recues) if (await subtle.verify('HMAC', k, recue, signe)) return lireEvenement(corps);
  }
  throw new WebhookVerificationError('signature invalide');
}

function lireEvenement(octets: Uint8Array): WebhookEvent {
  let v: unknown;
  try { v = JSON.parse(new TextDecoder().decode(octets)); } catch { throw new WebhookVerificationError('corps illisible'); }
  const e = v as Partial<Record<'id' | 'type' | 'created_at' | 'workspace_id' | 'data', unknown>> | null;
  if (e === null || typeof e !== 'object' || typeof e.id !== 'string' || typeof e.type !== 'string' || typeof e.data !== 'object') {
    throw new WebhookVerificationError('corps signé qui n’est pas un événement');
  }
  return v as WebhookEvent;
}
