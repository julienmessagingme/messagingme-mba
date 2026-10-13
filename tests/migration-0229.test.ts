import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decouperInstructions, veutHorsTransaction } from '../src/db/migration-directives';
import { MAX_NOM_DOSSIER, TYPES_DOSSIER } from '../src/dossiers/regles';

/**
 * 0229 : les dossiers qui rangent les scénarios et les templates (décision de Julien du 2026-10-13). Des objets neufs et
 * une colonne nullable : l'ancien code n'en lit rien, elle passe seule et avant le code.
 */
const SQL = readFileSync(new URL('../db/migrations/0229_dossiers.sql', import.meta.url), 'utf8');
const sansCommentaires = (t: string): string => t.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n');
const instructions = decouperInstructions(SQL).map(sansCommentaires).map((i) => i.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim()).filter((i) => i !== '');
const table = (nom: string): string => instructions.find((i) => i.startsWith(`create table if not exists ${nom} `)) ?? '';

describe('migration 0229', () => {
  it('🔴 le type d’un dossier est EXACTEMENT la liste du code (`TYPES_DOSSIER`)', () => {
    const chk = /constraint dossiers_type_chk check \(type in \(([^)]*)\)\)/.exec(table('dossiers'));
    expect([...(chk?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1])).toEqual([...TYPES_DOSSIER]);
  });

  it('🔴 le nom est borné par char_length, à la borne du code, et jamais par une répétition de regex', () => {
    // Postgres refuse une répétition au-delà de 255, et ce refus tombe à CHAQUE insertion, pas à la migration.
    expect(table('dossiers')).toContain(`constraint dossiers_nom_chk check (char_length(nom) between 1 and ${MAX_NOM_DOSSIER})`);
    expect(SQL).not.toMatch(/~\s*'/);
  });

  it('🔴 un nom unique par espace et par type, sans tenir compte de la casse', () => {
    expect(instructions).toContain('create unique index if not exists dossiers_nom_unique on dossiers (tenant_id, type, lower(nom))');
  });

  it('🔴 supprimer un dossier ne perd rien : les scénarios repassent à null, les rangements de templates partent', () => {
    expect(instructions).toContain('alter table workflows add column if not exists dossier_id uuid constraint workflows_dossier_fk references dossiers(id) on delete set null');
    expect(table('template_dossiers')).toContain('constraint template_dossiers_dossier_fk references dossiers(id) on delete cascade');
    // Et l'espace emporte tout : aucune purge à modifier.
    expect(table('dossiers')).toContain('references tenants(id) on delete cascade');
    expect(table('template_dossiers')).toContain('references tenants(id) on delete cascade');
  });

  it('un template se range par son nom, une fois par espace', () => {
    expect(table('template_dossiers')).toContain('primary key (tenant_id, template_name)');
  });

  it('la mise à null d’une suppression trouve ses scénarios par un index partiel', () => {
    expect(instructions).toContain('create index if not exists workflows_dossier_idx on workflows (dossier_id) where dossier_id is not null');
  });

  it('dans une transaction ordinaire, sous un lock_timeout, et sans accent grave', () => {
    expect(veutHorsTransaction(SQL)).toBe(false);
    expect(instructions[0]).toBe("set local lock_timeout = '5s'");
    expect(SQL).not.toContain('`');
  });
});
