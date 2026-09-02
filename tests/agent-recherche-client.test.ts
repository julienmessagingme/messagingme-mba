import { describe, it, expect } from 'vitest';
import { GatewayRechercheClient } from '../src/agent/llm/recherche-client';

/**
 * LES DEUX APPELS DE LA RECHERCHE DE CONNAISSANCE (chantier vectorisation, 2026-09-02).
 *
 * 🔴 Pourquoi deux modeles et pas un, et c'est la mesure qui l'a impose : un embedding est un bi-encodeur, son
 * cosinus dit « ces deux textes se ressemblent » et pas « cette fiche repond a cette question ». Une question
 * hors sujet remonte a 0,361 quand une vraie question descend a 0,299 : aucun seuil n'est posable dessus. Le
 * reranker, lui, est un cross-encodeur et rend un score calibre. L'embedding sert au RAPPEL, le reranker au
 * VERDICT.
 */

/** Un faux `fetch` qui rend les reponses dans l'ordre, et retient ce qu'on lui a demande. */
function fauxFetch(reponses: Array<{ status: number; json: unknown }>) {
  const appels: Array<{ url: string; corps: Record<string, unknown> }> = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    appels.push({ url: String(url), corps: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    const r = reponses.shift() ?? reponses[reponses.length - 1] ?? { status: 200, json: {} };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.json } as unknown as Response;
  }) as unknown as typeof fetch;
  return { f, appels };
}

const client = (reponses: Array<{ status: number; json: unknown }>) => {
  const { f, appels } = fauxFetch(reponses);
  return { c: new GatewayRechercheClient('cle', 'emb', 'rerank', f), appels };
};

describe('vectoriser', () => {
  it('🔴 REMET LES VECTEURS DANS L’ORDRE par index, sans faire confiance au tableau', async () => {
    // Le piege qui ne se verrait jamais : un fournisseur qui renvoie les vecteurs dans le desordre ferait
    // ecrire a chaque fiche le vecteur d'une AUTRE. La recherche deviendrait absurde et rien ne le signalerait.
    const { c } = client([{ status: 200, json: { data: [
      { index: 2, embedding: [3] }, { index: 0, embedding: [1] }, { index: 1, embedding: [2] },
    ] } }]);
    expect(await c.vectoriser(['a', 'b', 'c'])).toEqual([[1], [2], [3]]);
  });

  it('🔴 un vecteur MANQUANT leve, il ne passe pas en silence', async () => {
    // Ecrire `null` dans la colonne serait pire que ne rien ecrire : la fiche paraitrait vectorisee.
    const { c } = client([{ status: 200, json: { data: [{ index: 0, embedding: [1] }] } }]);
    await expect(c.vectoriser(['a', 'b'])).rejects.toThrow(/vecteur manquant/);
  });

  it('aucun texte -> AUCUN appel reseau', async () => {
    const { c, appels } = client([]);
    expect(await c.vectoriser([])).toEqual([]);
    expect(appels).toHaveLength(0);
  });

  it('vectorise en UN SEUL appel, pas un par texte', async () => {
    // 200 fiches une par une feraient 200 allers-retours la ou un seul suffit.
    const { c, appels } = client([{ status: 200, json: { data: [0, 1, 2].map((i) => ({ index: i, embedding: [i] })) } }]);
    await c.vectoriser(['a', 'b', 'c']);
    expect(appels).toHaveLength(1);
    expect(appels[0]!.corps.input).toEqual(['a', 'b', 'c']);
  });
});

describe('reclasser', () => {
  it('rend les scores DANS L’ORDRE DES FICHES, pas dans celui du classement', async () => {
    // C'est l'appelant qui trie, parce que c'est lui qui sait ce qu'il fait des scores.
    const { c } = client([{ status: 200, json: { results: [
      { index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.1 },
    ] } }]);
    expect(await c.reclasser('q', [{ texte: 'a' }, { texte: 'b' }])).toEqual([0.1, 0.9]);
  });

  it('🔴 une fiche NON NOTEE vaut zero, elle ne passe pas le seuil par accident', async () => {
    const { c } = client([{ status: 200, json: { results: [{ index: 0, relevance_score: 0.5 }] } }]);
    expect(await c.reclasser('q', [{ texte: 'a' }, { texte: 'b' }])).toEqual([0.5, 0]);
  });

  it('aucune fiche -> AUCUN appel reseau', async () => {
    const { c, appels } = client([]);
    expect(await c.reclasser('q', [])).toEqual([]);
    expect(appels).toHaveLength(0);
  });
});

describe('rejeux', () => {
  it('🔴 un 429 est REJOUE, puis reussit', async () => {
    // ⚠️ `withRetry` marche par OPT-IN (`retryable: true`). Une premiere version posait un drapeau `terminal`
    // en croyant exclure le rejeu des 4xx : elle l'empechait PARTOUT, y compris ici, avec un commentaire qui
    // affirmait le contraire. Ce test est la garde de ce sens-la.
    const { c, appels } = client([
      { status: 429, json: { error: { message: 'trop vite' } } },
      { status: 200, json: { results: [{ index: 0, relevance_score: 0.7 }] } },
    ]);
    expect(await c.reclasser('q', [{ texte: 'a' }])).toEqual([0.7]);
    expect(appels.length).toBeGreaterThan(1);
  });

  it('🔴 un 400 est TERMINAL : un seul appel', async () => {
    // Un modele inconnu ou une cle invalide ne devient pas valide en reessayant : on paierait trois fois la
    // meme erreur de configuration.
    const { c, appels } = client([{ status: 400, json: { error: { message: 'modele inconnu' } } }]);
    await expect(c.vectoriser(['a'])).rejects.toThrow(/400/);
    expect(appels).toHaveLength(1);
  });

  it('un 503 est rejoue lui aussi', async () => {
    const { c, appels } = client([
      { status: 503, json: {} },
      { status: 200, json: { data: [{ index: 0, embedding: [1] }] } },
    ]);
    expect(await c.vectoriser(['a'])).toEqual([[1]]);
    expect(appels.length).toBeGreaterThan(1);
  });
});
