import { describe, it, expect } from 'vitest';
import { FONCTIONS, DROITS } from '../src/offres/offres';
import { grilleDesOffres } from '../src/offres/vue';
import { FONCTIONS_OFFRE, LIMITES_NOMBRE, NOMS_OFFRES, lireVueOffre } from '../web/lib/offre';

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

  it('🔴 les limites : chaque clé du serveur est lue, et la grille réelle passe la validation de la console', () => {
    const cles = Object.keys(DROITS.base.limites).sort();
    expect([...LIMITES_NOMBRE, 'conservationJours', 'commissionPct', 'badge', 'numeroInclus'].sort()).toEqual(cles);
    const vue = {
      offre: 'free', fonctions: [], limites: { ...DROITS.base.limites },
      usage: { envoisModelesMois: 0, contacts: 0, automations: 0, membres: 1 }, grille: grilleDesOffres(), upgradeUrl: 'https://x/offre',
    };
    const lue = lireVueOffre(JSON.parse(JSON.stringify(vue)));
    expect(lue).not.toBeNull();
    expect([...lue!.grille.entreprise.fonctions]).toEqual([...FONCTIONS]);
  });
});
