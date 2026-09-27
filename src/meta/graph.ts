import { HTTP_TIMEOUT_DEFAUT_MS, HttpTimeoutError, estAbandon } from './http';
import { MetaApiError, type MetaErrorBody } from './errors';
import type { FetchLike } from './templates';

/**
 * L'appel Graph authentifié des clients WhatsApp (modèles, flows, numéro, média entrant) : jeton en `Bearer`,
 * `fetch` injectable, corps JSON (`null` s'il est illisible), `MetaApiError` si non-2xx.
 * Distinct de `ClientGraph.call`, qui porte un plafond de durée et lève `ErreurGraph` avec une autre phrase,
 * lue par l'inscription et les publicités : les réunir changerait un comportement.
 */
export async function appelGraph(fetchImpl: FetchLike, token: string, url: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetchImpl(url, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
  const json = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) throw new MetaApiError(res.status, (json as { error?: MetaErrorBody } | null)?.error ?? null);
  return json;
}

/**
 * L'échec d'un appel Graph, avec son statut et son code. Le message reste celui d'une `Error` ordinaire ; le
 * code permet de distinguer un jeton refusé (401, 190) d'une panne sans relire la phrase.
 */
export class ErreurGraph extends Error {
  constructor(readonly status: number, readonly code: number | null, message: string) {
    super(message);
    this.name = 'ErreurGraph';
  }
}

/**
 * Meta a refusé le jeton lui-même (expiré, révoqué, session fermée), par opposition à une panne. Le code 10 est
 * dehors : il dit « cette action n'est pas permise », et « reconnectez-vous » serait faux pour ce client.
 */
export function estJetonRefuse(err: unknown): boolean {
  return err instanceof ErreurGraph && (err.status === 401 || err.code === 190 || err.code === 102);
}

/** Plafond de durée d'un appel Graph, très au-dessus d'un appel sain : la constante du transport HTTP, importée. */
const DELAI_GRAPH_MS = HTTP_TIMEOUT_DEFAUT_MS;

export abstract class ClientGraph {
  constructor(
    protected readonly appId: string,
    protected readonly appSecret: string,
    protected readonly version: string,
    protected readonly baseUrl = 'https://graph.facebook.com',
  ) {}

  /**
   * Un appel Graph a un plafond de durée, parce que `fetch` n'en a aucun : un Meta qui accepte la connexion sans
   * jamais répondre retiendrait le gestionnaire Fastify pour toujours. Ce plafond sert aussi l'inscription
   * WhatsApp. Un `init.signal` fourni par l'appelant l'emporte sur le plafond.
   */
  protected async call(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(DELAI_GRAPH_MS), ...init });
    } catch (err) {
      if (estAbandon(err)) throw new HttpTimeoutError(url, DELAI_GRAPH_MS);
      throw err;
    }
    // Distinguer « corps illisible » de « corps coupé » : l'échéance couvre aussi la lecture du corps. Un
    // `catch(() => ({}))` avalerait notre abandon et rendrait un succès au corps vide (sur `actifsAccordes`, un
    // « aucun compte » sur une connexion saine). Même traitement que le transport HTTP (`src/meta/http.ts`).
    let body: Record<string, unknown>;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch (err) {
      if (estAbandon(err)) throw new HttpTimeoutError(url, DELAI_GRAPH_MS);
      body = {};
    }
    if (!res.ok) {
      const err = (body as { error?: { message?: string; code?: number } }).error;
      throw new ErreurGraph(
        res.status,
        typeof err?.code === 'number' ? err.code : null,
        `Graph ${res.status}${err?.code !== undefined ? ` (#${err.code})` : ''} : ${err?.message ?? 'erreur inconnue'}`,
      );
    }
    return body;
  }

  /**
   * Échange le code rendu par la fenêtre Meta (TTL 30 s) contre le jeton du client. Même appel pour l'inscription
   * et les publicités : seule la configuration qui a ouvert la fenêtre change (permissions, type de jeton).
   */
  async exchangeCode(code: string): Promise<string> {
    const qs = new URLSearchParams({ client_id: this.appId, client_secret: this.appSecret, code });
    const body = await this.call(`${this.baseUrl}/${this.version}/oauth/access_token?${qs.toString()}`);
    const token = body['access_token'];
    if (typeof token !== 'string' || token === '') throw new Error("échange du code : pas d'access_token dans la réponse");
    return token;
  }

  /**
   * Les actifs qu'un jeton accorde pour les scopes demandés, lus dans le jeton (`GET /debug_token` ->
   * `granular_scopes[].target_ids`). `input_token` est le jeton inspecté ; l'autorisation doit être un jeton
   * d'application (`{app_id}|{app_secret}`), sans quoi Meta rend « (#100) You must provide an app access token ».
   * Le jeton d'app ne quitte jamais le serveur. Rend [] sans cible (un jeton non scopé rend `target_ids: null`).
   */
  protected async ciblesDuJeton(jeton: string, scopesVoulus: readonly string[]): Promise<string[]> {
    const qs = new URLSearchParams({ input_token: jeton, access_token: `${this.appId}|${this.appSecret}` });
    const body = await this.call(`${this.baseUrl}/${this.version}/debug_token?${qs.toString()}`);
    const data = (body['data'] ?? {}) as { granular_scopes?: unknown };
    const scopes = Array.isArray(data.granular_scopes) ? data.granular_scopes : [];
    const out: string[] = [];
    for (const s of scopes as Array<{ scope?: unknown; target_ids?: unknown }>) {
      if (typeof s?.scope !== 'string' || !scopesVoulus.includes(s.scope)) continue;
      for (const id of Array.isArray(s.target_ids) ? s.target_ids : []) {
        if (typeof id === 'string' && id !== '' && !out.includes(id)) out.push(id);
      }
    }
    return out;
  }
}
