/**
 * Lecture HTTP minimale, injectable.
 *
 * Interface DÉCLARÉE À PART plutôt qu'un élargissement de `HttpTransport` (`src/meta/http.ts`), qui ne fait
 * que du POST et sert les appels Meta : ses consommateurs n'ont besoin que d'un GET, et l'injecter les rend
 * testables sans réseau.
 *
 * ⚠️ Elle vivait dans `src/rcs/channel-info.ts`, où elle était née. Le deuxième consommateur (le catalogue de
 * modèles du Gateway, 2026-09-09) l'a fait remonter ici : la recopier aurait donné deux GET qui gèrent
 * différemment un corps non-JSON, et le dépôt a déjà payé une centaine de ces copies (audit du 2026-08-18).
 */
export interface HttpGet {
  get(url: string, headers: Record<string, string>, opts?: { signal?: AbortSignal }): Promise<{ status: number; json: unknown }>;
}

/**
 * GET réel. Un corps non-JSON donne `null`, jamais une exception : c'est le status qui décide.
 *
 * ⚠️ Aucune échéance par défaut, et c'est délibéré : l'appelant sait ce qu'il peut attendre. Celui qui sert
 * une requête d'un utilisateur doit passer un `signal` (`AbortSignal.timeout`), sinon un fournisseur qui pend
 * immobilise sa route. Le vérificateur de clé RCS, lui, n'en passait pas avant ce déplacement et n'en passe
 * pas plus : élargir une garde au passage aurait changé le comportement d'un chemin qu'on ne touchait pas.
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
