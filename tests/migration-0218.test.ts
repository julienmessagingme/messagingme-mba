import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decouperInstructions, veutHorsTransaction } from '../src/db/migration-directives';

/**
 * 0218 : les offres (lot 6, livraison A). Elle AJOUTE (une table, des colonnes, une fonction) et RELÂCHE (le CHECK de
 * l'état d'analyse), donc elle passe AVANT le `up` : le code neuf lit `offre_de_l_espace`. Ce que la base en fait vraiment :
 * `tests/integration/offres.integration.test.ts`, en CI.
 */
const SQL = readFileSync(new URL('../db/migrations/0218_offres.sql', import.meta.url), 'utf8');
const sansCommentaires = (t: string): string => t.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n');
const instructions = decouperInstructions(SQL)
  .map(sansCommentaires)
  .map((i) => i.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim())
  .filter((i) => i !== '');

describe('migration 0218', () => {
  it('🔴 le plafond d’attente du verrou vient en tête, dans une transaction', () => {
    expect(instructions[0]).toBe("set local lock_timeout = '5s'");
    expect(veutHorsTransaction(SQL)).toBe(false);
  });

  it('🔴 le CHECK de l’état d’analyse garde les quatre états d’hier et ajoute hors_offre, sous son nom lu en base', () => {
    const i = instructions.indexOf('alter table conversations drop constraint if exists conversations_analysis_status_check');
    expect(i).toBeGreaterThan(-1);
    expect(instructions[i + 1]).toBe(
      "alter table conversations add constraint conversations_analysis_status_check check (analysis_status in ('pending', 'queued', 'done', 'failed', 'hors_offre'))",
    );
  });

  it('🔴 une fiche existante n’est pas marquée « née d’un entrant » : la colonne vaut false par défaut', () => {
    expect(instructions).toContain('alter table contacts add column if not exists ne_entrant boolean not null default false');
  });

  it('🔴 la reprise passe TOUS les espaces existants en Entreprise, sans limite d’utilisateurs', () => {
    const code = sansCommentaires(SQL);
    expect(code).toMatch(/^update tenants set offre_entreprise = true where not offre_entreprise;$/m);
    expect(code).not.toMatch(/entreprise_utilisateurs\s*=/);
    expect(code.match(/^\s*(update|insert|delete|truncate)\b/gim)).toHaveLength(1);
  });

  it('une seule définition de l’offre, et sans accent grave (il fermerait un gabarit de chaîne)', () => {
    expect(SQL.match(/create or replace function offre_de_l_espace/g)).toHaveLength(1);
    expect(SQL).not.toContain('`');
  });
});
