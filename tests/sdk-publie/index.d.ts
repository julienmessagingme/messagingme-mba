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
export declare const DEFAULT_BASE_URL = "https://api.messagingme.app";
export type HttpMethod = 'get' | 'post' | 'patch' | 'delete';
/** Les chemins qui acceptent cette méthode. */
export type PathsWith<M extends HttpMethod> = {
    [P in keyof paths]: paths[P][M] extends {
        responses: unknown;
    } ? P : never;
}[keyof paths];
type Operation<P extends keyof paths, M extends HttpMethod> = NonNullable<paths[P][M]>;
type Json<C> = C extends {
    content: {
        'application/json': infer B;
    };
} ? B : never;
/** Le corps JSON qu'attend une route. */
export type RequestBody<P extends PathsWith<M>, M extends HttpMethod> = Operation<P, M> extends {
    requestBody: infer R;
} ? Json<R> : never;
type Succes<O> = O extends {
    responses: infer R;
} ? R[Extract<keyof R, 200 | 201 | 202 | 204>] : never;
type Contenu<X> = X extends {
    content: {
        'application/json': infer B;
    };
} ? B : X extends {
    content: {
        '*/*': unknown;
    };
} ? Blob : undefined;
/** Ce que rend une route en cas de succès : son JSON, un `Blob` pour un fichier, `undefined` pour un 204. */
export type ResponseBody<P extends PathsWith<M>, M extends HttpMethod> = Contenu<Succes<Operation<P, M>>>;
type ParamsChemin<O> = O extends {
    parameters: {
        path: infer X;
    };
} ? X : never;
type ParamsRequete<O> = O extends {
    parameters: {
        query?: infer Q;
    };
} ? NonNullable<Q> : never;
/** Les options d'un appel : le corps, les paramètres de chemin et de requête quand la route en a. */
export type RequestOptions<P extends PathsWith<M>, M extends HttpMethod> = ([RequestBody<P, M>] extends [never] ? {
    body?: never;
} : {
    body: RequestBody<P, M>;
}) & ([ParamsChemin<Operation<P, M>>] extends [never] ? {
    path?: never;
} : {
    path: ParamsChemin<Operation<P, M>>;
}) & ([ParamsRequete<Operation<P, M>>] extends [never] ? {
    query?: never;
} : {
    query?: ParamsRequete<Operation<P, M>>;
}) & {
    /** `Idempotency-Key` : rejouer l'appel avec la même clé rend le premier résultat (`POST /v1/sends`). */
    idempotencyKey?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
};
type Arguments<P extends PathsWith<M>, M extends HttpMethod> = {} extends RequestOptions<P, M> ? [options?: RequestOptions<P, M>] : [options: RequestOptions<P, M>];
/** Un code d'erreur de l'API (`invalid_body`, `window_closed`…). */
export type ErrorCode = NonNullable<components['schemas']['Error']['code']>;
/**
 * Une réponse hors 2xx. `code` est `null` quand la réponse n'est pas un JSON de l'API : la page d'erreur générique qui
 * remplace parfois un 5xx en chemin. Toute réponse d'erreur JSON de `/v1` porte un `code`.
 */
export declare class ApiError extends Error {
    readonly status: number;
    readonly code: ErrorCode | null;
    /** Secondes à attendre avant de réessayer (`Retry-After`), sur un 429 surtout ; `null` si l'API ne le dit pas. */
    readonly retryAfter: number | null;
    /** Sur un 402 : la page où l'offre se change. */
    readonly upgradeUrl: string | null;
    /** Le corps reçu, tel quel (l'objet JSON, ou le texte s'il n'en était pas un). */
    readonly body: unknown;
    /** Sur `meta_rejected` : le numéro d'erreur de Meta (131047…), `null` s'il n'en donne pas ou sur un autre code. */
    readonly metaCode: number | null;
    readonly name = "ApiError";
    constructor(status: number, code: ErrorCode | null, message: string, 
    /** Secondes à attendre avant de réessayer (`Retry-After`), sur un 429 surtout ; `null` si l'API ne le dit pas. */
    retryAfter: number | null, 
    /** Sur un 402 : la page où l'offre se change. */
    upgradeUrl: string | null, 
    /** Le corps reçu, tel quel (l'objet JSON, ou le texte s'il n'en était pas un). */
    body: unknown, 
    /** Sur `meta_rejected` : le numéro d'erreur de Meta (131047…), `null` s'il n'en donne pas ou sur un autre code. */
    metaCode?: number | null);
}
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
export declare function createClient(options: ClientOptions): Client;
export type WebhookEventType = keyof webhooks;
/** Un événement reçu, par type : `type` le discrimine. */
export type WebhookEvent<T extends WebhookEventType = WebhookEventType> = T extends WebhookEventType ? webhooks[T]['post']['requestBody']['content']['application/json'] : never;
/** La signature est absente, fausse, trop vieille, ou le corps n'est pas un événement. */
export declare class WebhookVerificationError extends Error {
    readonly name = "WebhookVerificationError";
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
/**
 * Vérifie un événement reçu (Standard Webhooks) et le rend typé. Lève `WebhookVerificationError` si la signature ne
 * correspond à aucun secret, si l'horodatage sort de la tolérance, ou si le corps n'est pas un événement ; `TypeError`
 * sur une erreur de configuration (secret vide ou illisible, tolérance qui n'est pas un nombre).
 *
 * La comparaison se fait par `subtle.verify`, en temps constant. Un même événement peut être reçu deux fois (réessai,
 * rejeu dans la fenêtre) : dédoublonner par `webhook-id`.
 */
export declare function verifyWebhook(o: VerifyWebhookOptions): Promise<WebhookEvent>;
