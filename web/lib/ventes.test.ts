import { describe, it, expect } from 'vitest';
import { fmtMontant, lireVentes } from './ventes';

/**
 * Quantitatif > Shopify (plan 2026-10-30, lot 2, tâche 5) : la réponse de `/stats/ventes` lue défensivement. Une API
 * plus ancienne ou plus récente que la console ne casse pas l'écran ; une ligne mal formée disparaît seule.
 */
const COMPLET = {
  periode: { from: '2026-10-01', to: '2026-10-30' },
  reel: {
    totaux: [{ devise: 'EUR', brut: '170.5', prouve: '100.5', commandes: 3 }, { devise: 'USD', brut: '30', prouve: '0', commandes: 1 }],
    sources: [
      { source: 'campagne', campaignId: 'k1', nom: 'Soldes', devise: 'EUR', brut: '150.5', prouve: '100.5', commandes: 2 },
      { source: 'agent', campaignId: null, nom: null, devise: 'USD', brut: '30', prouve: '0', commandes: 1 },
    ],
  },
  test: { totaux: [{ devise: 'USD', brut: '2148.85', prouve: '1548.85', commandes: 4 }], sources: [] },
  paniers: { relances: 7, recuperes: 2, montants: [{ devise: 'EUR', montant: '40' }], recuperesTest: 1 },
};

describe('lireVentes', () => {
  it('lit une réponse complète, montants gardés en texte', () => {
    expect(lireVentes(COMPLET)).toEqual({ reel: COMPLET.reel, test: COMPLET.test, paniers: COMPLET.paniers });
  });

  it('une réponse sans tests ni paniers (API plus ancienne) : des listes vides et des zéros', () => {
    expect(lireVentes({ reel: COMPLET.reel })).toEqual({
      reel: COMPLET.reel,
      test: { totaux: [], sources: [] },
      paniers: { relances: 0, recuperes: 0, montants: [], recuperesTest: 0 },
    });
  });

  it('une ligne mal formée disparaît seule : montant non décimal, devise absente, source inconnue', () => {
    const v = lireVentes({
      reel: {
        totaux: [{ devise: 'EUR', brut: '12,5', prouve: '0', commandes: 1 }, { brut: '3', prouve: '0', commandes: 1 }, COMPLET.reel.totaux[1]],
        sources: [{ ...COMPLET.reel.sources[0], source: 'inconnue' }, COMPLET.reel.sources[1]],
      },
    });
    expect(v?.reel).toEqual({ totaux: [COMPLET.reel.totaux[1]], sources: [COMPLET.reel.sources[1]] });
  });

  it('une réponse illisible rend null', () => {
    for (const brut of [null, 'x', 42, {}, { reel: 'x' }, { reel: null }]) expect(lireVentes(brut), JSON.stringify(brut)).toBeNull();
  });
});

describe('fmtMontant', () => {
  it('formate un décimal en texte dans sa devise, selon la langue', () => {
    expect(fmtMontant('2148.85', 'USD', 'fr')).toMatch(/^2\s148,85\s\$US$/);
    expect(fmtMontant('2148.85', 'USD', 'en')).toBe('$2,148.85');
    expect(fmtMontant('40', 'EUR', 'fr')).toMatch(/^40,00\s€$/);
  });

  it('une devise que le navigateur ne connaît pas s’écrit telle quelle, jamais une exception', () => {
    expect(fmtMontant('12.5', 'XYZ1', 'fr')).toBe('12.5 XYZ1');
  });
});
