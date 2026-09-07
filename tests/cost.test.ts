import { describe, it, expect } from 'vitest';
import { estimateCostSeries, enumerateDays } from '../src/stats/cost';
import type { CostVolumeRow } from '../src/stats/store.pg';

describe('enumerateDays', () => {
  it('énumère les jours inclus', () => {
    expect(enumerateDays('2026-07-09', '2026-07-11')).toEqual(['2026-07-09', '2026-07-10', '2026-07-11']);
  });
  it('un seul jour', () => {
    expect(enumerateDays('2026-07-09', '2026-07-09')).toEqual(['2026-07-09']);
  });
});

describe('estimateCostSeries', () => {
  const rows: CostVolumeRow[] = [
    { date: '2026-07-09', category: 'marketing', count: 10 },
    { date: '2026-07-09', category: 'utility', count: 4 },
    { date: '2026-07-11', category: 'marketing', count: 2 },
  ];

  it('multiplie volume × tarif, dense sur la plage, arrondi 2 décimales', () => {
    const s = estimateCostSeries('2026-07-09', '2026-07-11', rows, { marketing: 0.1431, utility: 0.05 });
    expect(s.marketing).toEqual([
      { date: '2026-07-09', count: 1.43 },
      { date: '2026-07-10', count: 0 },
      { date: '2026-07-11', count: 0.29 },
    ]);
    expect(s.utility).toEqual([
      { date: '2026-07-09', count: 0.2 },
      { date: '2026-07-10', count: 0 },
      { date: '2026-07-11', count: 0 },
    ]);
    expect(s.total).toBe(1.92); // 1.431 + 0.2862 + 0.2 = 1.9172 -> 1.92
    expect(s.hasRates).toBe(true);
  });

  it('catégorie sans tarif ne contribue pas (jamais de coût inventé)', () => {
    const s = estimateCostSeries('2026-07-09', '2026-07-09', rows, { marketing: null, utility: 0.05 });
    expect(s.marketing[0]!.count).toBe(0); // pas de tarif marketing -> 0
    expect(s.utility[0]!.count).toBe(0.2);
    expect(s.total).toBe(0.2);
    expect(s.hasRates).toBe(true); // utility a un tarif
  });

  it('aucun tarif -> hasRates=false, total 0', () => {
    const s = estimateCostSeries('2026-07-09', '2026-07-09', rows, { marketing: null, utility: null });
    expect(s.total).toBe(0);
    expect(s.hasRates).toBe(false);
  });

  /**
   * 🔴 CE QUI N EST PAS CHIFFRABLE SE COMPTE, IL NE DISPARAIT PAS.
   *
   * Une ligne sans categorie connue ne produit aucun cout, et jusqu ici elle sortait du calcul SANS
   * LAISSER DE TRACE : l ecran affichait zero la ou il y avait bien eu des envois. C est ce qui a fait
   * croire a un cout nul sur 22 envois de scenario du tenant Demo, dont la categorie n etait pas ecrite
   * avant le 2026-09-07. Le volume, lui, les comptait : les deux ecrans se contredisaient sans que rien
   * ne l explique.
   */
  it('🔴 compte les envois NON CHIFFRABLES au lieu de les jeter en silence', () => {
    const rows = [
      { date: '2026-07-09', category: 'marketing', count: 2 },
      { date: '2026-07-09', category: null, count: 7 },
    ];
    const s = estimateCostSeries('2026-07-09', '2026-07-09', rows, { marketing: 0.1, utility: 0.05 });
    expect(s.nonChiffrables).toBe(7);
    // Et ils n entrent PAS dans le cout : on ne devine pas une categorie, elle se facturerait au mauvais tarif.
    expect(s.total).toBeCloseTo(0.2, 5);
  });

  it('un tarif MANQUANT rend aussi la ligne non chiffrable, pas gratuite', () => {
    // Meme cause, autre origine : la categorie est connue mais Meta n a pas donne son tarif. Compter la
    // ligne a zero laisserait croire a un envoi gratuit.
    const rows = [{ date: '2026-07-09', category: 'utility', count: 3 }];
    const s = estimateCostSeries('2026-07-09', '2026-07-09', rows, { marketing: 0.1, utility: null });
    expect(s.nonChiffrables).toBe(3);
    expect(s.total).toBe(0);
  });

  it('rien de non chiffrable quand tout a sa categorie et son tarif', () => {
    const rows = [{ date: '2026-07-09', category: 'marketing', count: 4 }];
    expect(estimateCostSeries('2026-07-09', '2026-07-09', rows, { marketing: 0.1, utility: 0.05 }).nonChiffrables).toBe(0);
  });
});
