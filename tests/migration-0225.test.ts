import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decouperInstructions, veutHorsTransaction } from '../src/db/migration-directives';
import { STATUTS_MESSAGE } from '../src/api/conversations-v1';

/**
 * 0225 : le statut de livraison d'un message seul (lot 13, domaine 1, livraison B). Deux colonnes nullables SANS défaut
 * (aucune réécriture d'une table chaude) et un CHECK sous son nom, EXACTEMENT les statuts du code.
 */
const SQL = readFileSync(new URL('../db/migrations/0225_statut_message.sql', import.meta.url), 'utf8');
const sansCommentaires = (t: string): string => t.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n');
const instructions = decouperInstructions(SQL).map(sansCommentaires).map((i) => i.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim()).filter((i) => i !== '');

describe('migration 0225', () => {
  it('🔴 deux colonnes nullables SANS défaut : un défaut réécrirait conversation_messages, sur le chemin de chaque message', () => {
    expect(instructions).toContain('alter table conversation_messages add column if not exists statut text');
    expect(instructions).toContain('alter table conversation_messages add column if not exists statut_le timestamptz');
    expect(SQL.toLowerCase()).not.toContain('default');
  });

  it('🔴 le CHECK, reposé sous son nom, est EXACTEMENT la liste du code (`STATUTS_MESSAGE`)', () => {
    const chk = instructions.find((i) => i.startsWith('alter table conversation_messages add constraint conversation_messages_statut_chk'));
    expect([...(chk ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1])).toEqual([...STATUTS_MESSAGE]);
    expect(instructions).toContain('alter table conversation_messages drop constraint if exists conversation_messages_statut_chk');
    // NOT VALID : rien à balayer sur une colonne neuve, donc aucun verrou exclusif qui dure avec la taille de la table.
    expect(chk).toMatch(/ not valid$/);
  });

  it('dans une transaction ordinaire, sous un lock_timeout, et sans accent grave', () => {
    expect(veutHorsTransaction(SQL)).toBe(false);
    expect(instructions).toContain("set local lock_timeout = '5s'");
    expect(SQL).not.toContain('`');
  });
});
