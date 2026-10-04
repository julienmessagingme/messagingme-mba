import { describe, it, expect } from 'vitest';
import { avisStopsGardes, quiLeveUnStop } from './stops-gardes';

const fr = (texte: string): string => texte;
const en = (texte: string, anglais?: string): string => anglais ?? texte;

/**
 * 🔴 L'ACTION EN MASSE NE LÈVE PAS UN STOP (2026-10-03), ET L'ÉCRAN LE DIT. Sans ce message, l'opérateur verrait sa
 * sélection « passée en opt-in » et croirait avoir réabonné tout le monde.
 */
describe('avisStopsGardes', () => {
  it('🔴 dit combien de fiches ont gardé leur STOP, au singulier comme au pluriel', () => {
    expect(avisStopsGardes({ stopsGardes: 1 }, fr)).toBe(
      '1 fiche a gardé son STOP : un STOP se lève depuis la fiche du contact, par la personne elle-même, par un import CSV case cochée ou par un scénario.',
    );
    expect(avisStopsGardes({ stopsGardes: 3 }, fr)).toMatch(/^3 fiches ont gardé leur STOP : /);
    expect(avisStopsGardes({ stopsGardes: 2 }, en)).toMatch(/^2 contacts kept their STOP: a STOP is lifted from /);
  });

  /**
   * 🔴 La phrase dit TOUS les chemins qui lèvent un STOP (`LEVE_UN_STOP`, `src/crm/transition-consentement.ts`). Elle a
   * dit « seulement la fiche, ou la personne », ce qui envoyait l'opérateur chercher sur chaque fiche ce qu'un import
   * case cochée ou un scénario font aussi.
   */
  it('🔴 qui lève un STOP : la fiche, la personne, l’import CSV case cochée, le scénario, dans les deux langues', () => {
    for (const phrase of [quiLeveUnStop(fr), quiLeveUnStop(en)]) {
      expect(phrase).not.toMatch(/\bne se lève que\b|\bonly\b/);
    }
    expect(quiLeveUnStop(fr)).toMatch(/fiche du contact.*personne elle-même.*import CSV case cochée.*scénario/);
    expect(quiLeveUnStop(en)).toMatch(/contact’s record.*person themselves.*CSV import with the box ticked.*scenario/);
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
