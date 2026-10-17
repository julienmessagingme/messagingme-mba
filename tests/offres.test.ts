import { describe, it, expect } from 'vitest';
import { DROITS, droitsDe, FONCTIONS, type Fonction, type Limites, type Offre } from '../src/offres/offres';
import { corpsRefusFonction, phraseLimite } from '../src/offres/refus';

const MO = 1024 * 1024;

/**
 * LA GRILLE DES OFFRES (lot 6, spec `docs/superpowers/specs/2026-10-07-offres-et-limites-design.md`, § 1). Le tableau de
 * ce test EST la grille de la spec : une valeur qui bouge dans le code sans bouger ici, ou l'inverse, rend le test rouge.
 * `null` veut dire « sans limite ».
 */
const GRILLE: Record<Offre, Limites> = {
  base: {
    utilisateurs: 1, admins: 1, contacts: 100, envoisModelesMois: 1000, automations: 10, suppressionsJour: 10,
    adressesWebhook: 1, journalWebhooksJours: 3, conservationJours: 30, commissionPct: 50, badge: true, numeroInclus: false,
    stockageOctets: 0, clesApi: 2, appelsMinute: 30, appelsHeure: 500, modelesJour: 500, reponsesJour: 2000,
  },
  pro: {
    utilisateurs: 3, admins: 2, contacts: null, envoisModelesMois: null, automations: null, suppressionsJour: null,
    adressesWebhook: 5, journalWebhooksJours: 30, conservationJours: 90, commissionPct: 10, badge: false, numeroInclus: true,
    stockageOctets: 100 * MO, clesApi: 10, appelsMinute: 60, appelsHeure: 1000, modelesJour: 2000, reponsesJour: 2000,
  },
  entreprise: {
    utilisateurs: null, admins: null, contacts: null, envoisModelesMois: null, automations: null, suppressionsJour: null,
    adressesWebhook: null, journalWebhooksJours: 30, conservationJours: 90, commissionPct: 10, badge: false, numeroInclus: true,
    stockageOctets: 500 * MO, clesApi: null, appelsMinute: null, appelsHeure: null, modelesJour: null, reponsesJour: null,
  },
};

const PRO: Fonction[] = ['inbox', 'scenarios', 'statistiques', 'agent_meta', 'aide', 'assistants', 'analyse', 'publicites', 'email', 'chaines', 'console'];
const ENTREPRISE_SEULE: Fonction[] = ['crm', 'rcs', 'performance_lab'];

describe('la grille des offres', () => {
  it.each(['base', 'pro', 'entreprise'] as const)('les limites de %s sont celles de la spec', (offre) => {
    expect(DROITS[offre].limites).toEqual(GRILLE[offre]);
  });

  it('la Base n\'ouvre aucune fonction gardée', () => {
    expect([...DROITS.base.fonctions]).toEqual([]);
  });

  it('la console n\'est ouverte qu\'au Pro et à l\'Entreprise : la Free se pilote par l\'API et le MCP (spec offres v2)', () => {
    expect(DROITS.base.fonctions.has('console')).toBe(false);
    expect(DROITS.pro.fonctions.has('console')).toBe(true);
    expect(DROITS.entreprise.fonctions.has('console')).toBe(true);
  });

  it('le Pro ouvre tout sauf le CRM, le RCS et le Performance Lab', () => {
    expect([...DROITS.pro.fonctions].sort()).toEqual([...PRO].sort());
    for (const f of ENTREPRISE_SEULE) expect(DROITS.pro.fonctions.has(f)).toBe(false);
  });

  it('l\'Entreprise ouvre toutes les fonctions', () => {
    expect([...DROITS.entreprise.fonctions].sort()).toEqual([...FONCTIONS].sort());
    expect(FONCTIONS).toHaveLength(PRO.length + ENTREPRISE_SEULE.length);
  });
});

describe('les refus nomment l’offre qui lève la limite ou ouvre la fonction (spec offres v2)', () => {
  it('une limite de la Free renvoie au Pro', () => {
    expect(phraseLimite('contacts', DROITS.base.limites.contacts!)).toMatch(/Passez en Pro/);
    expect(phraseLimite('utilisateurs', DROITS.base.limites.utilisateurs!)).toMatch(/Passez en Pro/);
  });

  it('🔴 une limite du Pro renvoie à l’Entreprise, jamais au Pro', () => {
    const p = phraseLimite('utilisateurs', DROITS.pro.limites.utilisateurs!);
    expect(p).toMatch(/Entreprise/);
    expect(p).not.toMatch(/Passez en Pro/);
  });

  it('les clés d’API : 2 en Free renvoient au Pro, 10 en Pro à l’Entreprise ; la phrase dit de révoquer', () => {
    const free = phraseLimite('clesApi', DROITS.base.limites.clesApi!);
    expect(free).toMatch(/2 clés d’API actives.*révoquez-en une.*Passez en Pro/);
    expect(phraseLimite('clesApi', DROITS.pro.limites.clesApi!)).toMatch(/10 clés d’API actives.*Passez en Entreprise/);
  });

  it('une limite réglée sur devis (absente de la grille) renvoie à un échange, jamais au Pro', () => {
    const p = phraseLimite('contacts', 123_456);
    expect(p).toMatch(/Contactez-nous/);
    expect(p).not.toMatch(/Passez en Pro/);
  });

  it('🔴 une fonction de l’Entreprise seule renvoie à l’Entreprise ; une fonction du Pro, au Pro', () => {
    expect(corpsRefusFonction('crm').error).toMatch(/Entreprise/);
    expect(corpsRefusFonction('crm').error).not.toMatch(/Passez en Pro/);
    expect(corpsRefusFonction('inbox').error).toMatch(/Passez en Pro/);
  });
});

describe('le quota de stockage de la médiathèque (spec médias, § 2.1)', () => {
  it('🔴 la phrase de refus parle de fichiers et de suppression, jamais de « passer en Pro » (le Pro a lui-même un quota)', () => {
    const p = phraseLimite('stockageOctets', 100 * MO);
    expect(p).toContain('100 Mo');
    expect(p).toMatch(/supprim/i);
    expect(p).not.toMatch(/Passez en Pro/);
  });
});

describe('droitsDe', () => {
  it('sans surcharge, les droits de l\'offre', () => {
    expect(droitsDe('base', null)).toEqual(DROITS.base);
    expect(droitsDe('entreprise', null).limites.utilisateurs).toBeNull();
  });

  it('la surcharge règle les utilisateurs de l\'Entreprise, et null veut dire sans limite', () => {
    expect(droitsDe('entreprise', { utilisateurs: 10, conservationJours: null }).limites.utilisateurs).toBe(10);
    expect(droitsDe('entreprise', { utilisateurs: null, conservationJours: null }).limites.utilisateurs).toBeNull();
  });

  it('🔴 la conservation posée par l’exploitation est celle de l’Entreprise ; null garde le défaut, 0 veut dire jamais purgée', () => {
    // Relecture finale du lot 6 : la vue affichait 90 jours même quand `/ops` avait posé 365 ou 0.
    expect(droitsDe('entreprise', { utilisateurs: null, conservationJours: 365 }).limites.conservationJours).toBe(365);
    expect(droitsDe('entreprise', { utilisateurs: null, conservationJours: 0 }).limites.conservationJours).toBe(0);
    expect(droitsDe('entreprise', { utilisateurs: null, conservationJours: null }).limites.conservationJours).toBe(DROITS.entreprise.limites.conservationJours);
  });

  it('les contacts et la commission posés par l’exploitation sont ceux de l’Entreprise ; null ou absents gardent les défauts (spec offres v2)', () => {
    const reglee = droitsDe('entreprise', { utilisateurs: null, conservationJours: null, contacts: 20000, commissionPct: 7 });
    expect(reglee.limites.contacts).toBe(20000);
    expect(reglee.limites.commissionPct).toBe(7);
    const parDefaut = droitsDe('entreprise', { utilisateurs: null, conservationJours: null, contacts: null, commissionPct: null });
    expect(parDefaut.limites.contacts).toBe(DROITS.entreprise.limites.contacts);
    expect(parDefaut.limites.commissionPct).toBe(DROITS.entreprise.limites.commissionPct);
  });

  it('la surcharge ne touche jamais la Base ni le Pro', () => {
    expect(droitsDe('base', { utilisateurs: 50, conservationJours: 365 })).toEqual(DROITS.base);
    expect(droitsDe('pro', { utilisateurs: 50, conservationJours: 365 })).toEqual(DROITS.pro);
    expect(droitsDe('pro', { utilisateurs: 50, conservationJours: 365, contacts: 7, commissionPct: 1 })).toEqual(DROITS.pro);
  });

  it('les droits rendus ne partagent rien avec la grille : les modifier ne la change pas', () => {
    const d = droitsDe('entreprise', { utilisateurs: 7, conservationJours: null });
    expect(DROITS.entreprise.limites.utilisateurs).toBeNull();
    expect(d.fonctions).not.toBe(DROITS.entreprise.fonctions);
  });
});
