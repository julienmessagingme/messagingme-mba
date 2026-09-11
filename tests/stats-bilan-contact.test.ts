import { describe, it, expect } from 'vitest';
import { estimerCoutContact, entonnoirEngagement, NIVEAUX_MONTRES, chiffrer } from '../src/stats/cost';

/**
 * LE BILAN D'UN CONTACT : ce qu'il a coûté, et jusqu'où il est allé (demande de Julien, 2026-09-11).
 *
 * 🔴 LA RÈGLE DE CHIFFRAGE EST PARTAGÉE AVEC LES DEUX AUTRES ÉCRANS, et c'est le point : un client qui
 * compare le coût d'un contact au coût de la campagne qui le lui a envoyé doit retrouver la même
 * arithmétique. Deux définitions de « chiffrable » donneraient deux totaux, et c'est lui qui les comparerait.
 */

const TARIFS = { marketing: 0.1, utility: 0.02, currency: 'EUR' };

describe('Ce qu’un contact a coûté', () => {
  it('somme les envois par catégorie au tarif Meta', () => {
    const r = estimerCoutContact([{ category: 'marketing', count: 3 }, { category: 'utility', count: 2 }], TARIFS);
    expect(r).toEqual({ envoyes: 5, cout: 0.34, nonChiffrables: 0, sansCategorie: 0, sansTarif: 0, currency: 'EUR' });
  });

  it('🔴 AUCUN envoi chiffrable rend `null`, jamais `0`', () => {
    // Un zéro se lirait « ce contact ne nous a rien coûté », alors que la vérité est « on ne sait pas ce
    // qu'il a coûté ». C'est exactement la distinction que les deux autres écrans tiennent déjà.
    const r = estimerCoutContact([{ category: null, count: 4 }], TARIFS);
    expect(r.cout).toBeNull();
    expect(r).toMatchObject({ envoyes: 4, nonChiffrables: 4, sansCategorie: 4, sansTarif: 0 });
  });

  it('🔴 les DEUX causes de non-chiffrage se comptent à part', () => {
    // Elles ne se réparent pas pareil : une catégorie absente est un héritage définitif, un tarif manquant
    // est une panne du jour. Un seul nombre les confondrait, et l'écran ne pourrait dire ni l'un ni l'autre.
    const r = estimerCoutContact(
      [{ category: null, count: 2 }, { category: 'utility', count: 3 }, { category: 'marketing', count: 1 }],
      { marketing: 0.1, utility: null, currency: 'EUR' },
    );
    expect(r).toMatchObject({ envoyes: 6, cout: 0.1, sansCategorie: 2, sansTarif: 3, nonChiffrables: 5 });
  });

  it('la règle de chiffrage est CELLE des autres écrans', () => {
    // Garde du point de passage unique : si `chiffrer` change, les trois écrans changent ensemble.
    expect(chiffrer('marketing', TARIFS)).toEqual({ tarif: 0.1 });
    expect(chiffrer('service', TARIFS)).toEqual({ refus: 'sansCategorie' });
    expect(chiffrer('utility', { marketing: 0.1, utility: null })).toEqual({ refus: 'sansTarif' });
  });
});

describe('L’entonnoir d’engagement d’un contact', () => {
  it('🔴 il est CUMULÉ : « au moins N », pas « exactement N »', () => {
    // Quelqu'un qui est allé jusqu'au troisième message a forcément réagi au premier et au deuxième, un
    // scénario n'avançant QUE sur une réaction. Compter « exactement » ferait disparaître du niveau 1 les
    // contacts les plus engagés, et rendrait une suite non décroissante, illisible comme entonnoir.
    expect(entonnoirEngagement([1, 1, 2, 3])).toEqual([
      { niveau: 1, parcours: 4 },
      { niveau: 2, parcours: 2 },
      { niveau: 3, parcours: 1 },
      { niveau: 4, parcours: 0 },
      { niveau: 5, parcours: 0 },
    ]);
  });

  it('🔴 le dernier niveau RAMASSE ce qui est plus profond', () => {
    // Tronquer ferait sortir de l'entonnoir le parcours le plus engagé, et le total du dernier niveau serait
    // faux VERS LE BAS, c'est-à-dire du mauvais côté.
    const r = entonnoirEngagement([9, 7, 1]);
    expect(r[NIVEAUX_MONTRES - 1]).toEqual({ niveau: 5, parcours: 2 });
  });

  it('aucun engagement du tout : l’entonnoir est VIDE, pas une colonne de zéros', () => {
    // Cinq zéros alignés donnent l'air d'une mesure ratée. Rien du tout laisse l'écran ne rien afficher.
    expect(entonnoirEngagement([])).toEqual([]);
    expect(entonnoirEngagement([0, 0])).toEqual([]);
  });
});
