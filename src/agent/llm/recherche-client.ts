import { withRetry } from '../../meta/http';

/**
 * Les deux appels de la recherche de connaissance : vectoriser, et reclasser.
 *
 * Deux modèles, parce qu'un embedding (bi-encodeur) mesure si deux textes se ressemblent, pas si la fiche
 * répond : une question hors sujet peut y dépasser une vraie question, donc aucun seuil n'y est posable, et
 * la garde anti-hallucination sauterait. Le reranker (cross-encodeur) lit question et fiche ensemble et rend
 * un score calibré. L'embedding sert au rappel, le reranker au verdict
 * (`docs/MESURE-RECHERCHE-CONNAISSANCE-2026-09-02.md`).
 */

const URL_EMBEDDINGS = 'https://ai-gateway.vercel.sh/v1/embeddings';
const URL_RERANK = 'https://ai-gateway.vercel.sh/v1/rerank';

/**
 * Tentatives plus serrées que le défaut de `withRetry` : ces appels sont dans le budget de 30 s d'un tour
 * d'agent, qu'un seul rejeu long consommerait en entier.
 */
const TENTATIVES = { maxRetries: 2, baseDelayMs: 200, maxDelayMs: 1500 } as const;

export interface FicheAReclasser {
  /** Ce que le reranker lit. Titre et corps ensemble : un titre seul ne dit pas si la fiche repond. */
  texte: string;
}

interface ReponseEmbeddings {
  data?: Array<{ embedding?: number[]; index?: number }>;
  error?: { message?: string };
}

interface ReponseRerank {
  results?: Array<{ index?: number; relevance_score?: number }>;
  error?: { message?: string };
}

export class GatewayRechercheClient {
  constructor(
    private readonly cle: string,
    private readonly modeleEmbedding: string,
    private readonly modeleRerank: string,
    private readonly fetch_: typeof fetch = fetch,
  ) {}

  /** Vectorise un ou plusieurs textes en un seul appel, plutôt qu'un aller-retour par fiche. */
  async vectoriser(textes: string[]): Promise<number[][]> {
    if (textes.length === 0) return [];
    const corps = await this.appeler<ReponseEmbeddings>(URL_EMBEDDINGS, { model: this.modeleEmbedding, input: textes });
    /**
     * Remis dans l'ordre par `index`, sans confiance dans l'ordre du tableau : sinon chaque fiche pourrait
     * recevoir le vecteur d'une autre, sans aucune erreur.
     */
    const vecteurs = new Array<number[] | undefined>(textes.length);
    for (const d of corps.data ?? []) {
      const i = typeof d.index === 'number' ? d.index : (corps.data ?? []).indexOf(d);
      if (i >= 0 && i < textes.length) vecteurs[i] = d.embedding;
    }
    const manquant = vecteurs.findIndex((v) => v === undefined || v.length === 0);
    if (manquant !== -1) throw new Error(`vecteur manquant pour l'entree ${manquant} (${vecteurs.length} attendus)`);
    return vecteurs as number[][];
  }

  /**
   * Note la pertinence de chaque fiche pour cette question. Rend un score par fiche, dans l'ordre des fiches
   * fournies (pas celui du classement) : c'est l'appelant qui trie.
   */
  async reclasser(question: string, fiches: FicheAReclasser[]): Promise<number[]> {
    if (fiches.length === 0) return [];
    const corps = await this.appeler<ReponseRerank>(URL_RERANK, {
      model: this.modeleRerank,
      query: question,
      documents: fiches.map((f) => f.texte),
      top_n: fiches.length,
    });
    // Zéro par défaut : une fiche que le reranker ne note pas ne doit pas passer le seuil par accident.
    const scores = new Array<number>(fiches.length).fill(0);
    for (const r of corps.results ?? []) {
      if (typeof r.index === 'number' && r.index >= 0 && r.index < fiches.length) {
        scores[r.index] = Number(r.relevance_score ?? 0);
      }
    }
    return scores;
  }

  private async appeler<T extends { error?: { message?: string } }>(url: string, corps: unknown): Promise<T> {
    return withRetry(async () => {
      const res = await this.fetch_(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.cle}` },
        body: JSON.stringify(corps),
      });
      const json = (await res.json().catch(() => null)) as T | null;
      if (!res.ok) {
        const message = json?.error?.message ?? `HTTP ${res.status}`;
        const err = new Error(`${res.status} ${message}`.trim());
        /**
         * `withRetry` ne rejoue que ce qui porte `retryable === true` (plus les codes réseau) : 408, 429 et 5xx le
         * portent. Un 4xx de configuration (modèle inconnu, clé invalide) reste terminal, le rejouer paierait trois
         * fois la même erreur.
         */
        if (res.status === 408 || res.status === 429 || res.status >= 500) Object.assign(err, { retryable: true });
        throw err;
      }
      if (!json) throw new Error('reponse illisible');
      return json;
    }, TENTATIVES);
  }
}
