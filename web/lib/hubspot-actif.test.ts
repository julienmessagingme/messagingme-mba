import { describe, it, expect } from 'vitest';
import { lireHubspotActif, affichageHubspotAccueil } from './hubspot-actif';

describe('lireHubspotActif', () => {
  it('rend le booléen tel quel', () => {
    expect(lireHubspotActif({ hubspotActif: true })).toBe(true);
    expect(lireHubspotActif({ hubspotActif: false })).toBe(false);
  });

  it('🔴 un champ absent ou bancal est INCONNU, jamais « éteint »', () => {
    // Une API antérieure à 0179 ne rend pas le champ : le lire « éteint » ferait disparaître le bloc d'un client
    // qui s'en sert, entre le déploiement de la console et celui de l'API.
    expect(lireHubspotActif({})).toBeUndefined();
    expect(lireHubspotActif(null)).toBeUndefined();
    expect(lireHubspotActif(undefined)).toBeUndefined();
    expect(lireHubspotActif({ hubspotActif: 'false' })).toBeUndefined();
    expect(lireHubspotActif({ hubspotActif: 0 })).toBeUndefined();
  });
});

describe('affichageHubspotAccueil', () => {
  it('🔴 allumé, SANS numéro : le bloc s’affiche (c’est tout le sujet)', () => {
    expect(affichageHubspotAccueil({ actif: true, aUnNumero: false, portailRelie: false })).toBe('bloc');
  });

  it('allumé, avec numéro : le bloc', () => {
    expect(affichageHubspotAccueil({ actif: true, aUnNumero: true, portailRelie: false })).toBe('bloc');
  });

  it('éteint, sans portail : une ligne qui renvoie vers Paramètres, numéro ou pas', () => {
    expect(affichageHubspotAccueil({ actif: false, aUnNumero: false, portailRelie: false })).toBe('renvoi');
    expect(affichageHubspotAccueil({ actif: false, aUnNumero: true, portailRelie: false })).toBe('renvoi');
  });

  it('🔴 éteint MAIS portail relié : le bloc quand même, sinon la déconnexion devient introuvable', () => {
    expect(affichageHubspotAccueil({ actif: false, aUnNumero: false, portailRelie: true })).toBe('bloc');
  });

  it('🔴 interrupteur inconnu (API plus ancienne) : le comportement d’avant, le bloc suit le numéro', () => {
    expect(affichageHubspotAccueil({ actif: undefined, aUnNumero: true, portailRelie: false })).toBe('bloc');
    expect(affichageHubspotAccueil({ actif: undefined, aUnNumero: false, portailRelie: false })).toBe('rien');
    expect(affichageHubspotAccueil({ actif: undefined, aUnNumero: false, portailRelie: true })).toBe('rien');
  });
});
