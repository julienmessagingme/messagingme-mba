import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decouperInstructions, veutHorsTransaction } from '../src/db/migration-directives';

/**
 * 0242 : l'index qui sert la consommation de la remise à l'agent de Meta, jouée pour chaque accusé (banc des accusés du
 * 2026-10-17). Que la requête du code le choisisse vraiment se vérifie en intégration
 * (`tests/integration/index-remise-mba.integration.test.ts`).
 */
const SQL = readFileSync(new URL('../db/migrations/0242_conversations_index_remise_mba.sql', import.meta.url), 'utf8');
const sansCommentaires = (t: string): string => t.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n');
const instructions = decouperInstructions(SQL).map(sansCommentaires).map((i) => i.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim()).filter((i) => i !== '');

describe('migration 0242', () => {
  it('🔴 hors transaction, une seule instruction rejouable, sans accent grave', () => {
    expect(veutHorsTransaction(SQL)).toBe(true);
    expect(SQL).not.toContain('`');
    expect(instructions).toEqual([
      'create index concurrently if not exists conversations_release_mba_idx on conversations (release_mba_apres_message) where release_mba_apres_message is not null',
    ]);
  });
});
