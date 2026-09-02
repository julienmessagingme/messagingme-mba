import { describe, it, expect } from 'vitest';
import { balayerVectorisation, texteAVectoriser, LOT_VECTORISATION } from '../src/agent/recherche';

/**
 * LE BALAYAGE QUI VECTORISE (chantier du 2026-09-02, migration 0110).
 *
 * 🔴 Pourquoi il existe plutôt qu'un calcul à l'écriture. Il y a TROIS chemins d'écriture de fiche (à la
 * main, import d'un document, remplacement d'une source), donc trois occasions d'oublier le vecteur. Le dépôt
 * a paye ce prix le jour même avec le 131008 : une dépendance câblée d'un côté, oubliée de l'autre, et une
 * fonctionnalité qui disparaît en silence. Ici, un quatrième chemin d'écriture est vectorisé sans que
 * personne y pense.
 */

function depot(fiches: Array<{ id: string; titre: string; corps: string }>) {
  const ecrits: Array<{ modele: string; vecteurs: Array<{ id: string; vecteur: number[] }> }> = [];
  const vus: Array<{ modele: string; limite: number }> = [];
  return {
    ecrits,
    vus,
    fichesAVectoriser: async (modele: string, limite: number) => { vus.push({ modele, limite }); return fiches; },
    ecrireVecteurs: async (modele: string, vecteurs: Array<{ id: string; vecteur: number[] }>) => {
      ecrits.push({ modele, vecteurs });
      return vecteurs.length;
    },
  };
}

const troisFiches = [
  { id: 'f1', titre: 'Sortie de contrat', corps: 'preavis de deux mois' },
  { id: 'f2', titre: 'Assistance', corps: 'depannage sous 45 minutes' },
  { id: 'f3', titre: 'Horaires', corps: 'du lundi au vendredi' },
];

describe('balayerVectorisation', () => {
  it('vectorise le lot en UN SEUL appel, et écrit chaque vecteur sur SA fiche', async () => {
    const d = depot(troisFiches);
    let appels = 0;
    const n = await balayerVectorisation(d, {
      vectoriser: async (textes) => { appels += 1; return textes.map((_, i) => [i]); },
    }, 'modele-x');
    expect(appels).toBe(1);
    expect(n).toBe(3);
    expect(d.ecrits[0]!.modele).toBe('modele-x');
    expect(d.ecrits[0]!.vecteurs).toEqual([
      { id: 'f1', vecteur: [0] }, { id: 'f2', vecteur: [1] }, { id: 'f3', vecteur: [2] },
    ]);
  });

  it('🔴 une réponse INCOMPLÈTE n’écrit RIEN, elle lève', async () => {
    // Le piège invisible : écrire ce qu'on a en appariant par position ferait porter à une fiche le vecteur
    // d'une AUTRE. La recherche deviendrait absurde sans qu'aucune erreur ne remonte jamais.
    const d = depot(troisFiches);
    await expect(balayerVectorisation(d, { vectoriser: async () => [[1], [2]] }, 'm'))
      .rejects.toThrow(/2 vecteurs pour 3 fiches/);
    expect(d.ecrits).toEqual([]);
  });

  it('rien à faire -> AUCUN appel au Gateway', async () => {
    // Le cas de loin le plus fréquent : le balayage tourne chaque minute et n'a presque jamais rien à faire.
    const d = depot([]);
    let appels = 0;
    const n = await balayerVectorisation(d, { vectoriser: async () => { appels += 1; return []; } }, 'm');
    expect(n).toBe(0);
    expect(appels).toBe(0);
    expect(d.ecrits).toEqual([]);
  });

  it('le MODÈLE voyage jusqu’à la lecture ET jusqu’à l’écriture', async () => {
    // C'est lui qui rend un changement de modèle progressif : la lecture s'en sert pour trouver les vecteurs
    // périmés, l'écriture pour marquer ceux qu'elle vient de produire.
    const d = depot(troisFiches);
    await balayerVectorisation(d, { vectoriser: async (t) => t.map(() => [1]) }, 'cohere/embed-v4.0');
    expect(d.vus[0]!.modele).toBe('cohere/embed-v4.0');
    expect(d.ecrits[0]!.modele).toBe('cohere/embed-v4.0');
  });

  it('le lot est BORNÉ, et par défaut à la constante', async () => {
    const d = depot([]);
    await balayerVectorisation(d, { vectoriser: async () => [] }, 'm');
    expect(d.vus[0]!.limite).toBe(LOT_VECTORISATION);
  });
});

describe('texteAVectoriser', () => {
  it('vectorise le titre ET le corps : un titre seul ne dit pas ce que la fiche contient', () => {
    expect(texteAVectoriser({ titre: 'T', corps: 'C' })).toBe('T\nC');
  });

  it('borne le texte : une fiche démesurée ne doit pas faire échouer son propre lot', () => {
    const enorme = texteAVectoriser({ titre: 'T', corps: 'x'.repeat(50_000) });
    expect(enorme.length).toBe(8_000);
  });
});
