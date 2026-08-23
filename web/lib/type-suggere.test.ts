import { describe, it, expect } from 'vitest';
import { typeSuggere } from './type-suggere';

/**
 * Le type PROPOSÉ quand on crée un champ depuis une valeur reçue d'un outil tiers.
 *
 * L'enjeu est celui-ci : une valeur comme « envoyé le » doit atterrir dans un champ DATE ET HEURE, pas dans
 * du texte. En texte, elle s'affiche pareil mais on ne peut plus rien en faire (ni comparer, ni trier, ni
 * déclencher un rappel dessus), et personne ne remarque le problème avant d'en avoir besoin.
 */
describe('type proposé pour un champ créé à la volée', () => {
  it('🔴 un instant ISO propose « date et heure »', () => {
    for (const v of ['2026-08-23T15:40:00Z', '2026-08-23T15:40', '2026-08-23 15:40:00', '2026-08-23T15:40:00+02:00']) {
      expect(typeSuggere(v), v).toBe('datetime');
    }
  });

  it('un jour seul propose « date »', () => {
    expect(typeSuggere('2026-08-23')).toBe('date');
  });

  it('nombre, booléen et lien sont reconnus', () => {
    expect(typeSuggere(42.5)).toBe('number');
    expect(typeSuggere(0)).toBe('number');
    expect(typeSuggere(true)).toBe('boolean');
    expect(typeSuggere('https://exemple.fr/a')).toBe('url');
  });

  it('🔴 une chaîne de chiffres reste du TEXTE', () => {
    // « 0612345678 » et « 75001 » perdraient leur zéro de tête en nombre, et un téléphone n'est pas une
    // quantité. Proposer « nombre » ici casserait la donnée à la première lecture.
    for (const v of ['0612345678', '75001', '007']) expect(typeSuggere(v), v).toBe('text');
  });

  it('tout le reste est du texte, y compris ce qu’on ne sait pas lire', () => {
    for (const v of ['Marie Durand', '', 'demain', null, undefined, { a: 1 }, [1, 2]]) {
      expect(typeSuggere(v), String(v)).toBe('text');
    }
  });
});
