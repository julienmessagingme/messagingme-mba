import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decouperInstructions, veutHorsTransaction } from '../src/db/migration-directives';

/**
 * 0233 : l'index qui sert la cascade de `agent_actions.conversation_id` (relecture de la livraison A des actions de
 * l'agent IA). Sans lui, chaque conversation effacée par la rétention parcourrait toute la table.
 */
const SQL = readFileSync(new URL('../db/migrations/0233_agent_actions_index_conversation.sql', import.meta.url), 'utf8');
const sansCommentaires = (t: string): string => t.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n');
const instructions = decouperInstructions(SQL).map(sansCommentaires).map((i) => i.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim()).filter((i) => i !== '');

describe('migration 0233', () => {
  it('🔴 hors transaction, une seule instruction rejouable, sans accent grave', () => {
    expect(veutHorsTransaction(SQL)).toBe(true);
    expect(SQL).not.toContain('`');
    expect(instructions).toEqual([
      'create index concurrently if not exists agent_actions_conversation_fk_idx on agent_actions (conversation_id)',
    ]);
  });
});
