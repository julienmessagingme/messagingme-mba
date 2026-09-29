import { describe, it, expect } from 'vitest';
import { calculerPerformance, centile, lirePerformance, type DemandeBrute, type Qui } from '../src/stats/performance';
import type { BusinessHours } from '../src/workflow/conditions';

/**
 * QUANTITATIF > PERFORMANCE : le calcul, sans base. Ce que la base rend (qui ouvre une demande, qui la ferme, quelle
 * réponse compte) : `tests/integration/performance.integration.test.ts`, en CI.
 *
 * 🔴 CE QUE CES CAS PROTÈGENT : un chiffre sur lequel un client jugera son équipe. Une médiane de rien affichée à
 * zéro dirait « répond instantanément » ; une clôture automatique attribuée à quelqu'un lui prêterait un travail
 * qu'il n'a pas fait ; une nuit comptée ferait paraître lente l'équipe qui ouvre à 9 h.
 */
const TZ = 'Europe/Paris';
const MIN = 60_000;
const jour = (open: string, close: string) => ({ closed: false, open, close });
const FERME = { closed: true, open: '09:00', close: '18:00' };
const SEMAINE: BusinessHours = {
  '0': FERME, '6': FERME,
  '1': jour('09:00', '18:00'), '2': jour('09:00', '18:00'), '3': jour('09:00', '18:00'),
  '4': jour('09:00', '18:00'), '5': jour('09:00', '18:00'),
};
/** Un instant lu à Paris, en heure d'été : `paris('2026-09-08 10:00')`. */
const paris = (mural: string): Date => new Date(`${mural.replace(' ', 'T')}:00+02:00`);

const MARIE: Qui = { genre: 'collaborateur', userId: 'u-marie', nom: 'Marie' };
const JEAN: Qui = { genre: 'collaborateur', userId: 'u-jean', nom: 'Jean' };
const AUTO: Qui = { genre: 'automatique' };
const ANCIEN: Qui = { genre: 'ancien' };

let n = 0;
/** Une demande ouverte à `ouverte`, avec sa réponse et sa fin optionnelles. */
function demande(ouverte: string, o: { repondu?: [string, Qui]; close?: [string, Qui] } = {}): DemandeBrute {
  n += 1;
  return {
    conversationId: `cv${n}`,
    ouverteLe: paris(ouverte),
    jour: ouverte.slice(0, 10),
    reponduLe: o.repondu ? paris(o.repondu[0]) : null,
    repondant: o.repondu ? o.repondu[1] : null,
    closeLe: o.close ? paris(o.close[0]) : null,
    closePar: o.close ? o.close[1] : null,
  };
}

const ctx = { fuseau: TZ, horaires: SEMAINE, mesureDepuis: new Date('2026-09-01T00:00:00Z') };

describe('centile', () => {
  it('🔴 aucune valeur : null, jamais 0', () => {
    expect(centile([], 0.5)).toBeNull();
    expect(centile([], 0.9)).toBeNull();
  });

  it('interpole entre les deux rangs voisins (percentile_cont), sans dépendre de l’ordre reçu', () => {
    expect(centile([10], 0.5)).toBe(10);
    expect(centile([30, 10, 20], 0.5)).toBe(20);
    expect(centile([10, 20, 30, 40], 0.5)).toBe(25);
    // Rang (n - 1) * 0,9 = 8,1 sur dix valeurs : 90 + 0,1 * (100 - 90).
    expect(centile([100, 90, 80, 70, 60, 50, 40, 30, 20, 10], 0.9)).toBe(91);
  });
});

describe('calculerPerformance', () => {
  it('🔴 sans aucune demande : des compteurs à zéro, et des temps INCONNUS (null), pas nuls', () => {
    const p = calculerPerformance([], ctx);
    expect(p.reponse).toEqual({ mediane: null, p90: null, n: 0 });
    expect(p.resolution).toEqual({ mediane: null, p90: null, n: 0 });
    expect([p.demandes, p.resolues, p.resoluesSansReponse, p.ouvertes]).toEqual([0, 0, 0, 0]);
    expect(p.plusAncienneOuverte).toBeNull();
    expect(p.parJour).toEqual([]);
    expect(p.parCollaborateur).toEqual([]);
    expect(p.mesureDepuis).toBe('2026-09-01T00:00:00.000Z');
  });

  it('🔴 la réponse à celui qui a répondu le PREMIER, la résolution à celui qui a CLOS', () => {
    const p = calculerPerformance([
      demande('2026-09-08 10:00', { repondu: ['2026-09-08 10:04', MARIE], close: ['2026-09-08 10:30', JEAN] }),
    ], ctx);
    expect(p.reponse.mediane).toBe(4 * MIN);
    expect(p.resolution.mediane).toBe(30 * MIN);
    expect(p.parCollaborateur).toEqual([
      { qui: JEAN, reponses: 0, reponseMediane: null, closes: 1, resolutionMediane: 30 * MIN },
      { qui: MARIE, reponses: 1, reponseMediane: 4 * MIN, closes: 0, resolutionMediane: null },
    ]);
  });

  it('🔴 une demande close SANS réponse est comptée à part, et n’entre PAS dans le temps de résolution', () => {
    // Le balayage qui rend le fil au scénario au bout de deux heures ne mesure rien de l'équipe : le compter tirerait
    // la médiane de résolution vers son délai.
    const p = calculerPerformance([
      demande('2026-09-08 10:00', { close: ['2026-09-08 12:00', AUTO] }),
      demande('2026-09-08 11:00', { repondu: ['2026-09-08 11:02', MARIE], close: ['2026-09-08 11:10', MARIE] }),
    ], ctx);
    expect(p.resoluesSansReponse).toBe(1);
    expect(p.resolues).toBe(1);
    expect(p.resolution).toEqual({ mediane: 10 * MIN, p90: 10 * MIN, n: 1 });
    // La clôture automatique sans réponse n'apparaît dans aucune ligne : ce n'est un travail de personne.
    expect(p.parCollaborateur.map((l) => l.qui)).toEqual([MARIE]);
  });

  it('une clôture automatique après une réponse va dans la ligne « automatique », un compte supprimé dans « ancien »', () => {
    const p = calculerPerformance([
      demande('2026-09-08 10:00', { repondu: ['2026-09-08 10:05', MARIE], close: ['2026-09-08 12:05', AUTO] }),
      demande('2026-09-08 14:00', { repondu: ['2026-09-08 14:01', ANCIEN], close: ['2026-09-08 14:20', ANCIEN] }),
    ], ctx);
    // Les collaborateurs d'abord, puis les anciens, puis l'automatique.
    expect(p.parCollaborateur.map((l) => [l.qui.genre, l.reponses, l.closes])).toEqual([
      ['collaborateur', 1, 0],
      ['ancien', 1, 1],
      ['automatique', 0, 1],
    ]);
  });

  it('🔴 les encore ouvertes : comptées, la plus ancienne datée, et une réponse ne les ferme pas', () => {
    const p = calculerPerformance([
      demande('2026-09-09 10:00'),
      demande('2026-09-08 16:00', { repondu: ['2026-09-08 16:30', MARIE] }),
      demande('2026-09-08 11:00', { repondu: ['2026-09-08 11:10', MARIE], close: ['2026-09-08 11:20', MARIE] }),
    ], ctx);
    expect(p.ouvertes).toBe(2);
    expect(p.plusAncienneOuverte).toBe(paris('2026-09-08 16:00').toISOString());
    // La réponse d'une demande encore ouverte compte dans le temps de réponse.
    expect(p.reponse.n).toBe(2);
    expect(p.demandes).toBe(p.resolues + p.resoluesSansReponse + p.ouvertes);
  });

  it('🔴 en heures d’OUVERTURE : la nuit et le week-end ne comptent pas, et l’écran sait qu’on compte ainsi', () => {
    const vendrediSoir = demande('2026-09-11 17:50', { repondu: ['2026-09-14 09:05', MARIE], close: ['2026-09-14 09:30', MARIE] });
    const ouvre = calculerPerformance([vendrediSoir], ctx);
    expect(ouvre.mode).toBe('ouvre');
    expect(ouvre.reponse.mediane).toBe(15 * MIN);
    expect(ouvre.resolution.mediane).toBe(40 * MIN);
    // Sans horaires exploitables : le temps BRUT, et le mode le dit.
    const brut = calculerPerformance([vendrediSoir], { ...ctx, horaires: null });
    expect(brut.mode).toBe('brut');
    expect(brut.reponse.mediane).toBe(paris('2026-09-14 09:05').getTime() - paris('2026-09-11 17:50').getTime());
  });

  it('une ligne par jour d’ouverture, dans l’ordre, avec ses deux médianes', () => {
    const p = calculerPerformance([
      demande('2026-09-09 10:00', { repondu: ['2026-09-09 10:10', MARIE] }),
      demande('2026-09-08 10:00', { repondu: ['2026-09-08 10:02', MARIE], close: ['2026-09-08 10:30', MARIE] }),
      demande('2026-09-08 11:00', { repondu: ['2026-09-08 11:06', JEAN], close: ['2026-09-08 11:50', JEAN] }),
    ], ctx);
    expect(p.parJour).toEqual([
      { jour: '2026-09-08', demandes: 2, reponseMediane: 4 * MIN, resolutionMediane: 40 * MIN },
      // Aucune demande résolue ce jour-là : une médiane inconnue, pas zéro.
      { jour: '2026-09-09', demandes: 1, reponseMediane: 10 * MIN, resolutionMediane: null },
    ]);
  });

  it('la lecture passe l’espace et la période à la base, et les horaires de CET espace au calcul', async () => {
    const vus: unknown[] = [];
    const p = await lirePerformance({
      demandes: async (t, r) => { vus.push(['demandes', t, r]); return { mesureDepuis: null, demandes: [demande('2026-09-08 10:00', { repondu: ['2026-09-08 10:03', MARIE] })] }; },
      reglages: async (t) => { vus.push(['reglages', t]); return { timezone: TZ, businessHours: SEMAINE }; },
    }, 't1', { from: '2026-09-01', to: '2026-09-30' });
    expect(vus).toEqual([['demandes', 't1', { from: '2026-09-01', to: '2026-09-30' }], ['reglages', 't1']]);
    expect(p.reponse.mediane).toBe(3 * MIN);
    expect(p.mesureDepuis).toBeNull();
  });
});
