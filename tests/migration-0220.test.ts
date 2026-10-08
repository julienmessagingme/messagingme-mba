import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decouperInstructions, veutHorsTransaction } from '../src/db/migration-directives';

/**
 * 0220 : le numéro inclus dans le Pro (lot 6, livraison B2b). Deux colonnes sur `abonnements_offre`, que seul le code
 * neuf écrit et lit : « rendre le numéro à la fin de ce Pro » (décision de Julien : une colonne) et la date de l'e-mail
 * qui annonce la suite du numéro, envoyé une fois par fin prévue. Additive, avec un défaut sur la colonne NOT NULL :
 * l'ancien code y survit, elle passe AVANT le `up`.
 */
const lire = (chemin: string): string => readFileSync(new URL(chemin, import.meta.url), 'utf8');
const SQL = lire('../db/migrations/0220_numero_inclus.sql');
const sansCommentaires = (t: string): string => t.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n');
const instructions = decouperInstructions(SQL)
  .map(sansCommentaires)
  .map((i) => i.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim())
  .filter((i) => i !== '');

describe('migration 0220', () => {
  it('🔴 deux colonnes ajoutées à abonnements_offre, et rien d’autre : aucune donnée reprise, aucun index', () => {
    expect(instructions).toEqual([
      "set local lock_timeout = '5s'",
      'alter table abonnements_offre add column if not exists rendre_numero boolean not null default false',
      'alter table abonnements_offre add column if not exists suite_annoncee_le timestamptz',
    ]);
  });

  it('dans une transaction ordinaire, et sans accent grave (le runner lit le fichier dans un gabarit de chaîne)', () => {
    expect(veutHorsTransaction(SQL)).toBe(false);
    expect(SQL).not.toContain('`');
  });

  it('🔴 le magasin du Pro nomme exactement ces deux colonnes', () => {
    const store = lire('../src/offres/abonnements-offre.pg.ts');
    expect(store).toMatch(/\brendre_numero\b/);
    expect(store).toMatch(/\bsuite_annoncee_le\b/);
  });
});
