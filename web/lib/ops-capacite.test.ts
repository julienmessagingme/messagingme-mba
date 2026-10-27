import { describe, it, expect } from 'vitest';
import { montees7Jours, parJour, retardParJour } from './ops-capacite';

const heure = (iso: string, copiesMax: number, minutesDeuxCopiesOuPlus = 0) => ({
  heure: iso, copiesMax, minutesDeuxCopiesOuPlus, attentesApi: 1, attentesWorkers: 2, maxAttenteMs: 0,
});

describe('parJour', () => {
  it('un point par jour de Paris : le maximum, ou la somme, des heures du jour', () => {
    const points = [heure('2026-10-26T08:00:00.000Z', 1), heure('2026-10-26T15:00:00.000Z', 3), heure('2026-10-27T09:00:00.000Z', 2)];
    expect(parJour(points, (p) => p.copiesMax, 'max')).toEqual([{ date: '2026-10-26', count: 3 }, { date: '2026-10-27', count: 2 }]);
    expect(parJour(points, (p) => p.attentesApi, 'somme')).toEqual([{ date: '2026-10-26', count: 2 }, { date: '2026-10-27', count: 1 }]);
  });

  it('🔴 le jour est celui de Paris : 23 h 30 UTC un 26 octobre (heure d’hiver) est déjà le 27', () => {
    expect(parJour([heure('2026-10-26T23:30:00.000Z', 1)], (p) => p.copiesMax, 'max')).toEqual([{ date: '2026-10-27', count: 1 }]);
  });
});

describe('retardParJour', () => {
  it('le pire p95 de la file seulement, arrondi au dixième de seconde', () => {
    const f = (file: string, iso: string, p95: number) => ({ file, heure: iso, echantillons: 5, attenteP95Secondes: 0, boutEnBoutP95Secondes: p95, boutEnBoutMaxSecondes: p95 });
    expect(retardParJour([f('webhook', '2026-10-27T08:00:00.000Z', 0.24), f('webhook', '2026-10-27T09:00:00.000Z', 1.26), f('webhook-status', '2026-10-27T09:00:00.000Z', 90)], 'webhook'))
      .toEqual([{ date: '2026-10-27', count: 1.3 }]);
  });
});

describe('montees7Jours', () => {
  const maintenant = Date.parse('2026-10-27T12:00:00.000Z');
  it('compte les montées (une seule par épisode) et les heures à deux copies ou plus', () => {
    const h = [
      heure('2026-10-25T10:00:00.000Z', 1),
      heure('2026-10-25T11:00:00.000Z', 2, 40),
      heure('2026-10-25T12:00:00.000Z', 3, 60),
      heure('2026-10-25T13:00:00.000Z', 1),
      heure('2026-10-26T09:00:00.000Z', 2, 20),
    ];
    expect(montees7Jours(h, maintenant)).toEqual({ montees: 2, heures: 2 });
  });

  it('au-delà de sept jours, rien ne compte', () => {
    expect(montees7Jours([heure('2026-10-10T10:00:00.000Z', 3, 60)], maintenant)).toEqual({ montees: 0, heures: 0 });
  });
});
