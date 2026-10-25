import { describe, it, expect } from 'vitest';
import { estAccesSuspendu, lireRefusOffre, lireSiegeRequis, lireVueOffre, offreQuiOuvre, phraseInclusDans, phraseSansAdresse, FONCTIONS_OFFRE } from './offre';

/**
 * L'OFFRE CÔTÉ CONSOLE (lot 6, tâche 7) : la réponse du serveur vérifiée, et la règle qui protège un client d'une panne :
 * une réponse illisible veut dire « offre inconnue », donc tout reste ouvert (`null`), jamais tout grisé.
 */
const limites = (contacts: number | null) => ({
  utilisateurs: 1, admins: 1, contacts, envoisModelesMois: 1000, automations: 10, suppressionsJour: 10, adressesWebhook: 1,
  journalWebhooksJours: 3, conservationJours: 30, commissionPct: 50, badge: true, numeroInclus: false,
});
// Le Pro resserré (spec offres v2, livraison 5) : sans l'analyse, les publicités ni les chaînes.
const PRO = ['inbox', 'scenarios', 'statistiques', 'agent_meta', 'aide', 'assistants', 'email'];
const BASE = {
  offre: 'free', fonctions: [], limites: limites(100),
  usage: { envoisModelesMois: 250, contacts: 42, automations: 3, membres: 1 },
  grille: {
    free: { fonctions: [], limites: limites(100) },
    pro: { fonctions: PRO, limites: limites(null) },
    entreprise: { fonctions: [...FONCTIONS_OFFRE], limites: limites(null) },
  },
  upgradeUrl: 'https://console.test/offre',
};

describe('lireVueOffre', () => {
  it('l’essai du Pro (spec offres v2) : lu quand l’API le porte ; absent ou illisible, null, et la vue reste lisible', () => {
    expect(lireVueOffre({ ...BASE, essai: { jours: 14, possible: true, finLe: null } })!.essai).toEqual({ jours: 14, possible: true, finLe: null });
    expect(lireVueOffre({ ...BASE, essai: { jours: 14, possible: false, finLe: '2026-11-02T09:00:00.000Z' } })!.essai!.finLe).toBe('2026-11-02T09:00:00.000Z');
    for (const essai of [undefined, null, { jours: '14', possible: true, finLe: null }, { jours: 14, possible: 'oui', finLe: null }, { jours: 14, possible: true, finLe: 3 }]) {
      const v = lireVueOffre({ ...BASE, essai });
      expect(v, JSON.stringify(essai)).not.toBeNull();
      expect(v!.essai).toBeNull();
    }
  });

  it('🔴 ce que compte la limite de contacts (2026-10-25) : lu quand l’API le dit ; absent ou illisible, la règle d’avant', () => {
    expect(lireVueOffre({ ...BASE, contactsToutesOrigines: true })!.contactsToutesOrigines).toBe(true);
    expect(lireVueOffre({ ...BASE, contactsToutesOrigines: false })!.contactsToutesOrigines).toBe(false);
    // Une API plus ancienne ne compte pas ceux qui écrivent : la console, publiée avant elle, le dit comme elle.
    for (const v of [undefined, null, 'oui', 1]) {
      const vue = lireVueOffre({ ...BASE, contactsToutesOrigines: v });
      expect(vue, JSON.stringify(v)).not.toBeNull();
      expect(vue!.contactsToutesOrigines).toBe(false);
    }
  });

  it('lit le quota de stockage de la médiathèque quand l’API le porte', () => {
    const v = lireVueOffre({ ...BASE, limites: { ...limites(100), stockageOctets: 0 } });
    expect(v!.limites.stockageOctets).toBe(0);
  });

  it('lit le plafond de clés d’API quand l’API le porte, sans limite compris (spec offres v2)', () => {
    expect(lireVueOffre({ ...BASE, limites: { ...limites(100), clesApi: 2 } })!.limites.clesApi).toBe(2);
    expect(lireVueOffre({ ...BASE, limites: { ...limites(100), clesApi: null } })!.limites.clesApi).toBeNull();
  });

  it('🔴 un plafond de clés absent ou illisible ne rend pas la vue illisible : la ligne est seulement inconnue', () => {
    expect(lireVueOffre(BASE)!.limites.clesApi).toBeUndefined();
    const v = lireVueOffre({ ...BASE, limites: { ...limites(100), clesApi: 'deux' } });
    expect(v).not.toBeNull();
    expect(v!.limites.clesApi).toBeUndefined();
  });

  it('🔴 une API qui ne porte pas encore le quota de stockage se lit quand même : la console est publiée avant l’API', () => {
    const v = lireVueOffre(BASE);
    expect(v).not.toBeNull();
    expect(v!.limites.stockageOctets).toBeUndefined();
  });

  it('🔴 une API qui ne connaît pas encore la fonction console : la console reste ouverte (elle est publiée avant l’API)', () => {
    const sansConsole = FONCTIONS_OFFRE.filter((f) => f !== 'console');
    const v = lireVueOffre({ ...BASE, grille: { ...BASE.grille, entreprise: { fonctions: sansConsole, limites: limites(null) } } });
    expect(v!.fonctions.has('console')).toBe(true);
    expect(v!.grille.free.fonctions.has('console')).toBe(true);
  });

  it('une API qui connaît la fonction console : la Free ne l’a pas, le Pro et l’Entreprise l’ont', () => {
    const v = lireVueOffre({ ...BASE, grille: { ...BASE.grille, pro: { fonctions: [...PRO, 'console'], limites: limites(null) } } });
    expect(v!.fonctions.has('console')).toBe(false);
    expect(v!.grille.pro.fonctions.has('console')).toBe(true);
    expect(v!.grille.entreprise.fonctions.has('console')).toBe(true);
  });

  it('lit une vue complète, fonctions en ensembles', () => {
    const v = lireVueOffre(BASE);
    expect(v).not.toBeNull();
    expect(v!.offre).toBe('free');
    expect(v!.fonctions.size).toBe(0);
    expect(v!.limites.contacts).toBe(100);
    expect(v!.usage).toEqual({ envoisModelesMois: 250, contacts: 42, automations: 3, membres: 1 });
    expect(v!.grille.pro.fonctions.has('inbox')).toBe(true);
    expect(v!.grille.pro.limites.contacts).toBeNull();
  });

  it('🔴 une API d’avant le renommage (`base`, offre et grille) se lit `free` : la console est publiée avant l’API', () => {
    const { free, ...reste } = BASE.grille;
    const v = lireVueOffre({ ...BASE, offre: 'base', grille: { ...reste, base: free } });
    expect(v?.offre).toBe('free');
    expect(v?.grille.free.limites.contacts).toBe(100);
  });

  it('🔴 une réponse illisible rend null (offre inconnue, donc tout ouvert) : le repli {} des e2e, une API ancienne', () => {
    for (const brut of [{}, null, 'x', [], { ...BASE, offre: 'or' }, { ...BASE, grille: undefined }, { ...BASE, usage: { contacts: -1 } },
      { ...BASE, limites: { ...limites(100), badge: 'oui' } }, { ...BASE, grille: { ...BASE.grille, pro: undefined } }]) {
      expect(lireVueOffre(brut), JSON.stringify(brut)).toBeNull();
    }
  });

  it('🔴 la suite du numéro fourni (lot 6, B2b) : lue quand elle est juste, absente ou illisible = rien, sans refuser la vue', () => {
    expect(lireVueOffre({ ...BASE, suiteDuNumero: { finPrevueLe: '2026-11-08T10:00:00.000Z', rendreNumero: false } })!.suiteDuNumero)
      .toEqual({ finPrevueLe: '2026-11-08T10:00:00.000Z', rendreNumero: false });
    expect(lireVueOffre({ ...BASE, suiteDuNumero: { finPrevueLe: null, rendreNumero: true } })!.suiteDuNumero)
      .toEqual({ finPrevueLe: null, rendreNumero: true });
    // Une API plus ancienne ne la porte pas ; une forme fausse ne fait rien annoncer, et la vue reste lue.
    for (const suite of [undefined, null, { finPrevueLe: 3, rendreNumero: false }, { finPrevueLe: null }]) {
      const v = lireVueOffre({ ...BASE, suiteDuNumero: suite });
      expect(v, JSON.stringify(suite)).not.toBeNull();
      expect(v!.suiteDuNumero).toBeNull();
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

describe('estAccesSuspendu (lot 6, B2a)', () => {
  it('🔴 le refus de la garde à un membre en trop : la page entière, pas un bandeau', () => {
    expect(estAccesSuspendu({ error: 'Limite de votre offre atteinte : 1 utilisateur.', code: 'plan_limit_reached', limite: 'utilisateurs', max: 1, acces: 'suspendu', upgradeUrl: 'u' }))
      .toEqual({ code: 'plan_limit_reached', phrase: 'Limite de votre offre atteinte : 1 utilisateur.' });
  });
  it('une invitation au-delà de la limite (même code, sans acces) n’est PAS une suspension', () => {
    expect(estAccesSuspendu({ error: 'Limite', code: 'plan_limit_reached', limite: 'utilisateurs', max: 1, upgradeUrl: 'u' })).toBeNull();
    expect(estAccesSuspendu(null)).toBeNull();
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
    // Le Pro pas encore en vente : le serveur rend `null` (jaune 10 de la relecture de B1).
    expect(lireVueOffre({ ...BASE, prixPro: null })!.prixPro).toBeNull();
    expect(lireVueOffre({ ...BASE, prixPro: { moisCentimes: -1 } })!.prixPro).toBeNull();
  });
});

describe('les sièges du Pro (spec offres v2, livraison 7)', () => {
  it('lus quand l’API les porte ; absents ou illisibles, null, et la vue reste lisible', () => {
    const v = lireVueOffre({ ...BASE, sieges: { inclus: 3, achetes: 2, periodicite: 'an' }, prixSiege: { moisCentimes: 1500, anCentimes: 15000 } })!;
    expect(v.sieges).toEqual({ inclus: 3, achetes: 2, periodicite: 'an' });
    expect(v.prixSiege).toEqual({ moisCentimes: 1500, anCentimes: 15000 });
    for (const sieges of [undefined, null, { inclus: 3, achetes: -1, periodicite: 'mois' }, { inclus: 3, achetes: 1, periodicite: 'semaine' }]) {
      const w = lireVueOffre({ ...BASE, sieges, prixSiege: { moisCentimes: '15' } });
      expect(w, JSON.stringify(sieges)).not.toBeNull();
      expect([w!.sieges, w!.prixSiege]).toEqual([null, null]);
    }
  });

  it('🔴 le siège proposé par le refus d’une invitation : lu seulement sur un 402 de limite d’utilisateurs bien formé', () => {
    const corps = { error: 'Limite…', code: 'plan_limit_reached', limite: 'utilisateurs', max: 3, siege: { cible: 1, periodicite: 'mois', prixHtCentimes: 1500 } };
    expect(lireSiegeRequis(corps)).toEqual({ cible: 1, periodicite: 'mois', prixHtCentimes: 1500 });
    expect(lireSiegeRequis({ ...corps, limite: 'admins' })).toBeNull();
    expect(lireSiegeRequis({ ...corps, code: 'plan_feature_unavailable' })).toBeNull();
    expect(lireSiegeRequis({ ...corps, siege: { cible: 0, periodicite: 'mois', prixHtCentimes: 1500 } })).toBeNull();
    expect(lireSiegeRequis({ ...corps, siege: undefined })).toBeNull();
    expect(lireSiegeRequis(null)).toBeNull();
  });
});
