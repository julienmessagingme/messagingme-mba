import { describe, it, expect } from 'vitest';
import { FIN_DE_TOUR_MAX_MS, FIN_DE_TOUR_PAS_MS, creerAttendreFinDuTour, type DepsFinDeTour } from '../src/mba/fin-de-tour';

/**
 * Attendre que l'agent de Meta ait fini son tour avant de lui prendre le fil (expérience du 2026-09-22).
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE : la fin se lit à un NOUVEL écho de l'agent (un identifiant qui change, pas une
 * horloge), l'attente est BORNÉE, et une lecture ratée n'empêche jamais l'envoi que l'agent a annoncé.
 */
function faux(o: { echos?: Array<string | null>; leve?: boolean } = {}) {
  let t = 0;
  let lectures = 0;
  const attentes: number[] = [];
  const journal: string[] = [];
  const deps: DepsFinDeTour = {
    dernierMessageDeLAgent: async () => {
      if (o.leve) throw new Error('base indisponible');
      const suite = o.echos ?? ['e1'];
      const r = suite[Math.min(lectures, suite.length - 1)] ?? null;
      lectures += 1;
      return r;
    },
    attendre: async (ms) => { attentes.push(ms); t += ms; },
    maintenant: () => t,
    journal: (l) => { journal.push(l); },
  };
  return { attendre: creerAttendreFinDuTour(deps), attentes, journal, lectures: () => lectures };
}

describe('attendre la fin du tour de l’agent de Meta', () => {
  it('🔴 s’arrête dès que l’agent a parlé (son dernier écho CHANGE)', async () => {
    const f = faux({ echos: ['e1', 'e1', 'e1', 'e2'] });
    expect(await f.attendre('t1', 'w1')).toBe('reponse');
    expect(f.attentes).toEqual([FIN_DE_TOUR_PAS_MS, FIN_DE_TOUR_PAS_MS, FIN_DE_TOUR_PAS_MS]);
    expect(f.journal[0]).toContain('reponse');
  });

  it('🔴 un premier écho dans une conversation où l’agent n’avait rien dit compte aussi', async () => {
    const f = faux({ echos: [null, 'e1'] });
    expect(await f.attendre('t1', 'w1')).toBe('reponse');
  });

  it('🔴 BORNÉE : sans nouvel écho, rend « delai » au bout de FIN_DE_TOUR_MAX_MS, et le journal le dit', async () => {
    const f = faux({ echos: ['e1'] });
    expect(await f.attendre('t1', 'w1')).toBe('delai');
    expect(f.attentes.reduce((a, b) => a + b, 0)).toBe(FIN_DE_TOUR_MAX_MS);
    expect(f.journal[0]).toContain('delai');
  });

  it('🔴 une lecture ratée ne lève pas : l’envoi que l’agent a annoncé doit partir', async () => {
    const f = faux({ leve: true });
    expect(await f.attendre('t1', 'w1')).toBe('illisible');
  });

  it('la borne reste courte : le client attend le message que l’agent vient d’annoncer', () => {
    expect(FIN_DE_TOUR_MAX_MS).toBeLessThanOrEqual(20_000);
    expect(FIN_DE_TOUR_PAS_MS).toBeLessThan(FIN_DE_TOUR_MAX_MS);
  });
});
