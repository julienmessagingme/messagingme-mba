import { describe, it, expect } from 'vitest';
import { enChamps, depuisChamps } from './grille-saisie';

const G = {
  margeTemplate: 100, serviceCentimes: 2.48, serviceFranchise: 1000,
  serviceDepuis: '2026-10-01', rcsSimpleCentimes: 6, rcsConversationnelCentimes: 8,
};

describe('la saisie d une grille de prix reste du TEXTE tant qu on tape', () => {
  it('aller-retour sans modification', () => {
    expect(depuisChamps(enChamps(G))).toEqual(G);
  });

  /**
   * 🔴 LE CAS QUI A CASSE L ECRAN. Avec une conversion a chaque frappe, `Number('3.')` vaut 3, le point est
   * reecrit hors du champ et disparait : on ne peut JAMAIS ecrire une decimale. Ici le texte survit.
   */
  it('🔴 un point decimal en cours de frappe survit', () => {
    const c = { ...enChamps(G), serviceCentimes: '3.' };
    expect(c.serviceCentimes, 'le champ garde ce qui a ete tape').toBe('3.');
    expect(depuisChamps(c).serviceCentimes, 'et « 3. » vaut bien 3 a l enregistrement').toBe(3);
  });

  /**
   * 🔴 L AUTRE MOITIE DU MEME DEFAUT : vider un champ donnait `Number('') === 0`, donc le champ se
   * remplissait tout seul d un zero. Zero est un prix VALIDE, donc l enregistrer a la place d un oubli est
   * pire qu un refus : le client ne saurait jamais que sa saisie a ete completee a sa place.
   */
  it('🔴 un champ VIDE ne devient pas zero, il devient refusable', () => {
    const v = depuisChamps({ ...enChamps(G), serviceCentimes: '' });
    expect(Number.isNaN(v.serviceCentimes), 'NaN, que le serveur refuse en nommant le champ').toBe(true);
    expect(v.serviceCentimes).not.toBe(0);
  });

  it('la virgule francaise est acceptee, c est celle que les clients tapent', () => {
    expect(depuisChamps({ ...enChamps(G), serviceCentimes: '2,48' }).serviceCentimes).toBe(2.48);
    // ⚠️ Ce module TRADUIT la saisie, il ne decide pas des bornes : deux endroits qui decideraient des
    // bornes finiraient par ne plus decider la meme chose. C est le serveur qui tranche, et il accepte
    // 120,5 depuis que la colonne de la marge a ete elargie a deux decimales.
    expect(depuisChamps({ ...enChamps(G), margeTemplate: '120,5' }).margeTemplate).toBe(120.5);
  });

  it('une saisie qui n est pas un nombre devient NaN, jamais une valeur plausible', () => {
    for (const mauvais of ['abc', '1.2.3', '--5']) {
      expect(Number.isNaN(depuisChamps({ ...enChamps(G), rcsSimpleCentimes: mauvais }).rcsSimpleCentimes),
        `${mauvais} doit devenir NaN`).toBe(true);
    }
  });

  it('la date traverse en texte, sans conversion', () => {
    expect(depuisChamps({ ...enChamps(G), serviceDepuis: '2026-11-01' }).serviceDepuis).toBe('2026-11-01');
    expect(depuisChamps({}).serviceDepuis, 'un champ absent ne devient pas « undefined »').toBe('');
  });

  it('les espaces autour d une valeur ne la cassent pas', () => {
    expect(depuisChamps({ ...enChamps(G), serviceFranchise: ' 500 ' }).serviceFranchise).toBe(500);
  });
});
