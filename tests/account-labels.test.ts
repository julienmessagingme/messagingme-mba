import { describe, it, expect } from 'vitest';
import { throughputLabel, tierLabel } from '../web/lib/format';

// Mapping d'affichage du statut compte (page Accueil) : débit chiffré + cap en clair. Fonctions pures,
// LOCALE REQUISE (Lot 6 i18n) : on teste les DEUX langues.
describe('throughputLabel (débit chiffré, pas le libellé brut)', () => {
  it('STANDARD -> 80 msg/s, HIGH -> 1 000 msg/s (fr)', () => {
    expect(throughputLabel('STANDARD', 'fr')).toBe('80 messages / seconde');
    expect(throughputLabel('HIGH', 'fr')).toBe('1 000 messages / seconde');
  });
  it('anglais : second / 1,000 / Not applicable', () => {
    expect(throughputLabel('STANDARD', 'en')).toBe('80 messages / second');
    expect(throughputLabel('HIGH', 'en')).toBe('1,000 messages / second');
    expect(throughputLabel('NOT_APPLICABLE', 'en')).toBe('Not applicable');
  });
  it('insensible à la casse', () => {
    expect(throughputLabel('standard', 'fr')).toBe('80 messages / seconde');
  });
  it('valeur inconnue -> brut (jamais un faux chiffre), quelle que soit la langue', () => {
    expect(throughputLabel('WHATEVER', 'fr')).toBe('WHATEVER');
    expect(throughputLabel('WHATEVER', 'en')).toBe('WHATEVER');
  });
});

describe('tierLabel (cap = clients / 24 h)', () => {
  it('paliers Meta -> clients / 24 h (fr)', () => {
    expect(tierLabel('TIER_250', 'fr')).toBe('250 clients / 24 h');
    expect(tierLabel('TIER_1K', 'fr')).toBe('1 000 clients / 24 h');
    expect(tierLabel('TIER_10K', 'fr')).toBe('10 000 clients / 24 h');
    expect(tierLabel('TIER_100K', 'fr')).toBe('100 000 clients / 24 h');
  });
  it('paliers Meta -> customers / 24 h (en)', () => {
    expect(tierLabel('TIER_250', 'en')).toBe('250 customers / 24 h');
    expect(tierLabel('TIER_1K', 'en')).toBe('1,000 customers / 24 h');
  });
  it('illimité / Unlimited', () => {
    expect(tierLabel('UNLIMITED', 'fr')).toBe('Illimité');
    expect(tierLabel('TIER_UNLIMITED', 'fr')).toBe('Illimité');
    expect(tierLabel('UNLIMITED', 'en')).toBe('Unlimited');
  });
  it('valeur inconnue -> brut', () => {
    expect(tierLabel('TIER_999', 'fr')).toBe('TIER_999');
  });
});
