import { describe, it, expect } from 'vitest';
import { lireHubspotActif, affichageHubspotAccueil, etatCarteHubspot } from './hubspot-actif';

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

describe('etatCarteHubspot', () => {
  it('🔴 allumé et relié : l’extinction est bloquée, pas de connexion proposée', () => {
    expect(etatCarteHubspot({ actif: true, portailRelie: true })).toEqual({ extinctionBloquee: true, proposerConnexion: false });
  });

  it('allumé et non relié : on propose de connecter', () => {
    expect(etatCarteHubspot({ actif: true, portailRelie: false })).toEqual({ extinctionBloquee: false, proposerConnexion: true });
  });

  it('éteint : rien n’est bloqué (allumer ne l’est jamais), rien n’est proposé', () => {
    expect(etatCarteHubspot({ actif: false, portailRelie: false })).toEqual({ extinctionBloquee: false, proposerConnexion: false });
    expect(etatCarteHubspot({ actif: false, portailRelie: true })).toEqual({ extinctionBloquee: false, proposerConnexion: false });
  });

  it('portail inconnu : ni blocage ni promesse', () => {
    expect(etatCarteHubspot({ actif: true, portailRelie: undefined })).toEqual({ extinctionBloquee: false, proposerConnexion: false });
  });
});
