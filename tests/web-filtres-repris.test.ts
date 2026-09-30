import { describe, it, expect } from 'vitest';
import { filtersActive, filtresRepris } from '../web/lib/contact-filters';

/**
 * La reprise d'un brouillon de campagne (`filtresRepris`), dont les filtres reviennent d'un jsonb opaque.
 * 🔴 Les opérateurs de la dernière analyse (lot 2b « Tout sur la fiche ») doivent y survivre : un brouillon qui
 * perdrait « urgence au moins 7 » en reprenant repartirait vers une audience plus large que celle qu'on a construite.
 */
describe('filtresRepris et les filtres de la dernière analyse', () => {
  it('🔴 garde chaque opérateur de colonne', () => {
    const fieldFilters = [
      { key: 'analyse_sentiment', op: 'in', value: 'negatif' },
      { key: 'analyse_urgence', op: 'gte', value: '7' },
      { key: 'analyse_satisfaction', op: 'lte', value: '3' },
      { key: 'analyse_resolue', op: 'is_true', value: '' },
      { key: 'analyse_resolue', op: 'is_false', value: '' },
      { key: 'analyse_le', op: 'newer_than_days', value: '30' },
    ];
    expect(filtresRepris({ fieldFilters })).toEqual({ fieldFilters });
  });

  it('jette toujours un opérateur inconnu', () => {
    expect(filtresRepris({ fieldFilters: [{ key: 'analyse_urgence', op: 'environ', value: '7' }] })).toEqual({});
  });

  it('🔴 « résolue : oui » est un filtre actif, même sans valeur', () => {
    // Sinon l'écran le croirait vide et reprendrait le chemin de la liste par défaut, donc tout l'espace.
    expect(filtersActive({ fieldFilters: [{ key: 'analyse_resolue', op: 'is_true', value: '' }] })).toBe(true);
    expect(filtersActive({ fieldFilters: [{ key: 'analyse_resolue', op: 'is_false', value: '' }] })).toBe(true);
  });
});
