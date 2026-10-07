import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decouperInstructions, veutHorsTransaction } from '../src/db/migration-directives';

/**
 * 0219 : la trace des espaces supprimés (RC8). Elle CRÉE une table que seul le code neuf écrit (la purge, dans sa
 * transaction) et lit (la pierre tombale des jobs de file) : elle passe AVANT le `up`. Ce que la base en fait vraiment
 * (la ligne écrite avec la purge, l'espace voisin intact) : `tests/integration/suppression-espace.integration.test.ts`,
 * en CI.
 */
const lire = (chemin: string): string => readFileSync(new URL(chemin, import.meta.url), 'utf8');
const SQL = lire('../db/migrations/0219_espaces_supprimes.sql');
const sansCommentaires = (t: string): string => t.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n');
const instructions = decouperInstructions(SQL)
  .map(sansCommentaires)
  .map((i) => i.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim())
  .filter((i) => i !== '');

describe('migration 0219', () => {
  it('🔴 une table, la clé primaire sur l’espace, et AUCUNE clé étrangère : l’espace n’existe plus', () => {
    // Une clé vers `tenants` ferait échouer la purge elle-même (la ligne s'écrit après le `delete from tenants`).
    expect(instructions).toEqual([
      'create table if not exists espaces_supprimes ( tenant_id uuid primary key, nom text not null, cree_le timestamptz, '
        + 'supprime_le timestamptz not null default now(), par text not null, etapes jsonb not null, comptes jsonb not null )',
    ]);
    expect(sansCommentaires(SQL)).not.toMatch(/\breferences\b/i);
  });

  it('dans une transaction ordinaire, et sans accent grave (le runner lit le fichier dans un gabarit de chaîne)', () => {
    expect(veutHorsTransaction(SQL)).toBe(false);
    expect(SQL).not.toContain('`');
  });

  it('🔴 la purge et la pierre tombale nomment exactement cette table et ses colonnes', () => {
    const purge = lire('../src/ops/suppression-espace.pg.ts');
    expect(purge).toMatch(/insert into espaces_supprimes \(tenant_id, nom, cree_le, par, etapes, comptes\)/);
    expect(lire('../src/ops/espaces-supprimes.pg.ts')).toMatch(/from espaces_supprimes where tenant_id = \$1/);
  });
});
