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
});
