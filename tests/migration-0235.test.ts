import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decouperInstructions, veutHorsTransaction } from '../src/db/migration-directives';

/**
 * 0235 : les seuils franchis des limites du Free (lot 7, livraison B). Une ligne par espace et par seuil, effacée avec
 * l'espace ; c'est la clé primaire qui rend le franchissement unique.
 */
const SQL = readFileSync(new URL('../db/migrations/0235_emails_produit_seuils.sql', import.meta.url), 'utf8');
const sansCommentaires = (t: string): string => t.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n');
const instructions = decouperInstructions(SQL).map(sansCommentaires).map((i) => i.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim()).filter((i) => i !== '');

describe('migration 0235', () => {
  it('🔴 dans une transaction, sous un délai de verrou, sans accent grave, une seule table additive', () => {
    expect(veutHorsTransaction(SQL)).toBe(false);
    expect(SQL).not.toContain('`');
    expect(instructions).toHaveLength(2);
    expect(instructions[0]).toBe("set local lock_timeout = '5s'");
  });

  it('🔴 une ligne par espace et par seuil, effacée avec l’espace', () => {
    const table = instructions[1]!;
    expect(table).toMatch(/^create table if not exists emails_produit_seuils /);
    expect(table).toContain('tenant_id uuid not null references tenants(id) on delete cascade');
    expect(table).toContain('primary key (tenant_id, seuil)');
    expect(table).toContain('atteint boolean not null default false');
    expect(table).toContain('generation integer not null default 0');
  });
});
