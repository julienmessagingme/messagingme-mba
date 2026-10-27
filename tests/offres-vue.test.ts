import { describe, it, expect } from 'vitest';
import { creerVueOffre, statutDuPro } from '../src/offres/vue';
import type { ResumePro } from '../src/offres/abonnements-offre.pg';
import {
  DROITS, FONCTIONS, PRIX_BUSINESS_HT_CENTIMES, PRIX_PRO_HT_CENTIMES, PRIX_SIEGE_BUSINESS_HT_CENTIMES, droitsDe, type Limites, type Offre,
} from '../src/offres/offres';

/**
 * LA VUE DE L'OFFRE (lot 6, tâche 6) : la même pour la console et pour Claude. Les fonctions dans l'ordre de la grille,
 * les limites telles quelles, l'usage, et le lien vers l'offre.
 */

/** Les limites telles que la vue les montre : toutes, sauf la commission, que personne ne voit (spec Business). */
function sansMarge(l: Limites): Omit<Limites, 'commissionPct'> {
  const { commissionPct: _marge, ...publiques } = l;
  return publiques;
}
function vue(
  offre: Offre, mois: { max: number; reste: number } | null, proEnVente = true, suite: { finPrevueLe: Date | null; rendreNumero: boolean } | null = null,
  abonnement: ResumePro | null = null,
) {
  return creerVueOffre({
    offres: { offreDe: async () => ({ offre, droits: DROITS[offre], retourEnBaseLe: null }) },
    usage: async () => ({ contacts: 42, automations: 3, membres: 1 }),
    modelesDuMois: { etatDuMois: async () => mois },
    proEnVente,
    suiteDuNumero: async () => suite,
    siegesEnVente: true,
    abonnement: async () => abonnement,
  });
}

describe('la suite du numéro fourni dans la vue (lot 6, B2b)', () => {
  it('🔴 un Pro qui finit : la date et le choix de rendre, pour la console et pour Claude', async () => {
    const fin = new Date('2026-11-08T10:00:00Z');
    expect((await vue('pro', null, true, { finPrevueLe: fin, rendreNumero: false })('t1')).suiteDuNumero)
      .toEqual({ finPrevueLe: '2026-11-08T10:00:00.000Z', rendreNumero: false });
    expect((await vue('pro', null, true, { finPrevueLe: null, rendreNumero: true })('t1')).suiteDuNumero)
      .toEqual({ finPrevueLe: null, rendreNumero: true });
  });

  it('sans Pro vivant ou sans numéro fourni : rien', async () => {
    expect((await vue('base', null)('t1')).suiteDuNumero).toBeNull();
  });
});

describe('creerVueOffre', () => {
  it('🔴 une Base : aucune fonction gardée, ses limites, et les modèles CONSOMMÉS ce mois-ci', async () => {
    const v = await vue('base', { max: 1000, reste: 750 })('t1');
    // Le nom PUBLIC (décision du 2026-10-08) : « Free », la base et le code serveur gardant `base`.
    expect(v.offre).toBe('free');
    expect(v.fonctions).toEqual([]);
    expect(v.limites).toEqual(sansMarge(DROITS.base.limites));
    expect(v.usage).toEqual({ envoisModelesMois: 250, contacts: 42, automations: 3, membres: 1 });
    expect(v.upgradeUrl).toMatch(/\/offre$/);
  });

  it('🔴 la vue dit ce que compte la limite de contacts : tous en Free, les fiches créées ailleurs (2026-10-25)', async () => {
    // La console et Claude le lisent ici, jamais en recopiant la règle : `contactsToutesOrigines` la décide seule.
    expect((await vue('base', null)('t1')).contactsToutesOrigines).toBe(true);
    expect((await vue('pro', null)('t1')).contactsToutesOrigines).toBe(false);
    expect((await vue('entreprise', null)('t1')).contactsToutesOrigines).toBe(false);
  });

  it('🔴 la vue dit combien de contacts dépassent la limite (2026-10-26) : 0 sous elle et pile à elle, 0 sans limite', async () => {
    const avecContacts = (offre: Offre, contacts: number) => creerVueOffre({
      offres: { offreDe: async () => ({ offre, droits: DROITS[offre], retourEnBaseLe: null }) },
      usage: async () => ({ contacts, automations: 0, membres: 1 }),
      modelesDuMois: { etatDuMois: async () => null },
      proEnVente: true, suiteDuNumero: async () => null, siegesEnVente: true,
      abonnement: async () => null,
    })('t1');
    expect((await avecContacts('base', 3000)).contactsEnTrop).toBe(2900);
    expect((await avecContacts('base', 101)).contactsEnTrop).toBe(1);
    expect((await avecContacts('base', 100)).contactsEnTrop).toBe(0);
    expect((await avecContacts('base', 42)).contactsEnTrop).toBe(0);
    expect((await avecContacts('pro', 1200)).contactsEnTrop).toBe(200);
    expect((await avecContacts('entreprise', 1_000_000)).contactsEnTrop).toBe(0);
  });

  it('un Pro : ses fonctions dans l’ordre de la grille, et les modèles du mois non comptés (sans limite)', async () => {
    const v = await vue('pro', null)('t1');
    expect(v.fonctions).toEqual(['inbox', 'scenarios', 'statistiques', 'email', 'console']);
    expect(v.usage.envoisModelesMois).toBeNull();
  });

  it('🔴 la vue porte la GRILLE des quatre offres, lue dans la seule définition : la console ne la recopie jamais', async () => {
    const v = await vue('base', null)('t1');
    expect(Object.keys(v.grille)).toEqual(['free', 'pro', 'business', 'entreprise']);
    for (const [publique, o] of [['free', 'base'], ['pro', 'pro'], ['business', 'business'], ['entreprise', 'entreprise']] as const) {
      expect(v.grille[publique].limites).toEqual(sansMarge(DROITS[o].limites));
      expect(v.grille[publique].fonctions).toEqual(FONCTIONS.filter((f) => DROITS[o].fonctions.has(f)));
    }
    expect(v.grille.entreprise.fonctions).toEqual([...FONCTIONS]);
    v.grille.pro.limites.utilisateurs = 9999;
    expect(DROITS.pro.limites.utilisateurs).toBe(3);
  });

  it('🔴 la marge IA n’apparaît nulle part dans la vue : ni dans les limites de l’espace, ni dans la grille (spec Business)', async () => {
    for (const o of ['base', 'pro', 'business', 'entreprise'] as const) {
      const v = await vue(o, null)('t1');
      expect('commissionPct' in v.limites).toBe(false);
      for (const ligne of Object.values(v.grille)) expect('commissionPct' in ligne.limites).toBe(false);
    }
  });

  it('🔴 un Business : son nom public, ses prix HT (349 € par mois, 10 € l’utilisateur en plus), ni essai ni siège Stripe', async () => {
    const v = await vue('business', null)('t1');
    expect(v.offre).toBe('business');
    expect(v.prixBusiness).toEqual({ moisCentimes: 34900, siegeMoisCentimes: 1000 });
    expect(v.prixBusiness).toEqual({ moisCentimes: PRIX_BUSINESS_HT_CENTIMES.mois, siegeMoisCentimes: PRIX_SIEGE_BUSINESS_HT_CENTIMES.mois });
    expect(v.essai.possible).toBe(false);
    expect(v.sieges).toBeNull();
    // Le prix se dit même quand le Pro n'est pas en vente : le Business ne s'achète pas en ligne, il se pose dans /ops.
    expect((await vue('base', null, false)('t1')).prixBusiness).toEqual({ moisCentimes: 34900, siegeMoisCentimes: 1000 });
  });

  it('🔴 la vue porte les prix HT du Pro, lus dans la grille : 49 € par mois, 490 € par an (lot 6, B1)', async () => {
    const v = await vue('base', null)('t1');
    expect(v.prixPro).toEqual({ moisCentimes: 4900, anCentimes: 49000 });
    expect(v.prixPro).toEqual({ moisCentimes: PRIX_PRO_HT_CENTIMES.mois, anCentimes: PRIX_PRO_HT_CENTIMES.an });
  });

  it('🟡 le Pro pas encore en vente (prix Stripe pas posés) : aucun prix, la console renvoie au Support sans faire cliquer', async () => {
    expect((await vue('base', null, false)('t1')).prixPro).toBeNull();
  });

  it('les limites rendues sont une copie : la modifier ne touche pas la grille', async () => {
    const v = await vue('base', null)('t1');
    v.limites.contacts = 9999;
    expect(DROITS.base.limites.contacts).toBe(100);
  });
});

/** L'ESSAI DE 14 JOURS DANS LA VUE (spec offres v2, livraison 6) : la console et Claude le proposent, puis en disent la fin. */
describe('l’essai du Pro dans la vue', () => {
  it('🔴 une Free qui n’a jamais eu de Pro, le Pro en vente : l’essai de 14 jours est possible', async () => {
    expect((await vue('base', null)('t1')).essai).toEqual({ jours: 14, possible: true, finLe: null });
  });

  it('🔴 pas d’essai pour un espace qui a déjà eu un Pro, pour un Pro, une Entreprise, ou tant que le Pro n’est pas en vente', async () => {
    // Un Pro, même fini, a consommé l'essai : il se lit sur l'abonnement, la seule lecture de la table (2026-10-26).
    const fini: ResumePro = {
      statut: 'resilie', periodicite: 'mois', creeLe: new Date('2026-01-01T00:00:00Z'), periodeFin: null, finPrevueLe: null,
      essaiFinLe: null, finiLe: new Date('2026-02-01T00:00:00Z'), finRaison: 'resiliation',
    };
    expect((await vue('base', null, true, null, fini)('t1')).essai.possible).toBe(false);
    expect((await vue('pro', null)('t1')).essai.possible).toBe(false);
    expect((await vue('entreprise', null)('t1')).essai.possible).toBe(false);
    expect((await vue('base', null, false)('t1')).essai.possible).toBe(false);
  });

  it('un Pro en essai : la date de fin, pour « votre essai se termine le … »', async () => {
    const fin = new Date('2099-11-02T09:00:00Z');
    const enEssai: ResumePro = {
      statut: 'actif', periodicite: 'mois', creeLe: new Date('2026-10-20T00:00:00Z'), periodeFin: fin, finPrevueLe: null,
      essaiFinLe: fin, finiLe: null, finRaison: null,
    };
    expect((await vue('pro', null, true, null, enEssai)('t1')).essai)
      .toEqual({ jours: 14, possible: false, finLe: '2099-11-02T09:00:00.000Z' });
  });
});

describe('les sièges du Pro dans la vue (spec offres v2, livraison 7)', () => {
  const avecSieges = (offre: Offre, pro: { sieges: number; periodicite: 'mois' | 'an' } | null, siegesEnVente = true) => creerVueOffre({
    offres: { offreDe: async () => ({ offre, droits: droitsDe(offre, null, pro?.sieges ?? 0), retourEnBaseLe: null, pro }) },
    usage: async () => ({ contacts: 0, automations: 0, membres: 4 }),
    modelesDuMois: { etatDuMois: async () => null },
    proEnVente: true,
    suiteDuNumero: async () => null,
    siegesEnVente,
    abonnement: async () => null,
  });

  it('🔴 un Pro annuel avec deux sièges : 3 inclus, 2 achetés, la limite à 5, le prix de sa formule lisible', async () => {
    const v = await avecSieges('pro', { sieges: 2, periodicite: 'an' })('t1');
    expect(v.sieges).toEqual({ inclus: 3, achetes: 2, periodicite: 'an' });
    expect(v.limites.utilisateurs).toBe(5);
    expect(v.prixSiege).toEqual({ moisCentimes: 1500, anCentimes: 15000 });
  });

  it('une Free : aucun siège, mais le prix pour la carte du Pro ; sièges pas en vente : aucun prix', async () => {
    const free = await avecSieges('base', null)('t1');
    expect(free.sieges).toBeNull();
    expect(free.prixSiege).toEqual({ moisCentimes: 1500, anCentimes: 15000 });
    expect((await avecSieges('pro', { sieges: 0, periodicite: 'mois' }, false)('t1')).prixSiege).toBeNull();
  });
});

describe('l’abonnement Pro dit en clair (2026-10-26)', () => {
  const MAINTENANT = Date.parse('2026-10-26T12:00:00Z');
  const pro = (p: Partial<ResumePro> = {}): ResumePro => ({
    statut: 'actif', periodicite: 'mois', creeLe: new Date('2026-09-12T08:00:00Z'), periodeFin: new Date('2099-11-12T08:00:00Z'),
    finPrevueLe: null, essaiFinLe: null, finiLe: null, finRaison: null, ...p,
  });

  it('🔴 le statut, du plus fort au plus faible : fini, retard, résiliation programmée, essai, actif', () => {
    const futur = new Date('2026-11-01T00:00:00Z');
    expect(statutDuPro(pro(), MAINTENANT)).toBe('actif');
    expect(statutDuPro(pro({ essaiFinLe: futur }), MAINTENANT)).toBe('essai');
    // Un essai déjà passé n'est plus un essai : le Pro a été payé ensuite.
    expect(statutDuPro(pro({ essaiFinLe: new Date('2026-10-01T00:00:00Z') }), MAINTENANT)).toBe('actif');
    // Une fin posée pendant l'essai : il ne sera suivi d'aucun paiement, c'est ce qui compte.
    expect(statutDuPro(pro({ essaiFinLe: futur, finPrevueLe: futur }), MAINTENANT)).toBe('resiliation_programmee');
    // Un retard prime une fin posée : c'est lui qu'il faut régler.
    expect(statutDuPro(pro({ statut: 'en_retard', finPrevueLe: futur }), MAINTENANT)).toBe('en_retard');
    expect(statutDuPro(pro({ statut: 'resilie', finiLe: new Date('2026-10-20T00:00:00Z'), finRaison: 'impaye' }), MAINTENANT)).toBe('termine');
    // Une ligne finie sans date (ancienne) reste finie.
    expect(statutDuPro(pro({ statut: 'resilie' }), MAINTENANT)).toBe('termine');
  });

  it('🔴 un Pro qui court : sa souscription et son prochain renouvellement, aucune fin', async () => {
    const v = await vue('pro', null, true, null, pro())('t1');
    expect(v.abonnement).toEqual({
      statut: 'actif', periodicite: 'mois', debutLe: '2026-09-12T08:00:00.000Z', prochaineEcheanceLe: '2099-11-12T08:00:00.000Z',
      finPrevueLe: null, essaiFinLe: null, finiLe: null, finRaison: null,
    });
  });

  it('🔴 une résiliation programmée : la fin, et plus de renouvellement annoncé', async () => {
    const v = await vue('pro', null, true, null, pro({ finPrevueLe: new Date('2026-11-12T08:00:00Z') }))('t1');
    expect(v.abonnement).toMatchObject({ statut: 'resiliation_programmee', prochaineEcheanceLe: null, finPrevueLe: '2026-11-12T08:00:00.000Z' });
  });

  it('🔴 aucun « prochain renouvellement » en retard de paiement, ni déjà passé : la date serait fausse', async () => {
    const retard = await vue('pro', null, true, null, pro({ statut: 'en_retard' }))('t1');
    expect(retard.abonnement).toMatchObject({ statut: 'en_retard', prochaineEcheanceLe: null });
    const passe = await vue('pro', null, true, null, pro({ periodeFin: new Date('2026-01-01T00:00:00Z') }))('t1');
    expect(passe.abonnement).toMatchObject({ statut: 'actif', prochaineEcheanceLe: null });
  });

  it('un essai qui court : sa fin ; un essai passé : aucune', async () => {
    const enEssai = await vue('pro', null, true, null, pro({ essaiFinLe: new Date('2099-01-01T00:00:00Z') }))('t1');
    expect(enEssai.abonnement).toMatchObject({ statut: 'essai', essaiFinLe: '2099-01-01T00:00:00.000Z' });
    const paye = await vue('pro', null, true, null, pro({ essaiFinLe: new Date('2026-01-01T00:00:00Z') }))('t1');
    expect(paye.abonnement).toMatchObject({ statut: 'actif', essaiFinLe: null });
  });

  it('🔴 une Free revenue d’un Pro : « terminé le … », sa raison, et ni renouvellement ni fin à venir', async () => {
    const fini = pro({ statut: 'resilie', finiLe: new Date('2026-10-20T00:00:00Z'), finRaison: 'resiliation', finPrevueLe: new Date('2026-10-20T00:00:00Z') });
    const v = await vue('base', null, true, null, fini)('t1');
    expect(v.abonnement).toMatchObject({
      statut: 'termine', prochaineEcheanceLe: null, finPrevueLe: null, finiLe: '2026-10-20T00:00:00.000Z', finRaison: 'resiliation',
    });
  });

  it('un espace qui n’a jamais eu de Pro : aucun abonnement', async () => {
    expect((await vue('base', null)('t1')).abonnement).toBeNull();
  });
});
