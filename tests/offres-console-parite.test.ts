import { describe, it, expect } from 'vitest';
import { FONCTIONS, DROITS } from '../src/offres/offres';
import { grilleDesOffres } from '../src/offres/vue';
import { FONCTIONS_OFFRE, LIMITES_NOMBRE, LIMITES_TOLERANTES, NOMS_OFFRES, lireVueOffre } from '../web/lib/offre';

/**
 * LES NOMS DE L'OFFRE RECOPIÉS DANS LA CONSOLE (lot 6, tâche 7), qui ne peut pas importer le serveur. Les VALEURS de la
 * grille ne le sont jamais (elles arrivent par la route de l'offre) ; les NOMS doivent rester alignés, sinon un écran
 * grisé ne se rouvrirait jamais, ou une vue neuve serait lue comme illisible, donc tout ouvert, en silence.
 */
describe('la console et le serveur nomment l’offre de la même façon', () => {
  it('les fonctions, dans le même ordre', () => {
    expect([...FONCTIONS_OFFRE]).toEqual([...FONCTIONS]);
  });

  it('les offres de la grille', () => {
    expect([...NOMS_OFFRES]).toEqual(Object.keys(grilleDesOffres()));
  });

  it('🔴 les limites : chaque clé que la vue du serveur montre est lue, et la grille réelle passe la validation de la console', () => {
    // La vue ne montre jamais la commission (spec Business) : la console ne la lit donc plus.
    const cles = Object.keys(grilleDesOffres().free.limites).sort();
    expect(cles).not.toContain('commissionPct');
    expect([...LIMITES_NOMBRE, ...LIMITES_TOLERANTES, 'conservationJours', 'badge', 'numeroInclus'].sort()).toEqual(cles);
    const lue = lireVueOffre(JSON.parse(JSON.stringify(vueDe('free', grilleDesOffres()))));
    expect(lue).not.toBeNull();
    expect([...lue!.grille.entreprise.fonctions]).toEqual([...FONCTIONS]);
    expect([...lue!.grille.business!.fonctions]).toEqual(FONCTIONS.filter((f) => DROITS.business.fonctions.has(f)));
  });

  it('🔴 la vue d’un espace Business se lit', () => {
    const lue = lireVueOffre(JSON.parse(JSON.stringify(vueDe('business', grilleDesOffres()))));
    expect(lue?.offre).toBe('business');
  });

  it('🔴 une API d’avant le Business (la console est publiée avant elle) reste lisible : sans ligne Business, avec la commission', () => {
    const { business: _business, ...grille } = grilleDesOffres();
    const ancienne = { ...grille, free: { ...grille.free, limites: { ...grille.free.limites, commissionPct: 100 } } };
    const lue = lireVueOffre(JSON.parse(JSON.stringify({
      ...vueDe('free', ancienne), limites: { ...DROITS.base.limites },
    })));
    expect(lue).not.toBeNull();
    expect(lue!.grille.business).toBeUndefined();
    expect([...lue!.grille.entreprise.fonctions]).toEqual([...FONCTIONS]);
  });
});

/** Une vue minimale, telle que la route de l'offre la rend, sur une grille donnée. */
function vueDe(offre: string, grille: object) {
  const { commissionPct: _marge, ...limites } = DROITS.base.limites;
  return {
    offre, fonctions: [], limites,
    usage: { envoisModelesMois: 0, contacts: 0, automations: 0, membres: 1 }, grille, upgradeUrl: 'https://x/offre',
  };
}
