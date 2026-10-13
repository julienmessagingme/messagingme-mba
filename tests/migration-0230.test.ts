import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decouperInstructions, veutHorsTransaction } from '../src/db/migration-directives';

/**
 * 0230 : le second facteur des administrateurs, au choix de l'espace (décision de Julien du 2026-10-13). Une colonne
 * que l'ancien code ignore : elle passe avant le code qui la lit.
 */
const SQL = readFileSync(new URL('../db/migrations/0230_second_facteur_espace.sql', import.meta.url), 'utf8');
const sansCommentaires = (t: string): string => t.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n');
const instructions = decouperInstructions(SQL).map(sansCommentaires).map((i) => i.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim()).filter((i) => i !== '');

describe('migration 0230', () => {
  it('🔴 faux par défaut et jamais nul : un espace qui ne l’a pas choisi n’exige rien, espaces existants compris', () => {
    expect(instructions).toContain('alter table tenants add column if not exists second_facteur_admins boolean not null default false');
  });

  it('une seule instruction après le lock_timeout, en transaction ordinaire, et sans accent grave', () => {
    expect(veutHorsTransaction(SQL)).toBe(false);
    expect(instructions).toEqual([
      "set local lock_timeout = '5s'",
      'alter table tenants add column if not exists second_facteur_admins boolean not null default false',
    ]);
    expect(SQL).not.toContain('`');
  });
});
