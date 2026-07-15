import { describe, it, expect } from 'vitest';
import { throughputLabel, tierLabel } from '../web/lib/format';

// Mapping d'affichage du statut compte (page Accueil) : débit chiffré + cap en clair. Fonctions pures.
describe('throughputLabel (débit chiffré, pas le libellé brut)', () => {
  it('STANDARD -> 80 msg/s, HIGH -> 1 000 msg/s', () => {
    expect(throughputLabel('STANDARD')).toBe('80 messages / seconde');
    expect(throughputLabel('HIGH')).toBe('1 000 messages / seconde');
  });
  it('insensible à la casse', () => {
    expect(throughputLabel('standard')).toBe('80 messages / seconde');
  });
  it('valeur inconnue -> brut (jamais un faux chiffre)', () => {
    expect(throughputLabel('WHATEVER')).toBe('WHATEVER');
  });
});

describe('tierLabel (cap = clients / 24 h)', () => {
  it('paliers Meta -> clients / 24 h', () => {
    expect(tierLabel('TIER_250')).toBe('250 clients / 24 h');
    expect(tierLabel('TIER_1K')).toBe('1 000 clients / 24 h');
    expect(tierLabel('TIER_10K')).toBe('10 000 clients / 24 h');
    expect(tierLabel('TIER_100K')).toBe('100 000 clients / 24 h');
  });
  it('illimité', () => {
    expect(tierLabel('UNLIMITED')).toBe('Illimité');
    expect(tierLabel('TIER_UNLIMITED')).toBe('Illimité');
  });
  it('valeur inconnue -> brut', () => {
    expect(tierLabel('TIER_999')).toBe('TIER_999');
  });
});
