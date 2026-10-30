import { describe, it, expect } from 'vitest';
import { chiffreVentes } from '../src/shopify/chiffre';
import type { LignesChiffre } from '../src/shopify/ventes.pg';

/**
 * LE CHIFFRE D'AFFAIRES ATTRIBUÉ, TEL QU'IL SE LIT (plan 2026-10-30, lot 2, tâche 1). `chiffreVentes` ne fait que
 * répartir ce que la base a sommé : le réel d'un côté, les commandes de test de l'autre, jamais un montant recalculé.
 * Le faux store est une CLASSE dont la méthode lit `this` : un câblage qui la détacherait de son objet échouerait ici.
 */
class FauxStore {
  constructor(private readonly lignes: LignesChiffre) {}
  periodes: Array<{ from: string; to: string }> = [];
  async lireChiffre(_tenantId: string, range: { from: string; to: string }): Promise<LignesChiffre> {
    this.periodes.push(range);
    return this.lignes;
  }
}

const periode = { from: '2026-10-01', to: '2026-10-30' };

describe('chiffreVentes', () => {
  it('sépare le réel et les commandes de test, sans toucher aux montants', async () => {
    const store = new FauxStore({
      totaux: [
        { test: false, devise: 'EUR', brut: '170.5', prouve: '100.5', commandes: 3 },
        { test: false, devise: 'USD', brut: '30', prouve: '0', commandes: 1 },
        { test: true, devise: 'USD', brut: '2148.85', prouve: '1548.85', commandes: 4 },
      ],
      ventes: [
        { test: true, source: 'campagne', campaignId: 'k1', nom: 'essai', devise: 'USD', brut: '1362.9', prouve: '762.9', commandes: 3 },
        { test: false, source: 'campagne', campaignId: 'k2', nom: 'Soldes', devise: 'EUR', brut: '150.5', prouve: '100.5', commandes: 2 },
        { test: true, source: 'relance_panier', campaignId: null, nom: null, devise: 'USD', brut: '785.95', prouve: '785.95', commandes: 1 },
        { test: false, source: 'agent', campaignId: null, nom: null, devise: 'USD', brut: '30', prouve: '0', commandes: 1 },
      ],
      relances: 7,
      recuperes: [
        { test: false, devise: 'EUR', montant: '40', commandes: 1 },
        { test: true, devise: 'USD', montant: '785.95', commandes: 1 },
      ],
    });
    const c = await chiffreVentes(store, 't1', periode);
    expect(store.periodes).toEqual([periode]);
    expect(c).toEqual({
      periode,
      reel: {
        totaux: [
          { devise: 'EUR', brut: '170.5', prouve: '100.5', commandes: 3 },
          { devise: 'USD', brut: '30', prouve: '0', commandes: 1 },
        ],
        sources: [
          { source: 'campagne', campaignId: 'k2', nom: 'Soldes', devise: 'EUR', brut: '150.5', prouve: '100.5', commandes: 2 },
          { source: 'agent', campaignId: null, nom: null, devise: 'USD', brut: '30', prouve: '0', commandes: 1 },
        ],
      },
      test: {
        totaux: [{ devise: 'USD', brut: '2148.85', prouve: '1548.85', commandes: 4 }],
        sources: [
          { source: 'campagne', campaignId: 'k1', nom: 'essai', devise: 'USD', brut: '1362.9', prouve: '762.9', commandes: 3 },
          { source: 'relance_panier', campaignId: null, nom: null, devise: 'USD', brut: '785.95', prouve: '785.95', commandes: 1 },
        ],
      },
      paniers: { relances: 7, recuperes: 1, montants: [{ devise: 'EUR', montant: '40' }], recuperesTest: 1 },
    });
  });

  it('un espace sans vente rend des listes vides et des zéros, jamais null', async () => {
    const c = await chiffreVentes(new FauxStore({ totaux: [], ventes: [], relances: 0, recuperes: [] }), 't1', periode);
    expect(c).toEqual({
      periode,
      reel: { totaux: [], sources: [] },
      test: { totaux: [], sources: [] },
      paniers: { relances: 0, recuperes: 0, montants: [], recuperesTest: 0 },
    });
  });

  it('les récupérés se comptent sur toutes les devises', async () => {
    const c = await chiffreVentes(new FauxStore({
      totaux: [], ventes: [], relances: 5,
      recuperes: [
        { test: false, devise: 'EUR', montant: '40', commandes: 2 },
        { test: false, devise: 'USD', montant: '12', commandes: 1 },
        { test: true, devise: 'EUR', montant: '3', commandes: 2 },
      ],
    }), 't1', periode);
    expect(c.paniers).toEqual({
      relances: 5, recuperes: 3, montants: [{ devise: 'EUR', montant: '40' }, { devise: 'USD', montant: '12' }], recuperesTest: 2,
    });
  });
});
