import { describe, it, expect } from 'vitest';
import { GRILLE_DEFAUT } from '../src/stats/prix';
import { coutMessages, type EntreeCoutMessages } from '../src/stats/cout-messages';

/**
 * LE COUT TOTAL DES MESSAGES ENVOYES : templates au tarif Meta marge, messages de service franchise
 * deduite, RCS a deux tarifs.
 *
 * 🔴 LA FRANCHISE SE COMPTE PAR MOIS, ET LA PERIODE AFFICHEE N'EST PAS UN MOIS. C'est tout le sujet de ce
 * module, et la premiere version du plan s'y est trompee : elle calculait « ce que le mois depasse, plafonne
 * a ce que la periode contient », ce qui suppose que la periode est la FIN du mois. Sur les sept premiers
 * jours d'un mois qui finit a 1200 envois, cette formule facturait 200 messages qui etaient GRATUITS.
 * D'ou l'entree par mois, avec ce qui a ete consomme AVANT la fenetre : c'est la seule facon d'etre juste
 * quel que soit l'endroit de la periode dans le mois, et quel que soit le nombre de mois qu'elle traverse.
 */

const BASE: EntreeCoutMessages = {
  templates: [{ category: 'marketing', count: 100 }],
  rates: { marketing: 0.04, utility: 0.01, currency: 'EUR' },
  service: [{ mois: '2026-11', avantLaPeriode: 0, dansLaPeriode: 300 }],
  rcsSimple: 0,
  rcsConversationnel: 0,
};

describe('le cout total des messages', () => {
  it('🔴 sous la franchise, AUCUN message de service n est facture, mais ils sont COMPTES', () => {
    const r = coutMessages(BASE, GRILLE_DEFAUT);
    expect(r.service.factures).toBe(0);
    expect(r.service.cout).toBe(0);
    // « 300 envoyes » et « 0 facture » ne disent pas la meme chose, et l'ecran doit pouvoir dire les deux :
    // un client qui voit 0 sans voir 300 croit que rien n'est parti.
    expect(r.service.envoyes).toBe(300);
    expect(r.service.parMois).toEqual([{ mois: '2026-11', consommes: 300, plafond: 1000, factures: 0 }]);
  });

  it('🔴 au-dela, seul le DEPASSEMENT est facture', () => {
    const r = coutMessages(
      { ...BASE, service: [{ mois: '2026-11', avantLaPeriode: 800, dansLaPeriode: 400 }] },
      GRILLE_DEFAUT,
    );
    // Le mois atteint 1200, la franchise couvre les 1000 premiers : 200 payants, tous dans la periode.
    expect(r.service.factures).toBe(200);
    expect(r.service.cout).toBe(4.96); // 200 x 2,48 centimes
  });

  it('🔴 LE CAS QUE LA PREMIERE FORMULE RATAIT : une periode au DEBUT d un mois charge', () => {
    // 400 messages en debut de mois, rien avant eux. Ils sont TOUS dans la franchise, meme si le mois
    // finira a 1200. Une formule qui regarde le total du mois sans savoir OU tombe la periode en
    // facturerait 200, c est-a-dire des messages offerts.
    const r = coutMessages(
      { ...BASE, service: [{ mois: '2026-11', avantLaPeriode: 0, dansLaPeriode: 400 }] },
      GRILLE_DEFAUT,
    );
    expect(r.service.factures).toBe(0);
    expect(r.service.cout).toBe(0);
  });

  it('🔴 une periode entierement AU-DELA de la franchise facture tout', () => {
    const r = coutMessages(
      { ...BASE, service: [{ mois: '2026-11', avantLaPeriode: 1200, dansLaPeriode: 400 }] },
      GRILLE_DEFAUT,
    );
    expect(r.service.factures).toBe(400);
  });

  it('🔴 une periode A CHEVAL sur la franchise ne facture que la partie qui depasse', () => {
    // 900 avant, 300 dans la periode : les 100 premiers de la periode sont encore offerts, 200 payants.
    const r = coutMessages(
      { ...BASE, service: [{ mois: '2026-11', avantLaPeriode: 900, dansLaPeriode: 300 }] },
      GRILLE_DEFAUT,
    );
    expect(r.service.factures).toBe(200);
  });

  it('🔴 une periode sur DEUX MOIS a DEUX franchises, pas une', () => {
    // La franchise est mensuelle : elle se remet a zero le 1er. Un calcul global sur la periode aurait
    // offert 1000 messages au lieu de 2000, donc surfacture de 1000 messages.
    const r = coutMessages({
      ...BASE,
      service: [
        { mois: '2026-11', avantLaPeriode: 900, dansLaPeriode: 300 },
        { mois: '2026-12', avantLaPeriode: 0, dansLaPeriode: 500 },
      ],
    }, GRILLE_DEFAUT);
    expect(r.service.factures).toBe(200); // 200 en novembre, 0 en decembre
    expect(r.service.envoyes).toBe(800);
    expect(r.service.parMois.map((m) => m.factures)).toEqual([200, 0]);
  });

  it('🔴 AVANT la date d effet, un message de service est GRATUIT, quel que soit le volume', () => {
    // Meta ne les facture qu'a partir du 2026-10-01. Rejouer septembre doit rendre zero : sans cette borne,
    // le total d'un mois passe changerait selon le jour ou on le regarde, et on facturerait
    // retroactivement des messages qui etaient offerts.
    const r = coutMessages(
      { ...BASE, service: [{ mois: '2026-09', avantLaPeriode: 5000, dansLaPeriode: 5000 }] },
      GRILLE_DEFAUT,
    );
    expect(r.service.factures).toBe(0);
    expect(r.service.cout).toBe(0);
    // Ils restent COMPTES : « 5000 envoyes, 0 facture » est l'information juste.
    expect(r.service.envoyes).toBe(5000);
  });

  it('⚠️ le mois de la BASCULE est facture, lui', () => {
    // La borne est « a partir de », pas « apres ». Octobre 2026 est le premier mois payant.
    const r = coutMessages(
      { ...BASE, service: [{ mois: '2026-10', avantLaPeriode: 1000, dansLaPeriode: 100 }] },
      GRILLE_DEFAUT,
    );
    expect(r.service.factures).toBe(100);
  });

  it('🔴 le RCS conversationnel est plus cher, et les deux se comptent separement', () => {
    const r = coutMessages({ ...BASE, rcsSimple: 10, rcsConversationnel: 5 }, GRILLE_DEFAUT);
    expect(r.rcs.cout).toBe(1); // 10 x 6 + 5 x 8 = 100 centimes
    expect(r.rcs.simple).toBe(10);
    expect(r.rcs.conversationnel).toBe(5);
  });

  it('🔴 le template suit la MARGE de l espace', () => {
    const r = coutMessages(BASE, { ...GRILLE_DEFAUT, margeTemplate: 200 });
    expect(r.templates.marketing).toBe(8); // 100 x 0,04 x 2
  });

  it('⚠️ un tarif Meta ABSENT ne produit AUCUN cout, et se COMPTE a part', () => {
    // Meme regle que `chiffrer` dans cost.ts, et c'est volontairement la MEME fonction : deux definitions
    // de « chiffrable » donneraient deux totaux sur deux ecrans du meme onglet, et le client comparerait.
    const r = coutMessages({ ...BASE, rates: { marketing: null, utility: null, currency: null } }, GRILLE_DEFAUT);
    expect(r.templates.marketing).toBe(0);
    expect(r.nonChiffrables).toBe(100);
  });

  it('⚠️ une categorie INCONNUE se compte a part elle aussi, et pas avec les tarifs manquants', () => {
    // Un envoi de scenario anterieur au 2026-09-07 ne porte pas sa categorie : heritage clos. Un tarif
    // manquant est une panne du jour. Les deux ne se reparent pas pareil, donc ils ne se comptent pas
    // ensemble.
    const r = coutMessages({ ...BASE, templates: [{ category: null, count: 22 }] }, GRILLE_DEFAUT);
    expect(r.sansCategorie).toBe(22);
    expect(r.sansTarif).toBe(0);
  });

  it('🔴 le TOTAL est la somme des trois postes, et rien d autre', () => {
    const r = coutMessages({
      ...BASE,
      service: [{ mois: '2026-11', avantLaPeriode: 1000, dansLaPeriode: 100 }],
      rcsSimple: 10,
      rcsConversationnel: 5,
    }, GRILLE_DEFAUT);
    // 100 templates marketing a 0,04 = 4 ; 100 services a 2,48 cts = 2,48 ; RCS = 1.
    expect(r.templates.marketing).toBe(4);
    expect(r.service.cout).toBe(2.48);
    expect(r.rcs.cout).toBe(1);
    expect(r.total).toBe(7.48);
  });

  it('⚠️ tout a zero rend zero, pas NaN ni null', () => {
    const r = coutMessages({ templates: [], rates: { marketing: null, utility: null }, service: [], rcsSimple: 0, rcsConversationnel: 0 }, GRILLE_DEFAUT);
    expect(r.total).toBe(0);
    expect(r.service.envoyes).toBe(0);
    expect(r.service.parMois).toEqual([]);
  });
});
