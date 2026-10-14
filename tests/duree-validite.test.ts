import { describe, it, expect } from 'vitest';
import { DUREES_VALIDITE, DUREE_PAR_DEFAUT, dureeValide, dureeAffichee, libelleDuree, type CategorieModele } from '../web/lib/partage/duree-validite';

/**
 * LA DURÉE DE VALIDITÉ D'UN MODÈLE (plan du 2026-10-14). Les bornes sont celles de la page « Time-to-live » de Meta :
 * marketing de 12 h à 30 jours, utility de 30 s à 12 h ou -1 (30 jours). Une durée proposée hors bornes ferait refuser
 * le modèle entier par Meta, à la création comme à l'édition.
 */
const CATEGORIES: CategorieModele[] = ['MARKETING', 'UTILITY'];

describe('les durées proposées', () => {
  it('🔴 chaque durée proposée est acceptée par Meta pour SA catégorie, défaut compris', () => {
    for (const c of CATEGORIES) {
      for (const d of DUREES_VALIDITE[c]) expect(dureeValide(c, d.secondes), `${c} ${d.secondes}`).toBe(true);
      expect(DUREES_VALIDITE[c].map((d) => d.secondes)).toContain(DUREE_PAR_DEFAUT[c]);
    }
  });

  it('aucune durée en double, et de la plus courte au défaut', () => {
    for (const c of CATEGORIES) {
      const s = DUREES_VALIDITE[c].map((d) => d.secondes);
      expect(new Set(s).size).toBe(s.length);
      expect(s[s.length - 1]).toBe(DUREE_PAR_DEFAUT[c]);
    }
  });
});

describe('dureeValide : les bornes de Meta', () => {
  it('marketing : de 12 h à 30 jours, rien en dehors', () => {
    expect(dureeValide('MARKETING', 43_200)).toBe(true);
    expect(dureeValide('MARKETING', 2_592_000)).toBe(true);
    for (const s of [43_199, 2_592_001, -1, 3_600, 0]) expect(dureeValide('MARKETING', s), String(s)).toBe(false);
  });

  it('utility : de 30 s à 12 h, ou -1 (30 jours), rien d’autre', () => {
    for (const s of [30, 43_200, -1]) expect(dureeValide('UTILITY', s), String(s)).toBe(true);
    for (const s of [29, 43_201, 2_592_000, 0, -2]) expect(dureeValide('UTILITY', s), String(s)).toBe(false);
  });

  it('une durée qui n’est pas un entier est refusée', () => {
    expect(dureeValide('UTILITY', 60.5)).toBe(false);
    expect(dureeValide('MARKETING', Number.NaN)).toBe(false);
  });
});

describe('dureeAffichee : ce que l’éditeur montre d’une durée lue chez Meta', () => {
  it('absente (jamais réglée, ou effacée par un reclassement) -> le défaut', () => {
    expect(dureeAffichee('MARKETING', undefined)).toBe(2_592_000);
    expect(dureeAffichee('UTILITY', null)).toBe(-1);
  });

  it('une durée valide est gardée, même hors des durées proposées', () => {
    expect(dureeAffichee('UTILITY', 3_600)).toBe(3_600);
    expect(dureeAffichee('UTILITY', 7_200)).toBe(7_200);
  });

  it('30 jours écrits en secondes sur une utility -> le défaut, pas un second « 30 jours »', () => {
    expect(dureeAffichee('UTILITY', 2_592_000)).toBe(-1);
  });

  it('une durée de l’autre catégorie (modèle reclassé) -> le défaut de la catégorie actuelle', () => {
    expect(dureeAffichee('MARKETING', 3_600)).toBe(2_592_000);
  });
});

describe('libelleDuree', () => {
  it('l’unité la plus grande qui tombe juste, au pluriel quand il faut, dans les deux langues', () => {
    expect(libelleDuree(-1, 'fr')).toBe('30 jours');
    expect(libelleDuree(604_800, 'fr')).toBe('7 jours');
    expect(libelleDuree(7_200, 'fr')).toBe('2 heures');
    expect(libelleDuree(3_600, 'en')).toBe('1 hour');
    expect(libelleDuree(90, 'fr')).toBe('90 secondes');
    expect(libelleDuree(120, 'en')).toBe('2 minutes');
  });
});
