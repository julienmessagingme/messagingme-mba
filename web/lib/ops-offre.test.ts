import { describe, it, expect } from 'vitest';
import { lireConservation, conservationPeutPurger } from './ops-offre';

/** La fenêtre « Offre Entreprise » de `/ops` : ce qu'elle envoie de la conservation, et quand elle prévient d'une purge. */
describe('la conservation saisie', () => {
  it('vide = le défaut de l’instance, un entier de 0 à 3650 passe, le reste est refusé', () => {
    expect(lireConservation('')).toBeNull();
    expect(lireConservation('  ')).toBeNull();
    expect(lireConservation('0')).toBe(0);
    expect(lireConservation(' 365 ')).toBe(365);
    expect(lireConservation('3650')).toBe(3650);
    for (const s of ['3651', '-1', '1.5', '30j', 'abc']) expect(lireConservation(s), s).toBe('invalide');
  });
});

describe('🔴 l’avertissement de purge, irréversible', () => {
  it('prévient d’un raccourcissement, et de toute durée finie quand l’actuelle est infinie ou inconnue', () => {
    expect(conservationPeutPurger(365, 30)).toBe(true);
    expect(conservationPeutPurger(0, 365)).toBe(true);
    expect(conservationPeutPurger(null, 365)).toBe(true);
    expect(conservationPeutPurger(365, null)).toBe(true);
  });

  it('se tait quand rien ne change, pour « jamais », et pour un allongement connu', () => {
    expect(conservationPeutPurger(365, 365)).toBe(false);
    expect(conservationPeutPurger(null, null)).toBe(false);
    expect(conservationPeutPurger(30, 0)).toBe(false);
    expect(conservationPeutPurger(30, 365)).toBe(false);
  });
});
