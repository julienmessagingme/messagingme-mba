import { describe, it, expect } from 'vitest';
import { cockpitParJour, copiesDeLHeure, debutMesure, memoireWorkerParJour, montees7Jours, parJour, retardParJour, rolesDeMemoire } from './ops-capacite';

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

  it('🔴 un déploiement (deux copies quelques minutes) n’est pas une montée, ni sur la courbe', () => {
    const deploiement = heure('2026-10-26T09:00:00.000Z', 2, 2);
    expect(montees7Jours([heure('2026-10-26T08:00:00.000Z', 1), deploiement], maintenant)).toEqual({ montees: 0, heures: 0 });
    expect(copiesDeLHeure(deploiement)).toBe(1);
    expect(copiesDeLHeure(heure('2026-10-26T10:00:00.000Z', 3, 12))).toBe(3);
  });

  it('une heure sans mesure entre deux heures à deux copies : deux montées, pas une', () => {
    const h = [heure('2026-10-26T09:00:00.000Z', 2, 30), heure('2026-10-26T11:00:00.000Z', 2, 30)];
    expect(montees7Jours(h, maintenant)).toEqual({ montees: 2, heures: 1 });
  });
});

describe('les courbes du lot 2', () => {
  it('Cockpit : le pire de chaque jour de Paris ; une série absente ou illisible ne donne aucun point', () => {
    const pts = [{ heure: '2026-10-27T08:00:00.000Z', valeur: 6.7 }, { heure: '2026-10-27T15:00:00.000Z', valeur: 26.6 }];
    expect(cockpitParJour(pts)).toEqual([{ date: '2026-10-27', count: 26.6 }]);
    expect(cockpitParJour(null)).toEqual([]);
    expect(cockpitParJour(undefined)).toEqual([]);
  });

  it('🔴 la mémoire d’un worker en % de SA limite, son pire du jour ; une heure sans limite ne compte pas', () => {
    const m = (role: string, heure: string, maxOctets: number, limiteOctets: number | null) => ({ role, heure, maxOctets, limiteOctets });
    const pts = [
      m('principal', '2026-10-27T08:00:00.000Z', 134e6, 1e9),
      m('principal', '2026-10-27T09:00:00.000Z', 700e6, 1e9),
      m('analyse', '2026-10-27T09:00:00.000Z', 900e6, null),
    ];
    expect(rolesDeMemoire(pts)).toEqual(['analyse', 'principal']);
    expect(memoireWorkerParJour(pts, 'principal')).toEqual([{ date: '2026-10-27', count: 70 }]);
    expect(memoireWorkerParJour(pts, 'analyse')).toEqual([]);
  });
});

describe('debutMesure', () => {
  it('🔴 le graphique commence au premier jour mesuré, jamais avant sa fenêtre ; sans mesure, la fenêtre', () => {
    const s = (...dates: string[]) => ({ points: dates.map((date) => ({ date, count: 1 })) });
    expect(debutMesure([s('2026-10-20', '2026-10-15'), s('2026-10-17')], '2026-09-29')).toBe('2026-10-15');
    expect(debutMesure([s('2026-09-01')], '2026-09-29')).toBe('2026-09-29');
    expect(debutMesure([s()], '2026-09-29')).toBe('2026-09-29');
  });
});
