import { z } from 'zod';
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
 * code permet de distinguer un jeton refusé (401, 190) d'une panne sans relire la phrase. Le sous-code
 * (`error_subcode`) est ce qui nomme le refus précis chez Meta : il va au journal.
 */
export class ErreurGraph extends Error {
  constructor(readonly status: number, readonly code: number | null, message: string, readonly subcode: number | null = null) {
    super(message);
    this.name = 'ErreurGraph';
  }
}

/**
 * Le corps d'erreur de Graph, lu champ par champ : un champ d'une forme inattendue devient absent, sans emporter les
 * autres (on ne perd pas le message de Meta parce que son code serait une chaîne).
 */
const corpsErreurSchema = z.object({
  error: z.object({
    message: z.string().optional().catch(undefined),
    code: z.number().optional().catch(undefined),
    error_subcode: z.number().optional().catch(undefined),
    error_user_title: z.string().optional().catch(undefined),
    error_user_msg: z.string().optional().catch(undefined),
  }),
});

/**
 * Le message d'un refus de Graph. 🔴 La phrase utile au client est dans `error_user_title` et `error_user_msg` :
 * `message` n'est souvent que « Invalid parameter », qui ne dit ni quoi ni pourquoi. Elles passent donc en tête,
 * `message` suit entre parenthèses, et le code et le sous-code restent dans le préfixe, là où on les cherche au
 * journal. Même préférence que le gestionnaire d'erreurs de l'API pour `MetaApiError` (`src/server.ts`).
 */
export function messageErreurGraph(status: number, corps: unknown): { message: string; code: number | null; subcode: number | null } {
  const lu = corpsErreurSchema.safeParse(corps);
  const e: z.infer<typeof corpsErreurSchema>['error'] = lu.success ? lu.data.error : {};
  const code = e.code ?? null;
  const subcode = e.error_subcode ?? null;
  const prefixe = `Graph ${status}${code !== null ? ` (#${code}${subcode !== null ? `/${subcode}` : ''})` : ''}`;
  const lisible = [e.error_user_title, e.error_user_msg].filter((s): s is string => s !== undefined && s.trim() !== '').join(' : ');
  const brut = e.message ?? 'erreur inconnue';
  return { message: lisible !== '' ? `${prefixe} : ${lisible} (${brut})` : `${prefixe} : ${brut}`, code, subcode };
}

/**
 * Meta a refusé le jeton lui-même (expiré, révoqué, session fermée), par opposition à une panne. Le code 10 est
 * dehors : il dit « cette action n'est pas permise », et « reconnectez-vous » serait faux pour ce client.
 */
export function estJetonRefuse(err: unknown): boolean {
  return err instanceof ErreurGraph && (err.status === 401 || err.code === 190 || err.code === 102);
}

/**
 * Meta a REFUSÉ la demande (un 4xx chez lui), par opposition à notre panne (réseau, délai, base) ou à la sienne
 * (5xx). Seul ce cas porte un message écrit POUR le client (son compte, ses règles) : il peut aller à l'écran.
 * Une seule définition pour les routes des publicités, qui en font un 422 lisible derrière Cloudflare.
 */
export function estRefusDeMeta(err: unknown): err is ErreurGraph {
  return err instanceof ErreurGraph && err.status >= 400 && err.status < 500;
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
   * WhatsApp.
   *
   * 🔴 LE PLAFOND SE DONNE PAR `delaiMs`, JAMAIS PAR UN `init.signal`, et le type l'interdit. Un signal fourni par
   * l'appelant l'emportait sur le plafond, mais l'erreur d'abandon annonçait toujours le plafond ordinaire : un
   * morceau de vidéo coupé à cinq minutes se disait coupé à trente secondes, et le journal envoyait chercher au
   * mauvais endroit. Le délai qui coupe et le délai qu'on écrit sont désormais la même valeur.
   */
  protected async call(url: string, init?: Omit<RequestInit, 'signal'>, delaiMs: number = DELAI_GRAPH_MS): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(delaiMs) });
    } catch (err) {
      if (estAbandon(err)) throw new HttpTimeoutError(url, delaiMs);
      throw err;
    }
    // Distinguer « corps illisible » de « corps coupé » : l'échéance couvre aussi la lecture du corps. Un
    // `catch(() => ({}))` avalerait notre abandon et rendrait un succès au corps vide (sur `actifsAccordes`, un
    // « aucun compte » sur une connexion saine). Même traitement que le transport HTTP (`src/meta/http.ts`).
    let body: Record<string, unknown>;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch (err) {
      if (estAbandon(err)) throw new HttpTimeoutError(url, delaiMs);
      body = {};
    }
    if (!res.ok) {
      const e = messageErreurGraph(res.status, body);
      throw new ErreurGraph(res.status, e.code, e.message, e.subcode);
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
