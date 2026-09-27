/**
 * Lecture HTTP minimale, injectable. Interface à part de `HttpTransport` (`src/meta/http.ts`, du POST vers
 * Meta) : ses consommateurs n'ont besoin que d'un GET, et l'injecter les rend testables sans réseau.
 */
export interface HttpGet {
  get(url: string, headers: Record<string, string>, opts?: { signal?: AbortSignal }): Promise<{ status: number; json: unknown }>;
}

/**
 * GET réel. Un corps non-JSON donne `null`, jamais une exception : c'est le status qui décide.
 * Aucune échéance par défaut : l'appelant qui sert une requête d'utilisateur passe un `signal`
 * (`AbortSignal.timeout`), sinon un fournisseur qui pend immobilise sa route.
 */
export const fetchGet: HttpGet = {
  async get(url, headers, opts) {
    const res = await fetch(url, { headers, ...(opts?.signal ? { signal: opts.signal } : {}) });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json };
  },
};
