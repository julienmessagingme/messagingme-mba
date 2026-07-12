import { describe, it, expect } from 'vitest';
import { parseRange, isValidDateStr, addDays, inclusiveDays, todayParis, zonedMidnightEpochSec } from '../src/stats/range';

describe('helpers de dates', () => {
  it('isValidDateStr : format + date réelle', () => {
    expect(isValidDateStr('2026-07-01')).toBe(true);
    expect(isValidDateStr('2026-02-31')).toBe(false); // 31 février n'existe pas
    expect(isValidDateStr('2026-7-1')).toBe(false);
    expect(isValidDateStr('hier')).toBe(false);
    expect(isValidDateStr(42)).toBe(false);
  });

  it('addDays : arithmétique calendaire (traverse un mois)', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-07-10', -29)).toBe('2026-06-11');
  });

  it('inclusiveDays : from==to -> 1', () => {
    expect(inclusiveDays('2026-07-01', '2026-07-01')).toBe(1);
    expect(inclusiveDays('2026-07-01', '2026-07-30')).toBe(30);
  });

  it('zonedMidnightEpochSec : minuit Paris DST-aware (été UTC+2, hiver UTC+1)', () => {
    // 2026-07-01 00:00 Paris (été) = 2026-06-30 22:00 UTC
    expect(zonedMidnightEpochSec('2026-07-01')).toBe(Math.floor(Date.UTC(2026, 5, 30, 22, 0, 0) / 1000));
    // 2026-01-01 00:00 Paris (hiver) = 2025-12-31 23:00 UTC
    expect(zonedMidnightEpochSec('2026-01-01')).toBe(Math.floor(Date.UTC(2025, 11, 31, 23, 0, 0) / 1000));
  });
});

describe('parseRange', () => {
  it('from+to valides -> range', () => {
    expect(parseRange({ from: '2026-01-01', to: '2026-01-31' })).toEqual({ range: { from: '2026-01-01', to: '2026-01-31' } });
  });

  it('from > to -> error', () => {
    expect('error' in parseRange({ from: '2026-02-01', to: '2026-01-01' })).toBe(true);
  });

  it('to dans le futur -> error', () => {
    expect('error' in parseRange({ from: '2020-01-01', to: '2999-01-01' })).toBe(true);
  });

  it('span > 366j -> error', () => {
    expect('error' in parseRange({ from: '2024-01-01', to: '2026-01-01' })).toBe(true);
  });

  it('un seul de from/to -> error', () => {
    expect('error' in parseRange({ from: '2026-01-01' })).toBe(true);
    expect('error' in parseRange({ to: '2026-01-01' })).toBe(true);
  });

  it('from/to malformés -> error', () => {
    expect('error' in parseRange({ from: '2026-13-01', to: '2026-01-01' })).toBe(true);
  });

  it('repli days : to = aujourd\'hui Paris, span = days', () => {
    const r = parseRange({ days: '30' });
    if ('error' in r) throw new Error('inattendu');
    expect(r.range.to).toBe(todayParis());
    expect(inclusiveDays(r.range.from, r.range.to)).toBe(30);
  });

  it('sans params -> repli 30j', () => {
    const r = parseRange({});
    if ('error' in r) throw new Error('inattendu');
    expect(inclusiveDays(r.range.from, r.range.to)).toBe(30);
  });

  it('days invalide -> défaut 30, days > 366 clampé', () => {
    const bad = parseRange({ days: 'abc' });
    if ('error' in bad) throw new Error('inattendu');
    expect(inclusiveDays(bad.range.from, bad.range.to)).toBe(30);
    const big = parseRange({ days: '9999' });
    if ('error' in big) throw new Error('inattendu');
    expect(inclusiveDays(big.range.from, big.range.to)).toBe(366);
  });
});
