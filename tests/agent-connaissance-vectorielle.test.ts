import { describe, it, expect, vi } from 'vitest';
import { chercherConnaissance, type RechercheSemantique } from '../src/agent/resolvers/connaissance';
import type { FicheTrouvee, KnowledgeStore } from '../src/agent/knowledge';

/**
 * LA RECHERCHE DE CONNAISSANCE VECTORIELLE (chantier du 2026-09-02, migration 0110).
 *
 * 🔴 CE QUE CE FICHIER GARDE, ET C'EST DEUX CHOSES OPPOSÉES. Le GAIN : une question posée avec les mots du
 * client doit retrouver la fiche écrite avec les mots de l'entreprise, alors qu'ils n'ont aucun mot en commun.
 * Et la GARDE : une question hors sujet doit toujours sortir par « aucune source », sans quoi on aurait
 * échangé une hallucination contre un rappel.
 *
 * ⚠️ La mesure du 2026-09-02 a montré qu'aucun seuil n'est posable sur une similarité d'embedding (une
 * question hors sujet remonte à 0,361 quand une vraie question descend à 0,299). C'est le RERANKER qui juge,
 * et ces tests le prennent au mot.
 */

const CTX = { tenantId: 't1', agentId: 'a1' };

/**
 * Une fiche que le PLEIN TEXTE trouve : elle partage des mots avec la question.
 *
 * ⚠️ `couverture` est un paramètre A PART, et pas déduit de `termes` : la règle d'origine a TROIS motifs
 * indépendants, et une fiche à un seul terme commun mais couvrant toute une question courte est acceptée par
 * le deuxième. Une première version de ce fichier les confondait et croyait tester le rejet.
 */
const lexicale = (id: string, termes = 3, couverture = 1): FicheTrouvee => ({
  id, titre: `titre-${id}`, corps: `corps de ${id}`, sourceUrl: null,
  termesTrouves: termes, couverture, proximiteTitre: 0,
});

/** Une fiche que SEUL le vectoriel trouve : aucun mot commun, donc aucune mesure lexicale. */
const semantique = (id: string, similarite = 0.4): FicheTrouvee => ({
  id, titre: `titre-${id}`, corps: `corps de ${id}`, sourceUrl: null,
  termesTrouves: 0, couverture: 0, proximiteTitre: 0, similarite,
});

function store(lex: FicheTrouvee[], vec: FicheTrouvee[] | 'absent' = []): KnowledgeStore {
  const s: KnowledgeStore = { chercher: async () => lex };
  if (vec !== 'absent') s.chercherParVecteur = async () => vec;
  return s;
}

function recherche(scores: number[], over: Partial<RechercheSemantique> = {}): RechercheSemantique {
  return {
    vectoriser: async () => [[0.1, 0.2]],
    reclasser: async () => scores,
    candidats: 12,
    seuil: 0.06,
    ...over,
  };
}

const titres = (r: Awaited<ReturnType<typeof chercherConnaissance>>): string[] =>
  'sources' in r.contenu ? r.contenu.sources.map((s) => s.titre) : [];

describe('sans recherche sémantique câblée : le comportement d’AVANT, à l’identique', () => {
  it('la règle lexicale tranche, et elle seule', async () => {
    const r = await chercherConnaissance(store([lexicale('a')]), CTX, 'une question');
    expect(titres(r)).toEqual(['titre-a']);
  });

  it('aucune fiche pertinente -> aucune_source, avec sa sortie', async () => {
    const r = await chercherConnaissance(store([]), CTX, 'une question');
    expect(r.contenu).toEqual({ aucune_source: true });
    expect('sortie' in r).toBe(true);
  });

  it('une fiche qui ne partage QU’UN mot est écartée', async () => {
    // La règle d'origine : deux mots communs au moins. Elle ne doit pas s'affaiblir en chemin.
    const r = await chercherConnaissance(store([lexicale('a', 1, 0.2)]), CTX, 'une question');
    expect(r.contenu).toEqual({ aucune_source: true });
  });
});

describe('🔴 LE GAIN : une fiche sans aucun mot commun est enfin trouvée', () => {
  it('trouvée par le seul vectoriel, jugée pertinente par le reranker -> rendue', async () => {
    // C'est LE cas de Julien : « c'est combien pour résilier » contre « Conditions de sortie de contrat ».
    // Avant ce chantier, cette fiche n'était même pas candidate, et l'agent répondait « je ne sais pas ».
    const r = await chercherConnaissance(store([], [semantique('sortie')]), CTX, 'question', recherche([0.2]));
    expect(titres(r)).toEqual(['titre-sortie']);
  });

  it('le reranker RÉORDONNE : la meilleure passe devant, même trouvée en dernier', async () => {
    const r = await chercherConnaissance(
      store([lexicale('a')], [semantique('b')]), CTX, 'question', recherche([0.1, 0.9]),
    );
    expect(titres(r)).toEqual(['titre-b', 'titre-a']);
  });

  it('au plus TROIS fiches, quel que soit le nombre de candidats', async () => {
    // La borne du contexte envoyé au modèle ne bouge pas d'un octet : ce qui change, c'est QUELLES fiches.
    const cinq = [lexicale('a'), lexicale('b'), lexicale('c'), lexicale('d'), lexicale('e')];
    const r = await chercherConnaissance(store(cinq), CTX, 'question', recherche([0.9, 0.8, 0.7, 0.6, 0.5]));
    expect(titres(r)).toHaveLength(3);
  });
});

describe('🔴 LA GARDE : le hors-sujet sort toujours par aucune_source', () => {
  it('des candidats remontent, le reranker les note SOUS le seuil -> aucune source', async () => {
    // Le vectoriel rend TOUJOURS un classement : il y a toujours une fiche « la moins loin ». Sans le
    // verdict du reranker, cette fiche serait servie au modèle, et l'agent répondrait sur les vélos avec une
    // fiche d'assurance. C'est le test le plus important du fichier.
    const r = await chercherConnaissance(
      store([], [semantique('assurance', 0.361)]), CTX, 'vous vendez des velos ?', recherche([0.04]),
    );
    expect(r.contenu).toEqual({ aucune_source: true });
  });

  it('une similarité ÉLEVÉE ne suffit jamais : seul le score du reranker décide', async () => {
    // Mesuré : une question hors sujet monte à 0,361 quand une vraie question descend à 0,299. Faire décider
    // la similarité aurait fait sauter la garde.
    const r = await chercherConnaissance(
      store([], [semantique('x', 0.99)]), CTX, 'question', recherche([0.01]),
    );
    expect(r.contenu).toEqual({ aucune_source: true });
  });

  it('la borne du seuil est INCLUSIVE, et testée des deux côtés', async () => {
    const pile = await chercherConnaissance(store([], [semantique('x')]), CTX, 'q', recherche([0.06]));
    const dessous = await chercherConnaissance(store([], [semantique('x')]), CTX, 'q', recherche([0.059]));
    expect(titres(pile)).toEqual(['titre-x']);
    expect(dessous.contenu).toEqual({ aucune_source: true });
  });
});

describe('🔴 les replis : on perd le gain, jamais la garde', () => {
  it('le VECTORISEUR tombe -> plein texte seul, règle lexicale, ça marche encore', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await chercherConnaissance(
      store([lexicale('a')], [semantique('b')]), CTX, 'question',
      recherche([0.9], { vectoriser: async () => { throw new Error('gateway KO'); } }),
    );
    spy.mockRestore();
    // La fiche lexicale est là ; celle que seul le vectoriel connaissait ne l'est pas, et c'est correct.
    expect(titres(r)).toEqual(['titre-a']);
  });

  it('🔴 le RERANKER tombe -> on retombe sur la règle lexicale, PAS sur « on laisse passer »', async () => {
    // Le repli dangereux serait de servir les candidats non jugés. Une fiche venue du seul rappel vectoriel a
    // une couverture de zéro : elle est donc écartée par ce repli. On dégrade vers le comportement d'avant.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await chercherConnaissance(
      store([lexicale('a')], [semantique('b')]), CTX, 'question',
      recherche([], { reclasser: async () => { throw new Error('rerank KO'); } }),
    );
    spy.mockRestore();
    expect(titres(r)).toEqual(['titre-a']);
  });

  it('un store SANS recherche vectorielle (base pas encore migrée) garde le comportement d’avant', async () => {
    const r = await chercherConnaissance(store([lexicale('a')], 'absent'), CTX, 'question', recherche([0.9]));
    expect(titres(r)).toEqual(['titre-a']);
  });
});

describe('la fusion des deux rappels', () => {
  it('une fiche trouvée par les DEUX chemins n’apparaît qu’une fois', async () => {
    // La présenter deux fois au reranker la ferait payer double et pourrait occuper deux des trois places.
    const meme = { ...lexicale('a'), similarite: 0.5 };
    const r = await chercherConnaissance(
      store([lexicale('a')], [meme]), CTX, 'question', recherche([0.9, 0.9]),
    );
    expect(titres(r)).toEqual(['titre-a']);
  });

  it('et elle garde la MEILLEURE mesure de chaque famille', async () => {
    // Sans ça, l'ordre d'arrivée déciderait : la version vectorielle (couverture 0) écraserait la lexicale,
    // et le repli sur la règle lexicale rejetterait une fiche que le plein texte avait pourtant trouvée.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await chercherConnaissance(
      store([lexicale('a')], [semantique('a')]), CTX, 'question',
      recherche([], { reclasser: async () => { throw new Error('KO'); } }),
    );
    spy.mockRestore();
    expect(titres(r)).toEqual(['titre-a']);
  });
});
