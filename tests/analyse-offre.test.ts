import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { OFFRES_SANS_ANALYSE } from '../src/analysis/store.pg';
import { DROITS, type Offre } from '../src/offres/offres';

/**
 * L'ANALYSE ÉTEINTE HORS DE L'OFFRE (lot 6, C, jaune 9 de la relecture) : la réclamation lit les offres qui n'ouvrent pas
 * la fonction `analyse` dans la GRILLE, pas un nom d'offre écrit en dur dans le SQL. Si la grille change, la réclamation suit.
 */
describe('les offres sans analyse', () => {
  it('🔴 dérivées de la grille : aujourd’hui la Base seule', () => {
    const attendues = (Object.keys(DROITS) as Offre[]).filter((o) => !DROITS[o].fonctions.has('analyse'));
    expect([...OFFRES_SANS_ANALYSE]).toEqual(attendues);
    expect([...OFFRES_SANS_ANALYSE]).toEqual(['base']);
  });

  it('🔴 la réclamation les lit en paramètre, sans nom d’offre en dur', () => {
    const store = readFileSync(new URL('../src/analysis/store.pg.ts', import.meta.url), 'utf8');
    expect(store).toContain('o.offre = any($3::text[])');
    expect(store).not.toContain("o.offre = 'base'");
  });
});
