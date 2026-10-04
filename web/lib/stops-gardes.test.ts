import { describe, it, expect } from 'vitest';
import { avisStopsGardes } from './stops-gardes';

const fr = (texte: string): string => texte;
const en = (texte: string, anglais?: string): string => anglais ?? texte;

/**
 * 🔴 L'ACTION EN MASSE NE LÈVE PAS UN STOP (2026-10-03), ET L'ÉCRAN LE DIT. Sans ce message, l'opérateur verrait sa
 * sélection « passée en opt-in » et croirait avoir réabonné tout le monde.
 */
describe('avisStopsGardes', () => {
  it('🔴 dit combien de fiches ont gardé leur STOP, au singulier comme au pluriel', () => {
    expect(avisStopsGardes({ stopsGardes: 1 }, fr)).toBe('1 fiche a gardé son STOP : un STOP ne se lève que depuis la fiche du contact, ou par la personne elle-même.');
    expect(avisStopsGardes({ stopsGardes: 3 }, fr)).toMatch(/^3 fiches ont gardé leur STOP : /);
    expect(avisStopsGardes({ stopsGardes: 2 }, en)).toMatch(/^2 contacts kept their STOP: /);
  });

  /** ⚠️ Vercel publie la console avant le `up` de l'API : une réponse SANS ce nombre doit garder l'ancien écran. */
  it('⚠️ absent, nul ou illisible : aucun message', () => {
    expect(avisStopsGardes({}, fr)).toBeNull();
    expect(avisStopsGardes({ stopsGardes: 0 }, fr)).toBeNull();
    expect(avisStopsGardes({ stopsGardes: '2' }, fr)).toBeNull();
    expect(avisStopsGardes({ stopsGardes: null }, fr)).toBeNull();
    expect(avisStopsGardes({ stopsGardes: 1.5 }, fr)).toBeNull();
  });
});
