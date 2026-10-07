import { describe, it, expect } from 'vitest';
import { DROITS, droitsDe, FONCTIONS, type Fonction, type Limites, type Offre } from '../src/offres/offres';

/**
 * LA GRILLE DES OFFRES (lot 6, spec `docs/superpowers/specs/2026-10-07-offres-et-limites-design.md`, § 1). Le tableau de
 * ce test EST la grille de la spec : une valeur qui bouge dans le code sans bouger ici, ou l'inverse, rend le test rouge.
 * `null` veut dire « sans limite ».
 */
const GRILLE: Record<Offre, Limites> = {
  base: {
    utilisateurs: 1, admins: 1, contacts: 100, envoisModelesMois: 1000, automations: 10, suppressionsJour: 10,
    adressesWebhook: 1, journalWebhooksJours: 3, conservationJours: 30, commissionPct: 50, badge: true, numeroInclus: false,
  },
  pro: {
    utilisateurs: 3, admins: 2, contacts: null, envoisModelesMois: null, automations: null, suppressionsJour: null,
    adressesWebhook: 5, journalWebhooksJours: 30, conservationJours: 90, commissionPct: 10, badge: false, numeroInclus: true,
  },
  entreprise: {
    utilisateurs: null, admins: null, contacts: null, envoisModelesMois: null, automations: null, suppressionsJour: null,
    adressesWebhook: null, journalWebhooksJours: 30, conservationJours: 90, commissionPct: 10, badge: false, numeroInclus: true,
  },
};

const PRO: Fonction[] = ['inbox', 'scenarios', 'statistiques', 'agent_meta', 'aide', 'assistants', 'analyse', 'publicites', 'email', 'chaines'];
const ENTREPRISE_SEULE: Fonction[] = ['crm', 'rcs', 'performance_lab'];

describe('la grille des offres', () => {
  it.each(['base', 'pro', 'entreprise'] as const)('les limites de %s sont celles de la spec', (offre) => {
    expect(DROITS[offre].limites).toEqual(GRILLE[offre]);
  });

  it('la Base n\'ouvre aucune fonction gardée', () => {
    expect([...DROITS.base.fonctions]).toEqual([]);
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

  it('la surcharge ne touche jamais la Base ni le Pro', () => {
    expect(droitsDe('base', { utilisateurs: 50, conservationJours: 365 })).toEqual(DROITS.base);
    expect(droitsDe('pro', { utilisateurs: 50, conservationJours: 365 })).toEqual(DROITS.pro);
  });

  it('les droits rendus ne partagent rien avec la grille : les modifier ne la change pas', () => {
    const d = droitsDe('entreprise', { utilisateurs: 7, conservationJours: null });
    expect(DROITS.entreprise.limites.utilisateurs).toBeNull();
    expect(d.fonctions).not.toBe(DROITS.entreprise.fonctions);
  });
});
