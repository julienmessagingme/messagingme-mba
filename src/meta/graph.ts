/**
 * LE SOCLE COMMUN DES CLIENTS GRAPH (2026-09-23, lot 2 des publicités Click-to-WhatsApp).
 *
 * 🔴 EXTRAIT, PAS RÉÉCRIT. Trois choses étaient identiques entre l'inscription WhatsApp et les publicités :
 * l'appel Graph avec son message d'erreur, l'échange du code rendu par la fenêtre Meta, et la lecture des
 * cibles d'un `granular_scope` dans `debug_token`. Les recopier aurait créé deux vérités, et c'est
 * exactement ce que le dépôt s'interdit (« avant d'écrire un helper, regarder s'il existe déjà »).
 *
 * ⚠️ AUCUN COMPORTEMENT N'A CHANGÉ à l'extraction, et la preuve est que les tests de l'Embedded Signup
 * passent SANS avoir été touchés. Si l'un d'eux avait dû changer, l'extraction aurait changé un
 * comportement du chemin d'inscription, qui est le plus structurant du produit.
 */
/**
 * L'ÉCHEC D'UN APPEL GRAPH, AVEC SON STATUT ET SON CODE, pas seulement sa phrase.
 *
 * 🔴 LE MESSAGE NE CHANGE PAS D'UN CARACTÈRE : c'est une sous-classe d'`Error`, pas un format neuf. Ce
 * qu'elle ajoute, c'est de quoi DISTINGUER un jeton refusé (401, ou code 190) d'une panne passagère, sans
 * relire la phrase à l'expression régulière. Un message se traduit, se reformule et casse en silence ; un
 * code est un contrat.
 */
export class ErreurGraph extends Error {
  constructor(readonly status: number, readonly code: number | null, message: string) {
    super(message);
    this.name = 'ErreurGraph';
  }
}

/** Meta a refusé NOTRE ACCÈS (jeton expiré, révoqué, permissions retirées), par opposition à une panne. */
export function estJetonRefuse(err: unknown): boolean {
  return err instanceof ErreurGraph && (err.status === 401 || err.code === 190 || err.code === 102 || err.code === 10);
}

export abstract class ClientGraph {
  constructor(
    protected readonly appId: string,
    protected readonly appSecret: string,
    protected readonly version: string,
    protected readonly baseUrl = 'https://graph.facebook.com',
  ) {}

  protected async call(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
    const res = await fetch(url, init);
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
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
   * Échange le code rendu par la fenêtre Meta (TTL 30 s) contre le jeton du client.
   *
   * ⚠️ MÊME APPEL pour l'inscription WhatsApp et pour les publicités : ce qui change entre les deux n'est
   * pas l'échange, c'est la CONFIGURATION qui a ouvert la fenêtre, donc les permissions et le type du jeton
   * rendu. Le code, lui, s'échange de la même façon.
   */
  async exchangeCode(code: string): Promise<string> {
    const qs = new URLSearchParams({ client_id: this.appId, client_secret: this.appSecret, code });
    const body = await this.call(`${this.baseUrl}/${this.version}/oauth/access_token?${qs.toString()}`);
    const token = body['access_token'];
    if (typeof token !== 'string' || token === '') throw new Error("échange du code : pas d'access_token dans la réponse");
    return token;
  }

  /**
   * Les actifs qu'un jeton accorde, lus DANS LE JETON (`GET /debug_token` -> `granular_scopes[].target_ids`),
   * pour les scopes demandés.
   *
   * ⚠️ DEUX tokens, et ils ne jouent pas le même rôle. `input_token` est le token INSPECTÉ (celui du client) ;
   * l'autorisation, elle, doit être un TOKEN D'APPLICATION (`{app_id}|{app_secret}`). S'authentifier avec le
   * token du client rend « (#100) You must provide an app access token, or a user access token that is an
   * owner or developer of the app » (mesuré le 2026-08-17). Le token d'app ne quitte jamais le serveur.
   *
   * Rend [] si le token n'expose aucune cible pour ces scopes, et ce n'est pas une erreur : un token NON
   * scopé (System User de notre propre business, mesuré le 2026-08-17) rend `target_ids: null`. L'appelant
   * décide quoi en dire.
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
