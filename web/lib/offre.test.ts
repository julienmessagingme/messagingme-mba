import { describe, it, expect } from 'vitest';
import { lireRefusOffre, lireVueOffre, offreQuiOuvre, phraseInclusDans, phraseSansAdresse, FONCTIONS_OFFRE } from './offre';

/**
 * L'OFFRE CÔTÉ CONSOLE (lot 6, tâche 7) : la réponse du serveur vérifiée, et la règle qui protège un client d'une panne :
 * une réponse illisible veut dire « offre inconnue », donc tout reste ouvert (`null`), jamais tout grisé.
 */
const limites = (contacts: number | null) => ({
  utilisateurs: 1, admins: 1, contacts, envoisModelesMois: 1000, automations: 10, suppressionsJour: 10, adressesWebhook: 1,
  journalWebhooksJours: 3, conservationJours: 30, commissionPct: 50, badge: true, numeroInclus: false,
});
const PRO = ['inbox', 'scenarios', 'statistiques', 'agent_meta', 'aide', 'assistants', 'analyse', 'publicites', 'email', 'chaines'];
const BASE = {
  offre: 'base', fonctions: [], limites: limites(100),
  usage: { envoisModelesMois: 250, contacts: 42, automations: 3, membres: 1 },
  grille: {
    base: { fonctions: [], limites: limites(100) },
    pro: { fonctions: PRO, limites: limites(null) },
    entreprise: { fonctions: [...FONCTIONS_OFFRE], limites: limites(null) },
  },
  upgradeUrl: 'https://console.test/offre',
};

describe('lireVueOffre', () => {
  it('lit une vue complète, fonctions en ensembles', () => {
    const v = lireVueOffre(BASE);
    expect(v).not.toBeNull();
    expect(v!.offre).toBe('base');
    expect(v!.fonctions.size).toBe(0);
    expect(v!.limites.contacts).toBe(100);
    expect(v!.usage).toEqual({ envoisModelesMois: 250, contacts: 42, automations: 3, membres: 1 });
    expect(v!.grille.pro.fonctions.has('inbox')).toBe(true);
    expect(v!.grille.pro.limites.contacts).toBeNull();
  });

  it('🔴 une réponse illisible rend null (offre inconnue, donc tout ouvert) : le repli {} des e2e, une API ancienne', () => {
    for (const brut of [{}, null, 'x', [], { ...BASE, offre: 'or' }, { ...BASE, grille: undefined }, { ...BASE, usage: { contacts: -1 } },
      { ...BASE, limites: { ...limites(100), badge: 'oui' } }, { ...BASE, grille: { ...BASE.grille, pro: undefined } }]) {
      expect(lireVueOffre(brut), JSON.stringify(brut)).toBeNull();
    }
  });

  it('une fonction que la console ne connaît pas (un serveur plus récent) est ignorée, sans refuser la vue', () => {
    const v = lireVueOffre({ ...BASE, fonctions: ['inbox', 'teleportation'] });
    expect([...v!.fonctions]).toEqual(['inbox']);
  });

  it('l’offre la moins chère qui ouvre une fonction, d’après la grille du serveur', () => {
    const v = lireVueOffre(BASE)!;
    expect(offreQuiOuvre(v, 'inbox')).toBe('pro');
    expect(offreQuiOuvre(v, 'rcs')).toBe('entreprise');
  });
});

describe('lireRefusOffre', () => {
  it('lit les deux codes d’offre, et rien d’autre', () => {
    expect(lireRefusOffre({ error: 'Limite atteinte', code: 'plan_limit_reached', upgradeUrl: 'u' })).toEqual({ code: 'plan_limit_reached', phrase: 'Limite atteinte' });
    expect(lireRefusOffre({ error: 'Pas dans l’offre', code: 'plan_feature_unavailable' })).toEqual({ code: 'plan_feature_unavailable', phrase: 'Pas dans l’offre' });
    expect(lireRefusOffre({ error: 'Trop de requêtes', code: 'rate_limited' })).toBeNull();
    expect(lireRefusOffre({ code: 'plan_limit_reached' })).toBeNull();
    expect(lireRefusOffre(null)).toBeNull();
  });
});

describe('phraseSansAdresse', () => {
  it('🔴 retire l’adresse finale que le serveur écrit pour l’API : le bandeau porte déjà le bouton', () => {
    expect(phraseSansAdresse('Limite de votre offre atteinte : 100 contacts. Passez en Pro pour la lever : https://console.messagingme.app/offre'))
      .toBe('Limite de votre offre atteinte : 100 contacts. Passez en Pro pour la lever.');
    expect(phraseSansAdresse('Votre offre ne comprend pas l’Inbox. Passez en Pro : https://console.messagingme.app/offre'))
      .toBe('Votre offre ne comprend pas l’Inbox. Passez en Pro.');
  });

  it('une phrase sans adresse reste telle quelle (y compris un deux-points au milieu)', () => {
    expect(phraseSansAdresse('Limite de votre offre atteinte : 100 contacts.')).toBe('Limite de votre offre atteinte : 100 contacts.');
  });
});

describe('phraseInclusDans', () => {
  const t = (fr: string) => fr;
  it('nomme l’offre la moins chère qui ouvre la fonction', () => {
    const v = lireVueOffre(BASE)!;
    expect(phraseInclusDans(v, 'inbox', t)).toBe('Inclus dans l’offre Pro.');
    expect(phraseInclusDans(v, 'crm', t)).toBe('Inclus dans l’offre Entreprise.');
  });
});

describe('les prix du Pro dans la vue (lot 6, B1)', () => {
  it('lus quand l’API les porte, en centimes HT', () => {
    expect(lireVueOffre({ ...BASE, prixPro: { moisCentimes: 4900, anCentimes: 49000 } })!.prixPro).toEqual({ moisCentimes: 4900, anCentimes: 49000 });
  });

  it('🔴 une API qui ne les porte pas encore : la vue reste lisible, prix inconnus (null)', () => {
    expect(lireVueOffre(BASE)!.prixPro).toBeNull();
    expect(lireVueOffre({ ...BASE, prixPro: { moisCentimes: -1 } })!.prixPro).toBeNull();
  });
});
