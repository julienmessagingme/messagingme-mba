import { describe, it, expect } from 'vitest';
import { DROITS, contactsToutesOrigines, droitsDe, FONCTIONS, limiteContactsDe, type Fonction, type Limites, type Offre } from '../src/offres/offres';
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
    adressesWebhook: 1, journalWebhooksJours: 3, conservationJours: 30, commissionPct: 100, badge: true, numeroInclus: false,
    stockageOctets: 0, clesApi: 2, appelsMinute: 30, appelsHeure: 500, modelesJour: 500, reponsesJour: 2000,
  },
  pro: {
    utilisateurs: 3, admins: 2, contacts: 5000, envoisModelesMois: null, automations: null, suppressionsJour: null,
    adressesWebhook: 5, journalWebhooksJours: 30, conservationJours: 90, commissionPct: 20, badge: false, numeroInclus: true,
    stockageOctets: 100 * MO, clesApi: 10, appelsMinute: 60, appelsHeure: 1000, modelesJour: 2000, reponsesJour: 2000,
  },
  // Le Business (spec du 2026-10-27) : posé à la main dans /ops ; ses limites invisibles sont un choix de Claude relu.
  business: {
    utilisateurs: 5, admins: null, contacts: 5000, envoisModelesMois: null, automations: null, suppressionsJour: null,
    adressesWebhook: 10, journalWebhooksJours: 30, conservationJours: 90, commissionPct: 15, badge: false, numeroInclus: true,
    stockageOctets: 250 * MO, clesApi: 20, appelsMinute: 120, appelsHeure: 3000, modelesJour: 5000, reponsesJour: 5000,
  },
  entreprise: {
    utilisateurs: null, admins: null, contacts: null, envoisModelesMois: null, automations: null, suppressionsJour: null,
    adressesWebhook: null, journalWebhooksJours: 30, conservationJours: 90, commissionPct: 10, badge: false, numeroInclus: true,
    stockageOctets: 500 * MO, clesApi: null, appelsMinute: null, appelsHeure: null, modelesJour: null, reponsesJour: null,
  },
};

// Le Pro resserré (spec offres v2, livraison 5) : l'analyse, les publicités et les chaînes passent à l'Entreprise.
const PRO: Fonction[] = ['inbox', 'scenarios', 'statistiques', 'agent_meta', 'aide', 'assistants', 'email', 'console'];
const ENTREPRISE_SEULE: Fonction[] = ['analyse', 'publicites', 'chaines', 'crm', 'rcs', 'performance_lab'];

describe('la grille des offres', () => {
  it.each(['base', 'pro', 'business', 'entreprise'] as const)('les limites de %s sont celles de la spec', (offre) => {
    expect(DROITS[offre].limites).toEqual(GRILLE[offre]);
  });

  it('🔴 le Business ouvre ce qu’ouvre le Pro, et rien de ce qui reste à l’Entreprise (sous-lot A : le Pro garde tout)', () => {
    expect([...DROITS.business.fonctions].sort()).toEqual([...PRO].sort());
    for (const f of ENTREPRISE_SEULE) expect(DROITS.business.fonctions.has(f)).toBe(false);
  });

  it('🔴 les utilisateurs d’un Business : les 5 de la grille, ou la limite posée dans /ops (jamais « sans limite »)', () => {
    expect(droitsDe('business', null).limites.utilisateurs).toBe(5);
    expect(droitsDe('business', { utilisateurs: null, conservationJours: null }).limites.utilisateurs).toBe(5);
    expect(droitsDe('business', { utilisateurs: 7, conservationJours: null }).limites.utilisateurs).toBe(7);
    // La conservation, les contacts et la commission d'un Business ne se règlent pas dans /ops : la grille, toujours.
    const d = droitsDe('business', { utilisateurs: 7, conservationJours: 365, contacts: 99, commissionPct: 0 });
    expect(d.limites.conservationJours).toBe(90);
    expect(d.limites.contacts).toBe(5000);
    expect(d.limites.commissionPct).toBe(15);
  });

  it('🔴 la purge du journal des webhooks range le Business avec l’Entreprise : leurs durées doivent rester égales', () => {
    // `PgEvenementsStore.purger` ne connaît que base, pro et « le reste » : le Business y lit la durée de l'Entreprise.
    // Une durée propre au Business demandera d'ouvrir la purge à quatre offres (elle se câble dans src/worker.ts).
    expect(DROITS.business.limites.journalWebhooksJours).toBe(DROITS.entreprise.limites.journalWebhooksJours);
  });

  it('la Base n\'ouvre aucune fonction gardée', () => {
    expect([...DROITS.base.fonctions]).toEqual([]);
  });

  it('la console n\'est ouverte qu\'au Pro et à l\'Entreprise : la Free se pilote par l\'API et le MCP (spec offres v2)', () => {
    expect(DROITS.base.fonctions.has('console')).toBe(false);
    expect(DROITS.pro.fonctions.has('console')).toBe(true);
    expect(DROITS.entreprise.fonctions.has('console')).toBe(true);
  });

  it('le Pro ouvre tout sauf l’analyse, les publicités, les chaînes, le CRM, le RCS et le Performance Lab', () => {
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

  it('🔴 une limite du Pro renvoie au Business, l’offre suivante (spec Business), jamais au Pro', () => {
    const p = phraseLimite('adressesWebhook', DROITS.pro.limites.adressesWebhook!);
    expect(p).toMatch(/Passez en Business/);
    expect(p).not.toMatch(/Passez en Pro/);
  });

  it('les clés d’API : 2 en Free renvoient au Pro, 10 en Pro au Business, 20 en Business à l’Entreprise ; la phrase dit de révoquer', () => {
    const free = phraseLimite('clesApi', DROITS.base.limites.clesApi!);
    expect(free).toMatch(/2 clés d’API actives.*révoquez-en une.*Passez en Pro/);
    expect(phraseLimite('clesApi', DROITS.pro.limites.clesApi!)).toMatch(/10 clés d’API actives.*Passez en Business/);
    expect(phraseLimite('clesApi', DROITS.business.limites.clesApi!)).toMatch(/20 clés d’API actives.*Passez en Entreprise/);
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

  it('🔴 le Pro resserré : l’analyse, les publicités et les chaînes renvoient à l’Entreprise, et les 5 000 contacts du Pro aussi', () => {
    for (const f of ['analyse', 'publicites', 'chaines'] as const) {
      expect(corpsRefusFonction(f).error, f).toMatch(/Passez en Entreprise/);
    }
    expect(phraseLimite('contacts', DROITS.pro.limites.contacts!)).toMatch(/5.000 contacts.*Passez en Entreprise/);
    expect(phraseLimite('contacts', DROITS.base.limites.contacts!)).toMatch(/Passez en Pro/);
  });
});

/**
 * CE QUE COMPTE LA LIMITE DE CONTACTS (décision de Julien du 2026-10-25) : la Free ne gère jamais plus de contacts que sa
 * limite, quelle que soit leur origine ; le Pro et l'Entreprise ne comptent que les fiches créées. Une seule fonction le dit,
 * et la phrase du refus la suit.
 */
describe('🔴 ce que compte la limite de contacts : toutes les origines en Free, les fiches créées ailleurs', () => {
  it('la Free compte toutes les origines ; le Pro et l’Entreprise, seulement les fiches créées', () => {
    expect(contactsToutesOrigines('base')).toBe(true);
    expect(contactsToutesOrigines('pro')).toBe(false);
    expect(contactsToutesOrigines('entreprise')).toBe(false);
  });

  it('la limite de contacts des droits, avec l’offre qui la fixe ; sans limite, rien', () => {
    expect(limiteContactsDe({ offre: 'base', droits: DROITS.base })).toEqual({ max: 100, offre: 'base' });
    expect(limiteContactsDe({ offre: 'pro', droits: DROITS.pro })).toEqual({ max: 5000, offre: 'pro' });
    expect(limiteContactsDe({ offre: 'entreprise', droits: DROITS.entreprise })).toBeNull();
    const devis = droitsDe('entreprise', { utilisateurs: null, conservationJours: null, contacts: 300 });
    expect(limiteContactsDe({ offre: 'entreprise', droits: devis })).toEqual({ max: 300, offre: 'entreprise' });
  });

  it('la phrase du refus dit ce qui compte : ceux qui écrivent compris en Free, jamais ailleurs', () => {
    expect(phraseLimite('contacts', DROITS.base.limites.contacts!)).toMatch(/100 contacts, ceux qui vous écrivent compris\. Passez en Pro/);
    expect(phraseLimite('contacts', DROITS.pro.limites.contacts!)).toMatch(/5.000 contacts créés \(ceux qui vous écrivent ne comptent pas\)\. Passez en Entreprise/);
    // L'offre connue prime sur la grille : une Entreprise réglée à 100 contacts ne compte pas ceux qui lui écrivent.
    expect(phraseLimite('contacts', 100, { offre: 'entreprise' })).toMatch(/100 contacts créés \(ceux qui vous écrivent ne comptent pas\)/);
    expect(phraseLimite('contacts', 123_456)).toMatch(/contacts créés \(ceux qui vous écrivent ne comptent pas\)/);
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
