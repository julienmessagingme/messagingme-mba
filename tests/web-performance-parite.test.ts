import { describe, it, expect } from 'vitest';
import { calculerPerformance, type DemandeBrute, type Performance as PerformanceServeur, type Qui } from '../src/stats/performance';
import { lirePerformance, type Performance as PerformanceEcran } from '../web/lib/performance';

/**
 * Quantitatif > Performance : la console lit `GET /tenants/:tenantId/stats/performance` avec SA copie du type
 * (`web/lib/performance.ts`, qui ne peut pas importer `src/`) et une validation qui écarte ce qu'elle ne reconnaît pas.
 * Un champ renommé d'un seul côté ne casserait rien d'autre : l'écran dirait « pas lisible » pour un champ requis
 * disparu, ou ignorerait en silence un champ neuf.
 *
 * La parité se vérifie donc sur une VRAIE réponse du calcul du serveur, passée par JSON comme sur le réseau, où chaque
 * champ porte une valeur (aucun `null` qui passerait sans avoir été lu, et les trois genres de `Qui`) : ce que l'écran
 * en relit doit être exactement ce que le serveur a rendu.
 */
const paris = (mural: string): Date => new Date(`${mural.replace(' ', 'T')}:00+02:00`);
const MARIE: Qui = { genre: 'collaborateur', userId: 'u-marie', nom: 'Marie' };

function demande(debut: string, o: Partial<DemandeBrute> = {}): DemandeBrute {
  return {
    conversationId: `cv-${debut}`, debutLe: paris(debut), jour: debut.slice(0, 10), dansLaPeriode: true,
    reponduLe: null, repondant: null, derniereReponseLe: null, closeLe: null, closePar: null, ...o,
  };
}

const serveur: PerformanceServeur = calculerPerformance([
  demande('2026-09-08 10:00', {
    reponduLe: paris('2026-09-08 10:04'), repondant: MARIE, derniereReponseLe: paris('2026-09-08 10:04'),
    closeLe: paris('2026-09-08 10:30'), closePar: MARIE,
  }),
  demande('2026-09-08 11:00', {
    reponduLe: paris('2026-09-08 11:02'), repondant: { genre: 'ancien' }, derniereReponseLe: paris('2026-09-08 11:20'),
    closeLe: paris('2026-09-08 13:20'), closePar: { genre: 'automatique' },
  }),
  demande('2026-09-09 09:30'),
], {
  fuseau: 'Europe/Paris',
  horaires: { '1': { closed: false, open: '09:00', close: '18:00' }, '2': { closed: false, open: '09:00', close: '18:00' }, '3': { closed: false, open: '09:00', close: '18:00' } },
  mesureDepuis: new Date('2026-09-01T00:00:00Z'),
});

describe('Quantitatif > Performance : l’écran relit exactement ce que le serveur rend', () => {
  it('le jeu d’essai remplit chaque champ : sinon la parité ne prouverait rien', () => {
    expect(serveur.reponse.mediane).not.toBeNull();
    expect(serveur.resolution.p90).not.toBeNull();
    expect(serveur.plusAncienneOuverte).not.toBeNull();
    expect(serveur.parJour.some((j) => j.reponseMediane !== null && j.resolutionMediane !== null)).toBe(true);
    expect(serveur.parCollaborateur.map((l) => l.qui.genre).sort()).toEqual(['ancien', 'automatique', 'collaborateur']);
  });

  it('🔴 aller-retour par JSON : ni champ perdu, ni champ renommé, ni champ ajouté d’un seul côté', () => {
    expect(lirePerformance(JSON.parse(JSON.stringify(serveur)))).toEqual(serveur);
  });

  it('les deux types s’assignent l’un à l’autre, à la compilation (`npm run typecheck` couvre `tests/`)', () => {
    const ecran: PerformanceEcran = serveur;
    const retour: PerformanceServeur = ecran;
    expect(retour).toBe(serveur);
  });
});
