import { describe, it, expect } from 'vitest';
import {
  demandeConfirmation, ligneNumero, ligneRcs, ligneChaine, lignePublicites, ligneHubspot, nombreDePublications, routeInconnue, type Geste,
} from './canaux-services';

describe('ligneNumero', () => {
  it('relié : allumé, l’éteindre le délie', () => {
    expect(ligneNumero({ compte: { hasNumber: true, delieLe: null }, connexionDisponible: true })).toEqual({ allume: true, geste: 'delier_numero' });
  });

  it('🔴 délié : éteint, le rallumer le RELIE d’un clic (jamais la fenêtre Meta)', () => {
    expect(ligneNumero({ compte: { hasNumber: true, delieLe: '2026-09-25T10:00:00.000Z' }, connexionDisponible: true }))
      .toEqual({ allume: false, geste: 'relier_numero' });
  });

  it('aucun numéro : le rallumer ouvre la connexion, si elle est disponible sur cette instance', () => {
    expect(ligneNumero({ compte: { hasNumber: false }, connexionDisponible: true })).toEqual({ allume: false, geste: 'connecter_numero' });
    expect(ligneNumero({ compte: { hasNumber: false }, connexionDisponible: false })).toEqual({ allume: false, geste: null });
  });

  it('🔴 `delieLe` absent (API plus ancienne) : relié, ce qu’il était forcément', () => {
    expect(ligneNumero({ compte: { hasNumber: true }, connexionDisponible: false })).toEqual({ allume: true, geste: 'delier_numero' });
  });

  it('statut pas encore lu, ou illisible : pas d’interrupteur', () => {
    expect(ligneNumero({ compte: null, connexionDisponible: true })).toEqual({ allume: null, geste: null });
  });
});

describe('ligneRcs', () => {
  it('actif : l’éteindre le coupe ; inactif : le rallumer ouvre l’activation', () => {
    expect(ligneRcs({ active: true })).toEqual({ allume: true, geste: 'couper_rcs' });
    expect(ligneRcs({ active: false })).toEqual({ allume: false, geste: 'activer_rcs' });
  });
  it('pas encore lu : pas d’interrupteur', () => {
    expect(ligneRcs(null)).toEqual({ allume: null, geste: null });
  });
});

describe('ligneChaine', () => {
  it('branchée : l’éteindre la débranche ; débranchée : le rallumer ouvre l’écran Chaîne', () => {
    expect(ligneChaine({ connection: { orgId: 'o' } })).toEqual({ allume: true, geste: 'debrancher_chaine' });
    expect(ligneChaine({ connection: null })).toEqual({ allume: false, geste: 'ouvrir_chaine' });
  });
  it('🔴 une réponse sans la clé `connection` ne dit RIEN : pas un « débranchée » inventé', () => {
    expect(ligneChaine({})).toEqual({ allume: null, geste: null });
    expect(ligneChaine(null)).toEqual({ allume: null, geste: null });
  });
});

describe('lignePublicites', () => {
  it('connecté : l’éteindre le déconnecte ; sinon le rallumer ouvre l’écran Publicités', () => {
    expect(lignePublicites({ configure: true, connexion: { comptePubId: 'act_1' } })).toEqual({ allume: true, geste: 'deconnecter_publicites' });
    expect(lignePublicites({ configure: true, connexion: null })).toEqual({ allume: false, geste: 'ouvrir_publicites' });
  });
  it('🔴 route absente, fonctionnalité non configurée, ou réponse vide : pas d’interrupteur', () => {
    expect(lignePublicites('absent')).toEqual({ allume: null, geste: null });
    expect(lignePublicites({ configure: false, connexion: null })).toEqual({ allume: null, geste: null });
    expect(lignePublicites({})).toEqual({ allume: null, geste: null });
    expect(lignePublicites(null)).toEqual({ allume: null, geste: null });
  });
});

describe('ligneHubspot', () => {
  it('éteint : le rallumer l’allume ; allumé sans portail : l’éteindre l’éteint', () => {
    expect(ligneHubspot({ actif: false, portailRelie: false })).toEqual({ allume: false, geste: 'allumer_hubspot' });
    expect(ligneHubspot({ actif: true, portailRelie: false })).toEqual({ allume: true, geste: 'eteindre_hubspot' });
  });
  it('🔴 allumé AVEC un portail relié : extinction refusée, comme le serveur (409)', () => {
    expect(ligneHubspot({ actif: true, portailRelie: true })).toEqual({ allume: true, geste: null });
  });
  it('réglage inconnu (API plus ancienne) : pas d’interrupteur', () => {
    expect(ligneHubspot({ actif: undefined, portailRelie: true })).toEqual({ allume: null, geste: null });
  });
});

describe('demandeConfirmation', () => {
  it('🔴 éteindre se confirme, rallumer jamais', () => {
    const eteindre: Geste[] = ['delier_numero', 'couper_rcs', 'debrancher_chaine', 'deconnecter_publicites', 'eteindre_hubspot'];
    const allumer: Geste[] = ['relier_numero', 'connecter_numero', 'activer_rcs', 'ouvrir_chaine', 'ouvrir_publicites', 'allumer_hubspot'];
    for (const g of eteindre) expect(demandeConfirmation(g), g).toBe(true);
    for (const g of allumer) expect(demandeConfirmation(g), g).toBe(false);
  });
});

describe('routeInconnue', () => {
  it('🔴 le 404 du ROUTEUR (API plus ancienne) se reconnaît ; un 404 écrit par la route, non', () => {
    expect(routeInconnue({ status: 404, corps: { message: 'Route POST:/x not found', error: 'Not Found', statusCode: 404 } })).toBe(true);
    expect(routeInconnue({ status: 404, corps: { error: 'aucun numéro rattaché à cet espace' } })).toBe(false);
    expect(routeInconnue({ status: 409, corps: { error: 'Not Found' } })).toBe(false);
    expect(routeInconnue(new Error('réseau'))).toBe(false);
    expect(routeInconnue(null)).toBe(false);
  });
});

describe('nombreDePublications', () => {
  it('compte ce qui est servi, et ne transforme pas une réponse bancale en zéro', () => {
    expect(nombreDePublications({ posts: [{}, {}] })).toBe(2);
    expect(nombreDePublications({ posts: [] })).toBe(0);
    expect(nombreDePublications({})).toBeNull();
    expect(nombreDePublications(null)).toBeNull();
  });
});
