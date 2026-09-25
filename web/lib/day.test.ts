import { describe, it, expect } from 'vitest';
import { dateHeure, hourMin, jourHeure } from './day';

/**
 * Le jour ET l'heure dans la liste des conversations de l'Inbox (demande de Julien du 2026-09-23) : l'heure seule
 * ne disait pas de quel jour était le dernier message. Fuseau Paris, quelle que soit la machine qui affiche.
 */
describe('jourHeure', () => {
  it('rend le jour et l’heure, en heure de Paris', () => {
    // 15 h 42 UTC = 17 h 42 à Paris en septembre (heure d'été).
    expect(jourHeure('2026-09-22T15:42:12Z', 'fr')).toBe('22/09 17:42');
    expect(jourHeure('2026-09-22T15:42:12Z', 'en')).toBe('22/09 17:42');
  });

  it('change de jour à minuit PARIS, pas à minuit UTC', () => {
    // 22 h 30 UTC le 22 = 0 h 30 le 23 à Paris.
    expect(jourHeure('2026-09-22T22:30:00Z', 'fr')).toBe('23/09 00:30');
  });

  it('garde l’heure de hourMin, qui reste celle des bulles du fil', () => {
    expect(jourHeure('2026-09-22T15:42:12Z', 'fr').endsWith(hourMin('2026-09-22T15:42:12Z', 'fr'))).toBe(true);
  });
});

describe('dateHeure', () => {
  it('rend la date complète et l’heure sur 24 h, en heure de Paris, dans les deux langues', () => {
    expect(dateHeure('2026-09-22T16:49:00Z', 'fr')).toBe('22/09/2026 18:49');
    // Jamais « 06:49 PM » : l'anglais de la console est britannique, sur 24 h.
    expect(dateHeure('2026-09-22T16:49:00Z', 'en')).toBe('22/09/2026 18:49');
  });
});
