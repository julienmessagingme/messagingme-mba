import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decouperInstructions, veutHorsTransaction } from '../src/db/migration-directives';

/**
 * 0253 : la coexistence (plan docs/superpowers/plans/2026-10-24-coexistence.md, tâche 1). Deux colonnes de
 * `phone_numbers` que l'ancien code ignore et que le nouveau écrit (le rattachement) et lit (la lecture du numéro) :
 * elles passent AVANT le code.
 */
const SQL = readFileSync(new URL('../db/migrations/0253_coexistence.sql', import.meta.url), 'utf8');
const sansCommentaires = (t: string): string => t.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n');
const instructions = decouperInstructions(SQL)
  .map(sansCommentaires)
  .map((i) => i.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim())
  .filter((i) => i !== '');

describe('migration 0253', () => {
  it('🔴 coexistence : non nulle et fausse par défaut, une constante (l’ajout ne réécrit pas la table) qui laisse chaque numéro d’avant hors coexistence', () => {
    expect(instructions).toContain('alter table phone_numbers add column if not exists coexistence boolean not null default false');
  });

  it('la date de la coupure : nullable et sans défaut, nulle tant que la coexistence tient (servie au lot 2)', () => {
    expect(instructions).toContain('alter table phone_numbers add column if not exists coexistence_coupee_le timestamptz');
  });

  it('deux instructions après le lock_timeout, en transaction ordinaire, et sans accent grave', () => {
    expect(veutHorsTransaction(SQL)).toBe(false);
    expect(instructions).toEqual([
      "set local lock_timeout = '5s'",
      'alter table phone_numbers add column if not exists coexistence boolean not null default false',
      'alter table phone_numbers add column if not exists coexistence_coupee_le timestamptz',
    ]);
    expect(SQL).not.toContain('`');
  });
});
