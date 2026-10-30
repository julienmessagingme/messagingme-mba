import { describe, it, expect } from 'vitest';
import { lireConservation, conservationPeutPurger, lireContactsEntreprise, lireCommissionEntreprise, lireCommissionMessages, lireUtilisateursBusiness, retraitCoupeLeNumero } from './ops-offre';

/** Les réglages de devis d'une Entreprise (spec offres v2) : vide = le défaut, sinon un entier dans ses bornes. */
describe('les contacts et la commission saisis', () => {
  it('contacts : vide = sans limite, un entier de 1 à 100 000 000 passe, le reste est refusé', () => {
    expect(lireContactsEntreprise('')).toBeNull();
    expect(lireContactsEntreprise(' 20000 ')).toBe(20000);
    for (const s of ['0', '-5', '2.5', '100000001', 'beaucoup']) expect(lireContactsEntreprise(s), s).toBe('invalide');
  });

  it('commission : vide = 10 %, un entier de 0 à 100 passe, une décimale ou plus de 100 est refusée', () => {
    expect(lireCommissionEntreprise('')).toBeNull();
    expect(lireCommissionEntreprise('0')).toBe(0);
    expect(lireCommissionEntreprise(' 7 ')).toBe(7);
    for (const s of ['7.5', '7,5', '101', '-1', 'dix']) expect(lireCommissionEntreprise(s), s).toBe('invalide');
  });
});

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

/** Le Business posé à la main (spec Business) : sa limite d'utilisateurs, et le retrait qui coupe le numéro fourni. */
describe('le Business dans /ops', () => {
  it('utilisateurs : vide = les cinq de la grille, un entier de 1 à 10 000 passe, le reste est refusé', () => {
    expect(lireUtilisateursBusiness('')).toBeNull();
    expect(lireUtilisateursBusiness(' 7 ')).toBe(7);
    for (const s of ['0', '10001', '2.5', 'six']) expect(lireUtilisateursBusiness(s), s).toBe('invalide');
  });

  it('🔴 le retrait d’une offre posée à la main coupe le numéro fourni quand rien d’autre ne le couvre, et seulement alors', () => {
    const rien = { entreprise: false, business: false };
    expect(retraitCoupeLeNumero({ entreprise: false, business: true }, rien, true)).toBe(true);
    expect(retraitCoupeLeNumero({ entreprise: true, business: false }, rien, true)).toBe(true);
    // Le Business remplace l'Entreprise : le numéro reste couvert.
    expect(retraitCoupeLeNumero({ entreprise: true, business: false }, { entreprise: false, business: true }, true)).toBe(false);
    // Aucun numéro sans couverture, ou rien de posé avant : rien à confirmer.
    expect(retraitCoupeLeNumero({ entreprise: false, business: true }, rien, false)).toBe(false);
    expect(retraitCoupeLeNumero(rien, rien, true)).toBe(false);
  });
});

/** La commission des messages WhatsApp d'une Entreprise (plan du Crédit WhatsApp, tâche 8) : vide = la globale. */
describe('la commission des messages saisie', () => {
  it('vide = la commission globale, un entier de 0 à 100 passe, une décimale ou plus de 100 est refusée', () => {
    expect(lireCommissionMessages('')).toBeNull();
    expect(lireCommissionMessages('0')).toBe(0);
    expect(lireCommissionMessages(' 3 ')).toBe(3);
    for (const s of ['2.5', '2,5', '101', '-1', 'trois']) expect(lireCommissionMessages(s), s).toBe('invalide');
  });
});
