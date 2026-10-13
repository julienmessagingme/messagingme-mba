import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decouperInstructions, veutHorsTransaction } from '../src/db/migration-directives';

/**
 * 0231 : la raison « moyen de paiement » du blocage d'un compte WhatsApp chez Meta (le guide « compte Meta », plan
 * docs/superpowers/plans/2026-10-13-guide-compte-meta.md). Une colonne que l'ancien code ignore et que le nouveau
 * écrit : elle passe AVANT le code.
 */
const SQL = readFileSync(new URL('../db/migrations/0231_paiement_meta.sql', import.meta.url), 'utf8');
const sansCommentaires = (t: string): string => t.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n');
const instructions = decouperInstructions(SQL).map(sansCommentaires).map((i) => i.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim()).filter((i) => i !== '');

describe('migration 0231', () => {
  it('🔴 nullable et sans défaut : null veut dire « pas encore lu chez Meta », jamais « tout va bien »', () => {
    expect(instructions).toContain('alter table phone_numbers add column if not exists waba_paiement_bloque boolean');
  });

  it('une seule instruction après le lock_timeout, en transaction ordinaire, et sans accent grave', () => {
    expect(veutHorsTransaction(SQL)).toBe(false);
    expect(instructions).toEqual([
      "set local lock_timeout = '5s'",
      'alter table phone_numbers add column if not exists waba_paiement_bloque boolean',
    ]);
    expect(SQL).not.toContain('`');
  });
});
