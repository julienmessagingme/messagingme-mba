import { describe, it, expect, vi } from 'vitest';
import { creerRepondeur, OUTIL_REPONDRE, type DepsAide } from '../src/aide/repondre';
import type { FicheAide } from '../src/aide/fiches';

/**
 * LE MOTEUR DE L'AIDE.
 *
 * 🔴 DEUX CHOSES COMPTENT, ET AUCUNE N'EST « il répond bien ». Quand aucune fiche n'est pertinente, il DIT
 * qu'il ne sait pas SANS appeler le modèle : appeler sans source, c'est demander d'inventer, et ça coûte
 * pour un résultat qu'on refuserait. Et une clé d'écran qu'il n'aurait pas dû rendre ne produit AUCUN lien.
 * Le reste est de la formulation, qui n'est pas testable et n'a pas à l'être.
 */
const fiche = (over: Partial<FicheAide> = {}): FicheAide => ({
  id: '1', cle: 'lancer-une-campagne', titre: 'Lancer une campagne',
  corps: 'Ouvrez Campagnes, choisissez votre modèle, puis votre audience.',
  ecran: 'campagnes', termesTrouves: 3, couverture: 0.8, proximiteTitre: 0.5, ...over,
});

const repondu = (reponse: string, ecrans?: string[]) => ({
  texte: null,
  appelsOutils: [{ id: 'a1', nom: OUTIL_REPONDRE, argumentsJson: JSON.stringify({ reponse, ...(ecrans ? { ecrans } : {}) }) }],
  finish: 'tool_calls',
  usage: { tokensIn: 0, tokensOut: 0 },
});

function deps(over: Partial<DepsAide> = {}): DepsAide {
  return {
    depot: { chercher: async () => [fiche()] },
    recherche: null,
    completer: async () => repondu('Ouvrez Campagnes.', ['campagnes']) as never,
    modele: 'test/modele',
    ...over,
  };
}

const question = { question: 'comment lancer une campagne', role: 'admin', langue: 'fr' as const, ecranCourant: null };

describe('répondeur d’aide', () => {
  it('🔴 aucune fiche pertinente : il ne sait pas, et il n’appelle même pas le modèle', async () => {
    const completer = vi.fn();
    const r = await creerRepondeur(deps({ depot: { chercher: async () => [] }, completer }))(question);
    expect(r).toEqual({ sait: false, texte: '', sources: [], ecrans: [] });
    expect(completer).not.toHaveBeenCalled();
  });

  it('🔴 une fiche remontée mais NON pertinente ne suffit pas', async () => {
    // Le rappel lexical remonte sur UN seul mot commun. Sans la règle de pertinence, cette fiche partirait
    // au modèle et il répondrait à côté avec aplomb.
    const completer = vi.fn();
    const maigre = fiche({ termesTrouves: 0, couverture: 0, proximiteTitre: 0 });
    const r = await creerRepondeur(deps({ depot: { chercher: async () => [maigre] }, completer }))(question);
    expect(r.sait).toBe(false);
    expect(completer).not.toHaveBeenCalled();
  });

  it('une fiche pertinente : réponse, source citée, et le lien vers l’écran', async () => {
    const r = await creerRepondeur(deps())(question);
    expect(r.sait).toBe(true);
    expect(r.texte).toBe('Ouvrez Campagnes.');
    expect(r.sources).toEqual(['Lancer une campagne']);
    expect(r.ecrans.map((e) => e.cle)).toEqual(['campagnes']);
    expect(r.ecrans[0]?.href).toBe('/campaigns');
  });

  it('🔴 une clé d’écran INVENTÉE par le modèle ne produit aucun lien', async () => {
    const r = await creerRepondeur(deps({
      completer: async () => repondu('Allez-y.', ['ecran-imaginaire']) as never,
    }))(question);
    // Et le texte part quand même : une réponse sans lien vaut mieux que pas de réponse.
    expect(r.texte).toBe('Allez-y.');
    expect(r.ecrans).toEqual([]);
  });

  it('🔴 un AGENT ne reçoit aucun lien vers un écran d’administrateur', async () => {
    const r = await creerRepondeur(deps({
      completer: async () => repondu('Voyez ici.', ['campagnes']) as never,
    }))({ ...question, role: 'agent' });
    expect(r.ecrans).toEqual([]);
  });

  it('🔴 les fiches arrivent dans un message À PART, jamais dans la consigne', async () => {
    // Règle du CLAUDE.md global. Le contenu vient de notre dépôt aujourd'hui, donc le risque est faible ;
    // la forme doit être juste dès maintenant parce que la seconde moitié du programme fera passer par ce
    // même moteur des textes écrits par des inconnus.
    const completer = vi.fn().mockResolvedValue(repondu('ok'));
    await creerRepondeur(deps({ completer }))(question);
    const { messages } = completer.mock.calls[0]![0] as { messages: Array<{ role: string; content: string }> };
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).not.toContain('Ouvrez Campagnes, choisissez');
    expect(messages[1]!.content).toContain('FICHE 1');
  });

  it('⚠️ la consigne ne montre à un AGENT que les écrans qu’il peut atteindre', async () => {
    const completer = vi.fn().mockResolvedValue(repondu('ok'));
    await creerRepondeur(deps({ completer }))({ ...question, role: 'agent' });
    const { messages } = completer.mock.calls[0]![0] as { messages: Array<{ content: string }> };
    expect(messages[0]!.content).toContain('- inbox :');
    expect(messages[0]!.content).not.toContain('- campagnes :');
  });

  it('⚠️ l’écran courant est transmis, c’est ce qui rend l’aide contextuelle', async () => {
    const completer = vi.fn().mockResolvedValue(repondu('ok'));
    await creerRepondeur(deps({ completer }))({ ...question, ecranCourant: 'workflows' });
    const { messages } = completer.mock.calls[0]![0] as { messages: Array<{ content: string }> };
    expect(messages[0]!.content).toContain('workflows');
  });

  it('⚠️ une question VIDE ne cherche rien et n’appelle personne', async () => {
    const chercher = vi.fn();
    const completer = vi.fn();
    const r = await creerRepondeur(deps({ depot: { chercher }, completer }))({ ...question, question: '   ' });
    expect(r.sait).toBe(false);
    expect(chercher).not.toHaveBeenCalled();
    expect(completer).not.toHaveBeenCalled();
  });

  it('🔴 une PANNE du modèle rend « je ne sais pas », jamais une erreur', async () => {
    // La personne se voit alors proposer le recours humain, qui est une issue. Un message d'erreur n'en est
    // pas une.
    const r = await creerRepondeur(deps({ completer: async () => { throw new Error('gateway 503'); } }))(question);
    expect(r.sait).toBe(false);
  });

  it('🔴 une sortie de modèle ILLISIBLE rend « je ne sais pas »', async () => {
    const r = await creerRepondeur(deps({
      completer: async () => ({ texte: null, appelsOutils: [{ id: 'a', nom: OUTIL_REPONDRE, argumentsJson: '{pas du json' }], finish: 'tool_calls', usage: { tokensIn: 0, tokensOut: 0 } }) as never,
    }))(question);
    expect(r.sait).toBe(false);
  });

  it('🔴 une réponse VIDE rend « je ne sais pas » plutôt qu’une bulle blanche', async () => {
    const r = await creerRepondeur(deps({ completer: async () => repondu('   ') as never }))(question);
    expect(r.sait).toBe(false);
  });

  it('⚠️ au plus TROIS fiches partent au modèle', async () => {
    // Au-delà, la réponse se dilue et le prompt grossit sans rien apporter.
    const completer = vi.fn().mockResolvedValue(repondu('ok'));
    const beaucoup = Array.from({ length: 8 }, (_, i) => fiche({ id: `f${i}`, titre: `Fiche ${i}` }));
    await creerRepondeur(deps({ depot: { chercher: async () => beaucoup }, completer }))(question);
    const { messages } = completer.mock.calls[0]![0] as { messages: Array<{ content: string }> };
    expect(messages[1]!.content).toContain('FICHE 3');
    expect(messages[1]!.content).not.toContain('FICHE 4');
  });
});

describe('répondeur d’aide : avec la recherche sémantique', () => {
  const recherche = {
    vectoriser: async () => [[1, 0, 0]],
    reclasser: async (_q: string, f: Array<{ texte: string }>) => f.map(() => 0.5),
    candidats: 12,
    seuil: 0.06,
  };

  it('le rappel VECTORIEL complète le lexical, sans doublon', async () => {
    const completer = vi.fn().mockResolvedValue(repondu('ok'));
    const depot = {
      chercher: async () => [fiche({ id: 'a', titre: 'A' })],
      chercherParVecteur: async () => [fiche({ id: 'a', titre: 'A', similarite: 0.9 }), fiche({ id: 'b', titre: 'B' })],
    };
    await creerRepondeur(deps({ depot, recherche, completer }))(question);
    const { messages } = completer.mock.calls[0]![0] as { messages: Array<{ content: string }> };
    expect(messages[1]!.content).toContain('TITRE : A');
    expect(messages[1]!.content).toContain('TITRE : B');
    expect(messages[1]!.content.match(/TITRE : A/g)).toHaveLength(1);
  });

  it('🔴 le RECLASSEMENT tranche : sous le seuil, rien ne part', async () => {
    // C'est lui qui porte la garde une fois le vectoriel branché, parce qu'aucun seuil n'est posable sur un
    // cosinus d'embedding (mesuré : une question hors sujet y monte plus haut qu'une vraie question).
    const completer = vi.fn();
    const sousLeSeuil = { ...recherche, reclasser: async (_q: string, f: Array<{ texte: string }>) => f.map(() => 0.01) };
    const r = await creerRepondeur(deps({ recherche: sousLeSeuil, completer }))(question);
    expect(r.sait).toBe(false);
    expect(completer).not.toHaveBeenCalled();
  });

  it('⚠️ un ÉCHEC du reclasseur retombe sur la règle lexicale, il ne rend pas muet', async () => {
    // Une panne du fournisseur doit rendre le bot moins fin, pas silencieux.
    const casse = { ...recherche, reclasser: async () => { throw new Error('rerank 500'); } };
    const r = await creerRepondeur(deps({ recherche: casse }))(question);
    expect(r.sait).toBe(true);
  });

  it('⚠️ un échec de la VECTORISATION garde le rappel lexical', async () => {
    const casse = { ...recherche, vectoriser: async () => { throw new Error('embed 500'); } };
    const r = await creerRepondeur(deps({ recherche: casse }))(question);
    expect(r.sait).toBe(true);
  });
});
