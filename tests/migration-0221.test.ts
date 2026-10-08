import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decouperInstructions, veutHorsTransaction } from '../src/db/migration-directives';

/**
 * 0221 : la date à laquelle un espace quitte l'Entreprise (lot 6, livraison C, décision de Julien du 2026-10-08). La
 * conservation de la Base ne s'applique que 30 jours après l'entrée en Base ; sans cette date, passer un espace
 * d'Entreprise à Base dans /ops effacerait tout de suite ses conversations de plus de 30 jours. Une colonne nullable,
 * sans défaut, que seul le code neuf écrit et lit : l'ancien code y survit, elle passe AVANT le `up`.
 */
const lire = (chemin: string): string => readFileSync(new URL(chemin, import.meta.url), 'utf8');
const SQL = lire('../db/migrations/0221_entreprise_quittee.sql');
const sansCommentaires = (t: string): string => t.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n');
const instructions = decouperInstructions(SQL)
  .map(sansCommentaires)
  .map((i) => i.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim())
  .filter((i) => i !== '');

describe('migration 0221', () => {
  it('🔴 une colonne ajoutée à tenants, nullable et sans défaut, et sa reprise', () => {
    expect(instructions).toEqual([
      "set local lock_timeout = '5s'",
      'alter table tenants add column if not exists entreprise_quittee_le timestamptz',
      "update tenants set entreprise_quittee_le = now() where not offre_entreprise and entreprise_quittee_le is null and created_at < (select applied_at from public.schema_migrations where name = '0218_offres.sql')",
    ]);
  });

  it('🔴 la reprise ne date QUE les espaces sortis de l’Entreprise avant elle (jaune 1 de la relecture)', () => {
    // 0218 a posé tous les espaces d'alors en Entreprise : un espace d'avant elle qui n'y est plus en est sorti par /ops,
    // sans date (l'ancien code ne la posait pas). Sans la reprise, sa grâce serait déjà écoulée et le premier balayage
    // effacerait ses conversations de plus de 30 jours. `now()` est une borne sûre : elle ne fait qu'allonger la grâce.
    // Un espace né en Base après 0218 n'a jamais quitté l'Entreprise : il n'est pas daté.
    const reprise = instructions[2]!;
    expect(reprise).toContain('not offre_entreprise');
    expect(reprise).toContain('entreprise_quittee_le is null');
    expect(reprise).toContain("created_at < (select applied_at from public.schema_migrations where name = '0218_offres.sql')");
  });

  it('dans une transaction ordinaire, et sans accent grave (le runner lit le fichier dans un gabarit de chaîne)', () => {
    expect(veutHorsTransaction(SQL)).toBe(false);
    expect(SQL).not.toContain('`');
  });

  it('🔴 l’exploitation l’écrit, et la conservation la lit', () => {
    expect(lire('../src/offres/offre.pg.ts')).toMatch(/\bentreprise_quittee_le\b/);
    expect(lire('../src/inbox/retention.ts')).toMatch(/\bentreprise_quittee_le\b/);
  });
});
