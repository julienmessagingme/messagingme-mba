import { withRetry } from '../../meta/http';

/**
 * LES DEUX APPELS DE LA RECHERCHE DE CONNAISSANCE : vectoriser, et reclasser.
 *
 * 🔴 POURQUOI DEUX MODELES ET PAS UN, et c'est la mesure qui l'a impose (2026-09-02).
 *
 * Un EMBEDDING est un bi-encodeur : il encode la question et la fiche SEPAREMENT, puis on compare les deux
 * vecteurs. Son cosinus repond a « ces deux textes se ressemblent-ils », qui n'est PAS la question posee,
 * « cette fiche repond-elle a cette question ». Mesure a l'appui : une question hors sujet (« vous vendez des
 * velos electriques ? ») remonte une fiche d'assurance a 0,361, soit PLUS HAUT qu'une vraie question dont la
 * bonne reponse est a 0,299. Aucun seuil n'est donc posable sur un cosinus, et en ecrire un aurait fait sauter
 * la garde anti-hallucination, qui est la propriete la plus importante du produit.
 *
 * Un RERANKER est un cross-encodeur : il lit la question ET la fiche ensemble et rend un score CALIBRE. Sur le
 * meme corpus, il place les vraies questions au-dessus de 0,0817 et le hors-sujet en dessous de 0,0409 : un
 * seuil est enfin posable.
 *
 * D'ou la division du travail, et chaque etage fait ce qu'il sait faire : l'embedding sert au RAPPEL (ne rien
 * manquer), le reranker sert au VERDICT (ne rien laisser passer). Detail :
 * `docs/MESURE-RECHERCHE-CONNAISSANCE-2026-09-02.md`.
 */

const URL_EMBEDDINGS = 'https://ai-gateway.vercel.sh/v1/embeddings';
const URL_RERANK = 'https://ai-gateway.vercel.sh/v1/rerank';

/**
 * Bornes des tentatives, VOLONTAIREMENT plus serrees que le defaut de `withRetry` (4 rejeux, 30 s de
 * plafond), et pour la meme raison que le client de chat : ces deux appels sont DANS le budget de 30 secondes
 * d'un tour d'agent. Un seul rejeu long le consommerait en entier, et le contact attendrait pour rien.
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

  /**
   * Vectorise un ou plusieurs textes EN UN SEUL appel. Le lot compte : vectoriser 200 fiches une par une
   * ferait 200 allers-retours la ou un seul suffit.
   */
  async vectoriser(textes: string[]): Promise<number[][]> {
    if (textes.length === 0) return [];
    const corps = await this.appeler<ReponseEmbeddings>(URL_EMBEDDINGS, { model: this.modeleEmbedding, input: textes });
    /**
     * 🔴 On REMET DANS L'ORDRE par `index`, on ne fait pas confiance a l'ordre du tableau. Un fournisseur qui
     * renverrait les vecteurs dans le desordre ferait ecrire a chaque fiche le vecteur d'une AUTRE, et rien
     * ne le signalerait : la recherche deviendrait absurde sans qu'aucune erreur ne remonte.
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
   * Note la pertinence de chaque fiche pour CETTE question. Rend un score par fiche, dans l'ordre donne.
   *
   * ⚠️ L'ordre du tableau rendu suit celui des documents fournis, pas celui du classement : c'est l'appelant
   * qui trie, parce que c'est lui qui sait ce qu'il fait des scores.
   */
  async reclasser(question: string, fiches: FicheAReclasser[]): Promise<number[]> {
    if (fiches.length === 0) return [];
    const corps = await this.appeler<ReponseRerank>(URL_RERANK, {
      model: this.modeleRerank,
      query: question,
      documents: fiches.map((f) => f.texte),
      top_n: fiches.length,
    });
    // Zero par defaut : une fiche que le reranker ne note pas ne doit PAS passer le seuil par accident.
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
         * ⚠️ `withRetry` marche par OPT-IN : il ne rejoue que ce qui porte `retryable === true` (plus les
         * codes reseau). Une premiere version posait un drapeau `terminal` sur les 4xx en croyant exclure le
         * rejeu : elle n'excluait rien, elle l'empechait PARTOUT, y compris sur un 429 ou un 503, et le
         * commentaire d'a cote affirmait le contraire. Le sens du drapeau se lit dans `isRetryable`, il ne
         * se devine pas.
         *
         * Un 4xx de configuration (modele inconnu, cle invalide) reste donc TERMINAL, ce qui est voulu :
         * le rejouer paierait trois fois la meme erreur.
         */
        if (res.status === 408 || res.status === 429 || res.status >= 500) Object.assign(err, { retryable: true });
        throw err;
      }
      if (!json) throw new Error('reponse illisible');
      return json;
    }, TENTATIVES);
  }
}
