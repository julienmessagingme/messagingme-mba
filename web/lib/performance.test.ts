import { describe, it, expect } from 'vitest';
import { fmtDuree, lirePerformance, nomDeQui, type Performance } from './performance';

/**
 * QUANTITATIF > PERFORMANCE, côté console : la validation de la réponse et l'écriture d'une durée.
 *
 * 🔴 CE QUE CES CAS PROTÈGENT : un temps inconnu ne s'écrit JAMAIS « 0 ». Une médiane absente affichée à zéro
 * dirait qu'une équipe répond instantanément, et c'est le chiffre sur lequel un client la jugera.
 */
const PERF: Performance = {
  mesureDepuis: '2026-09-30T08:00:00.000Z',
  mode: 'ouvre',
  fuseau: 'Europe/Paris',
  reponse: { mediane: 240_000, p90: 900_000, n: 3 },
  resolution: { mediane: null, p90: null, n: 0 },
  demandes: 4,
  resolues: 0,
  resoluesSansReponse: 1,
  ouvertes: 3,
  plusAncienneOuverte: '2026-09-30T09:00:00.000Z',
  parJour: [{ jour: '2026-09-30', demandes: 4, reponseMediane: 240_000, resolutionMediane: null }],
  parCollaborateur: [
    { qui: { genre: 'collaborateur', userId: 'u1', nom: 'Marie' }, reponses: 3, reponseMediane: 240_000, closes: 0, resolutionMediane: null },
    { qui: { genre: 'automatique' }, reponses: 0, reponseMediane: null, closes: 1, resolutionMediane: 3_600_000 },
  ],
};

describe('lirePerformance', () => {
  it('une réponse bien formée passe telle quelle, `null` compris', () => {
    expect(lirePerformance(JSON.parse(JSON.stringify(PERF)))).toEqual(PERF);
  });

  it('🔴 une forme inattendue rend `null` (l’écran le dit), jamais des zéros inventés', () => {
    expect(lirePerformance(null)).toBeNull();
    expect(lirePerformance({})).toBeNull();
    expect(lirePerformance({ ...PERF, reponse: { mediane: 0 } })).toBeNull();
    expect(lirePerformance({ ...PERF, mode: 'autre' })).toBeNull();
    expect(lirePerformance({ ...PERF, demandes: '4' })).toBeNull();
    expect(lirePerformance({ ...PERF, parJour: undefined })).toBeNull();
    // Une médiane négative n'est pas une durée.
    expect(lirePerformance({ ...PERF, resolution: { mediane: -1, p90: null, n: 1 } })).toBeNull();
  });

  it('une ligne mal formée d’un tableau est écartée seule', () => {
    const p = lirePerformance({
      ...PERF,
      parJour: [...PERF.parJour, { jour: 'hier', demandes: 1, reponseMediane: null, resolutionMediane: null }],
      parCollaborateur: [...PERF.parCollaborateur, { qui: { genre: 'robot' }, reponses: 1, reponseMediane: null, closes: 0, resolutionMediane: null }],
    });
    expect(p?.parJour).toEqual(PERF.parJour);
    expect(p?.parCollaborateur).toEqual(PERF.parCollaborateur);
  });
});

describe('fmtDuree', () => {
  it('🔴 `null` : « non disponible », jamais « 0 »', () => {
    expect(fmtDuree(null, 'fr')).toBe('non disponible');
    expect(fmtDuree(null, 'en')).toBe('not available');
    // Zéro, lui, est une mesure : une réponse dans la seconde.
    expect(fmtDuree(0, 'fr')).toBe('0 s');
  });

  it('chaque palier, décidé sur la valeur arrondie', () => {
    expect(fmtDuree(45_000, 'fr')).toBe('45 s');
    expect(fmtDuree(59_600, 'fr')).toBe('1 min');
    expect(fmtDuree(12 * 60_000, 'fr')).toBe('12 min');
    expect(fmtDuree(65 * 60_000, 'fr')).toBe('1 h 05');
    expect(fmtDuree(120 * 60_000, 'fr')).toBe('2 h');
    expect(fmtDuree(51 * 3_600_000, 'fr')).toBe('2 j 3 h');
    expect(fmtDuree(51 * 3_600_000, 'en')).toBe('2 d 3 h');
    expect(fmtDuree(48 * 3_600_000, 'fr')).toBe('2 j');
  });
});

describe('nomDeQui', () => {
  const t = (fr: string) => fr;
  it('un collaborateur par son nom ; l’automatique et l’ancien collaborateur dits comme tels', () => {
    expect(nomDeQui({ genre: 'collaborateur', userId: 'u1', nom: 'Marie' }, t)).toBe('Marie');
    expect(nomDeQui({ genre: 'automatique' }, t)).toBe('Automatique');
    expect(nomDeQui({ genre: 'ancien' }, t)).toBe('Ancien collaborateur');
  });
});
