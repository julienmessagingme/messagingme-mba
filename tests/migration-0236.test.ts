import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decouperInstructions, veutHorsTransaction } from '../src/db/migration-directives';

/**
 * 0236 : les rapports CSP de la console, agrégés (lot 6 B3). Une table neuve que l'ancien code ne lit pas : elle passe
 * avant le code. Aucune donnée d'espace ni de personne, donc ni `tenant_id` ni purge.
 */
const SQL = readFileSync(new URL('../db/migrations/0236_csp_rapports.sql', import.meta.url), 'utf8');
const sansCommentaires = (t: string): string => t.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n');
const instructions = decouperInstructions(SQL).map(sansCommentaires).map((i) => i.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim()).filter((i) => i !== '');
const table = instructions.find((i) => i.startsWith('create table if not exists csp_rapports ')) ?? '';

describe('migration 0236', () => {
  it('🔴 une ligne par combinaison : la clé est exactement celle du `on conflict` du magasin', () => {
    expect(table).toContain('primary key (directive, bloque, page, disposition)');
    const magasin = readFileSync(new URL('../src/csp/store.pg.ts', import.meta.url), 'utf8');
    expect(magasin).toContain('on conflict (directive, bloque, page, disposition)');
  });

  it('🔴 les longueurs sont bornées par char_length, à celles que le code produit, jamais par une regex', () => {
    expect(table).toContain('constraint csp_rapports_directive_chk check (char_length(directive) between 1 and 64)');
    expect(table).toContain('constraint csp_rapports_bloque_chk check (char_length(bloque) between 1 and 200)');
    expect(table).toContain('constraint csp_rapports_page_chk check (char_length(page) between 1 and 200)');
    expect(table).toContain("constraint csp_rapports_disposition_chk check (disposition in ('report', 'enforce'))");
    expect(SQL).not.toMatch(/~\s*'/);
  });

  it('aucune colonne d’espace ni de personne', () => {
    expect(table).not.toMatch(/tenant_id|user_id|email|ip\b/);
  });

  it('dans une transaction ordinaire, sous un lock_timeout, et sans accent grave', () => {
    expect(veutHorsTransaction(SQL)).toBe(false);
    expect(instructions[0]).toBe("set local lock_timeout = '5s'");
    expect(SQL).not.toContain('`');
  });
});
