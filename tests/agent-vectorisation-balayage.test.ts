import { describe, it, expect } from 'vitest';
import { balayerVectorisation, balayerVectorisationPayee, texteAVectoriser, LOT_VECTORISATION, type FacturationVectorisation } from '../src/agent/recherche';

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
      vectoriser: async (textes) => { appels += 1; return { vecteurs: textes.map((_, i) => [i]), coutDollars: 0 }; },
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
    await expect(balayerVectorisation(d, { vectoriser: async () => ({ vecteurs: [[1], [2]], coutDollars: 0 }) }, 'm'))
      .rejects.toThrow(/2 vecteurs pour 3 fiches/);
    expect(d.ecrits).toEqual([]);
  });

  it('rien à faire -> AUCUN appel au Gateway', async () => {
    // Le cas de loin le plus fréquent : le balayage tourne chaque minute et n'a presque jamais rien à faire.
    const d = depot([]);
    let appels = 0;
    const n = await balayerVectorisation(d, { vectoriser: async () => { appels += 1; return { vecteurs: [], coutDollars: 0 }; } }, 'm');
    expect(n).toBe(0);
    expect(appels).toBe(0);
    expect(d.ecrits).toEqual([]);
  });

  it('le MODÈLE voyage jusqu’à la lecture ET jusqu’à l’écriture', async () => {
    // C'est lui qui rend un changement de modèle progressif : la lecture s'en sert pour trouver les vecteurs
    // périmés, l'écriture pour marquer ceux qu'elle vient de produire.
    const d = depot(troisFiches);
    await balayerVectorisation(d, { vectoriser: async (t) => ({ vecteurs: t.map(() => [1]), coutDollars: 0 }) }, 'cohere/embed-v4.0');
    expect(d.vus[0]!.modele).toBe('cohere/embed-v4.0');
    expect(d.ecrits[0]!.modele).toBe('cohere/embed-v4.0');
  });

  it('le lot est BORNÉ, et par défaut à la constante', async () => {
    const d = depot([]);
    await balayerVectorisation(d, { vectoriser: async () => ({ vecteurs: [], coutDollars: 0 }) }, 'm');
    expect(d.vus[0]!.limite).toBe(LOT_VECTORISATION);
  });
});

/**
 * 🔴 LA VECTORISATION DES FICHES DE CONNAISSANCE SUR LE CRÉDIT DU CLIENT (lot 6, livraison C, tâche 18) : le dépôt ne
 * rend que les fiches d'un espace qui a du crédit (les autres attendent), un appel par espace, et chaque espace paie
 * SON coût au tarif de SON offre, après l'écriture de ses vecteurs.
 */
describe('balayerVectorisationPayee', () => {
  function depotPaye(fiches: Array<{ id: string; titre: string; corps: string; tenantId: string }>) {
    const ecrits: Array<{ modele: string; vecteurs: Array<{ id: string; vecteur: number[] }> }> = [];
    return {
      ecrits,
      fichesAVectoriser: async () => fiches,
      ecrireVecteurs: async (modele: string, vecteurs: Array<{ id: string; vecteur: number[] }>) => {
        ecrits.push({ modele, vecteurs });
        return vecteurs.length;
      },
    };
  }
  function facturation(o: { debiter?: FacturationVectorisation['debiter'] } = {}) {
    const debits: Array<{ tenantId: string; montant: number; note: string }> = [];
    const f: FacturationVectorisation = {
      commissionPour: async (t) => (t === 'base' ? 50 : 10),
      tauxEurParDollar: 1,
      debiter: o.debiter ?? (async (tenantId, montant, note) => { debits.push({ tenantId, montant, note }); }),
    };
    return { f, debits };
  }
  const fiches = [
    { id: 'b1', titre: 'a', corps: 'a', tenantId: 'base' },
    { id: 'p1', titre: 'b', corps: 'b', tenantId: 'pro' },
    { id: 'b2', titre: 'c', corps: 'c', tenantId: 'base' },
  ];

  it('🔴 un appel PAR ESPACE, et chaque espace paie son coût au tarif de son offre, une fois ses vecteurs écrits', async () => {
    const d = depotPaye(fiches);
    const appels: string[][] = [];
    const { f, debits } = facturation();
    const n = await balayerVectorisationPayee(d, {
      vectoriser: async (textes) => { appels.push(textes); return { vecteurs: textes.map(() => [1]), coutDollars: textes.length * 0.001 }; },
    }, 'm', f);
    expect(n).toBe(3);
    expect(appels).toHaveLength(2);
    expect(d.ecrits.map((e) => e.vecteurs.map((v) => v.id))).toEqual([['b1', 'b2'], ['p1']]);
    // Base : 0,002 $ -> 2 000 micro-euros bruts, + 50 % ; Pro : 0,001 $ -> 1 000, + 10 %.
    expect(debits).toEqual([
      { tenantId: 'base', montant: 3000, note: 'vectorisation de 2 fiches de connaissance' },
      { tenantId: 'pro', montant: 1100, note: 'vectorisation de 1 fiche de connaissance' },
    ]);
  });

  it('un coût nul n’écrit aucun débit', async () => {
    const d = depotPaye(fiches.slice(0, 1));
    const { f, debits } = facturation();
    await balayerVectorisationPayee(d, { vectoriser: async (t) => ({ vecteurs: t.map(() => [1]), coutDollars: 0 }) }, 'm', f);
    expect(d.ecrits).toHaveLength(1);
    expect(debits).toEqual([]);
  });

  it('🔴 un débit qui échoue ne lève pas : les vecteurs sont écrits, le balayage n’alerte pas sur une vectorisation réussie', async () => {
    const d = depotPaye(fiches.slice(0, 1));
    const { f } = facturation({ debiter: async () => { throw new Error('base indisponible'); } });
    const n = await balayerVectorisationPayee(d, { vectoriser: async (t) => ({ vecteurs: t.map(() => [1]), coutDollars: 0.001 }) }, 'm', f);
    expect(n).toBe(1);
  });

  it('🔴 une réponse INCOMPLÈTE n’écrit rien pour cet espace et ne le débite pas : elle lève', async () => {
    const d = depotPaye(fiches.slice(0, 2));
    const { f, debits } = facturation();
    // Chaque espace du lot échoue et le balayage le dit ensuite (J2) ; le cas exercé reste : rien d'écrit, rien de débité.
    await expect(balayerVectorisationPayee(d, { vectoriser: async () => ({ vecteurs: [], coutDollars: 0.001 }) }, 'm', f))
      .rejects.toThrow(/2 espace\(s\) en échec : base, pro/);
    expect(d.ecrits).toEqual([]);
    expect(debits).toEqual([]);
  });

  it('🔴 J2 : un espace dont l’appel échoue n’arrête pas les autres ; le balayage lève ENSUITE, en le nommant', async () => {
    const d = depotPaye(fiches);
    const { f, debits } = facturation();
    const vectoriser = async (textes: string[]) => {
      // Le texte vectorisé est « titre, saut de ligne, corps » (`texteAVectoriser`) : la fiche de la Base commence par « a ».
      if (textes.some((t) => t.startsWith('a\n'))) throw new Error('400 fiche refusee');
      return { vecteurs: textes.map(() => [1]), coutDollars: 0.001 };
    };
    await expect(balayerVectorisationPayee(d, { vectoriser }, 'm', f)).rejects.toThrow(/1 espace\(s\) en échec : base/);
    expect(d.ecrits.map((e) => e.vecteurs.map((v) => v.id))).toEqual([['p1']]);
    expect(debits).toEqual([{ tenantId: 'pro', montant: 1100, note: 'vectorisation de 1 fiche de connaissance' }]);
  });

  it('rien à faire -> AUCUN appel', async () => {
    const d = depotPaye([]);
    let appels = 0;
    const { f } = facturation();
    expect(await balayerVectorisationPayee(d, { vectoriser: async () => { appels += 1; return { vecteurs: [], coutDollars: 0 }; } }, 'm', f)).toBe(0);
    expect(appels).toBe(0);
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
