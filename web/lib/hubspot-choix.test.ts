import { describe, it, expect } from 'vitest';
import { etapeHubspot, fermeeParLOffre, phraseDeLOffre, choixParDefaut, choixActuel, corpsDuChoix, choixApresBascule } from './hubspot-choix';
import type { TenantSettings } from './api';
import type { FonctionOffre, VueOffre } from './offre';

const ENTREPRISE = new Set<FonctionOffre>(['analyse', 'crm', 'inbox']);
const PRO = new Set<FonctionOffre>(['inbox']);

describe('etapeHubspot (lot 1bis)', () => {
  it('🔴 relié et jamais validé : l’étape de choix ; validé : le réglage', () => {
    expect(etapeHubspot({ lecture: 'ok', relie: true, valideLe: null })).toBe('choisir');
    expect(etapeHubspot({ lecture: 'ok', relie: true, valideLe: '2026-10-23T18:00:00.000Z' })).toBe('regle');
  });
  it('une API antérieure (date absente) ne propose pas une étape qu’elle ne saurait pas enregistrer', () => {
    expect(etapeHubspot({ lecture: 'ok', relie: true, valideLe: undefined })).toBe('regle');
  });
  it('rien de relié : connecter ; lecture en cours ou ratée : jamais un faux « non relié »', () => {
    expect(etapeHubspot({ lecture: 'ok', relie: false, valideLe: null })).toBe('connecter');
    expect(etapeHubspot({ lecture: 'en_cours', relie: undefined, valideLe: undefined })).toBe('lecture');
    expect(etapeHubspot({ lecture: 'echec', relie: undefined, valideLe: undefined })).toBe('echec');
    expect(etapeHubspot({ lecture: 'ok', relie: undefined, valideLe: null })).toBe('echec');
  });
});

describe('fermeeParLOffre', () => {
  it('l’analyse et les listes demandent l’Entreprise, la tâche immédiate rien', () => {
    expect(fermeeParLOffre('analyse', PRO)).toBe(true);
    expect(fermeeParLOffre('listes', PRO)).toBe(true);
    expect(fermeeParLOffre('passage', PRO)).toBe(false);
    expect(fermeeParLOffre('analyse', ENTREPRISE)).toBe(false);
  });
  it('offre inconnue : rien n’est fermé ici, le serveur tranche', () => {
    expect(fermeeParLOffre('analyse', null)).toBe(false);
    expect(fermeeParLOffre('analyse', undefined)).toBe(false);
  });
});

describe('choixParDefaut (décision 2 du cadrage)', () => {
  it('🔴 coche ce qui écrit dans HubSpot, décoche ce qui ouvre une porte, et suit le mode du portail', () => {
    expect(choixParDefaut({ routingMode: 'mm_routing', fonctions: ENTREPRISE }))
      .toEqual({ analyse: true, passage: true, injoignable: true, reponse: false, modeles: false, listes: false, taches: true });
    expect(choixParDefaut({ routingMode: 'hubspot_native', fonctions: ENTREPRISE }).taches).toBe(false);
  });
  it('🔴 une fonction fermée par l’offre est décochée (le serveur refuserait de l’allumer)', () => {
    expect(choixParDefaut({ routingMode: undefined, fonctions: PRO }).analyse).toBe(false);
  });
});

describe('choixActuel', () => {
  it('lit les réglages, et un champ absent (API antérieure) prend le défaut de la migration', () => {
    const vide = {} as TenantSettings;
    expect(choixActuel(vide, undefined)).toEqual({ analyse: true, passage: true, injoignable: true, reponse: false, modeles: false, listes: false, taches: true });
    const s = { hubspotAnalyse: false, hubspotPassage: true, hubspotInjoignable: false, hubspotReponse: true, hubspotListsEnabled: true } as TenantSettings;
    expect(choixActuel(s, 'hubspot_native')).toEqual({ analyse: false, passage: true, injoignable: false, reponse: true, modeles: false, listes: true, taches: false });
  });
});

describe('les correctifs de la relecture du lot 1bis', () => {
  const choix = { analyse: true, passage: false, injoignable: true, reponse: false, modeles: false, listes: false, taches: true };
  it('🔴 « Créer des tâches » ne part QUE si on le demande (sa ligne basculée, ou la validation avec un mode connu)', () => {
    expect(corpsDuChoix(choix, { envoyerTaches: false })).toEqual({ analyse: true, passage: false, injoignable: true, reponse: false, modeles: false, listes: false });
    expect(corpsDuChoix(choix, { envoyerTaches: false })).not.toHaveProperty('taches');
    expect(corpsDuChoix(choix, { envoyerTaches: true })).toEqual(choix);
  });
  it('🟡 un espace descendu d’offre lit éteint ce que l’offre ne permet plus', () => {
    const s = { hubspotAnalyse: true, hubspotListsEnabled: true } as TenantSettings;
    expect(choixActuel(s, 'mm_routing', PRO)).toMatchObject({ analyse: false, listes: false });
    expect(choixActuel(s, 'mm_routing', ENTREPRISE)).toMatchObject({ analyse: true, listes: true });
  });
});

describe('lot 3 : « Répondre aux clients depuis HubSpot » (décision D)', () => {
  const FREE = new Set<FonctionOffre>(['aide']);
  const vue = { grille: { free: { fonctions: FREE }, pro: { fonctions: PRO }, entreprise: { fonctions: ENTREPRISE } } } as unknown as VueOffre;
  const t = (fr: string) => fr;
  it('🔴 ouverte par l’offre qui ouvre l’Inbox : Pro suffit, Free la ferme', () => {
    expect(fermeeParLOffre('reponse', PRO)).toBe(false);
    expect(fermeeParLOffre('reponse', FREE)).toBe(true);
  });
  it('éteinte par défaut, même quand l’offre l’ouvre', () => {
    expect(choixParDefaut({ routingMode: 'mm_routing', fonctions: ENTREPRISE }).reponse).toBe(false);
  });
  it('🔴 un espace descendu sous l’Inbox la lit éteinte', () => {
    const s = { hubspotReponse: true } as TenantSettings;
    expect(choixActuel(s, 'mm_routing', FREE).reponse).toBe(false);
    expect(choixActuel(s, 'mm_routing', PRO).reponse).toBe(true);
  });
  it('la raison d’une ligne fermée nomme l’offre qui l’ouvre, d’après la grille du serveur', () => {
    expect(phraseDeLOffre(vue, 'reponse', t)).toBe('Inclus dans l’offre Pro.');
    expect(phraseDeLOffre(vue, 'analyse', t)).toBe('Inclus dans l’offre Entreprise.');
    expect(phraseDeLOffre(vue, 'passage', t)).toBe('Pas dans votre offre.');
  });
});

describe('sous-lot « relancer » : « Envoyer des modèles depuis HubSpot » (décision E)', () => {
  const choix = { analyse: true, passage: true, injoignable: true, reponse: true, modeles: true, listes: false, taches: true };
  it('🔴 éteindre la réponse éteint les modèles ; basculer une autre ligne ne les touche pas', () => {
    expect(choixApresBascule(choix, 'reponse')).toMatchObject({ reponse: false, modeles: false });
    expect(choixApresBascule(choix, 'passage')).toMatchObject({ passage: false, reponse: true, modeles: true });
    expect(choixApresBascule({ ...choix, modeles: false }, 'modeles')).toMatchObject({ modeles: true });
  });
  it('🔴 lus allumés seulement avec la réponse, et l’offre qui ouvre l’Inbox ; éteints par défaut', () => {
    const s = { hubspotReponse: true, hubspotModeles: true } as TenantSettings;
    expect(choixActuel(s, 'mm_routing', PRO).modeles).toBe(true);
    expect(choixActuel({ ...s, hubspotReponse: false }, 'mm_routing', PRO).modeles).toBe(false);
    expect(choixActuel(s, 'mm_routing', new Set<FonctionOffre>(['aide'])).modeles).toBe(false);
    expect(choixParDefaut({ routingMode: 'mm_routing', fonctions: ENTREPRISE }).modeles).toBe(false);
    expect(fermeeParLOffre('modeles', PRO)).toBe(false);
  });
});
