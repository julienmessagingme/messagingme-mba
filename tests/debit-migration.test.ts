import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decouperInstructions, veutHorsTransaction } from '../src/db/migration-directives';

/**
 * LA MIGRATION 0186 (les compteurs des plafonds de débit) ET L'ADAPTATEUR QUI LA LIT NOMMENT LA MÊME TABLE ET LES
 * MÊMES COLONNES.
 *
 * 🔴 ADDITIVE (une table neuve que l'ancien code ignore) : elle passe AVANT le déploiement. Sans elle, chaque appel
 * de `/v1`, `/mcp`, chaque tentative de connexion et chaque opération coûteuse lèverait `42P01` dans le compteur : le
 * plafond de l'API laisserait tout passer (sa politique sur panne) et la connexion refuserait TOUT (la sienne), donc
 * plus personne n'entrerait dans la console.
 */
const lire = (chemin: string): string => readFileSync(new URL(chemin, import.meta.url), 'utf8');
const SQL = lire('../db/migrations/0186_compteurs_debit.sql');
const sansCommentaires = (t: string): string => t.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n');
const instructions = decouperInstructions(SQL)
  .map(sansCommentaires)
  .map((i) => i.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim())
  .filter((i) => i !== '');

describe('migration 0186', () => {
  it('🔴 une table, quatre colonnes non nulles, la clé primaire sur (clé, fenêtre), et rien d’autre', () => {
    expect(instructions).toEqual([
      'create table if not exists compteurs_debit ( cle text not null, fenetre timestamptz not null, n integer not null, expire_le timestamptz not null, primary key (cle, fenetre) )',
    ]);
  });

  it('dans une transaction ordinaire, et sans accent grave (le runner lit le fichier dans un gabarit de chaîne)', () => {
    expect(veutHorsTransaction(SQL)).toBe(false);
    expect(SQL).not.toContain('`');
  });

  it('🔴 l’adaptateur nomme exactement cette table et ces colonnes', () => {
    const adaptateur = lire('../src/db/debit.pg.ts');
    const requetes = [...adaptateur.matchAll(/`([^`]*)`/g)].map((m) => m[1]!).filter((q) => /compteurs_debit/.test(q));
    expect(requetes.length).toBeGreaterThanOrEqual(4);
    const colonnes = new Set(requetes.flatMap((q) => q.match(/\b(cle|fenetre|n|expire_le)\b/g) ?? []));
    expect([...colonnes].sort()).toEqual(['cle', 'expire_le', 'fenetre', 'n']);
  });
});
