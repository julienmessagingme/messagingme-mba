import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decouperInstructions, veutHorsTransaction } from '../src/db/migration-directives';

/**
 * LA MIGRATION 0185 (les verrous courts) ET L'ADAPTATEUR QUI LA LIT NOMMENT LA MÊME TABLE ET LES MÊMES COLONNES.
 *
 * 🔴 ADDITIVE (une table neuve que l'ancien code ignore) : elle passe AVANT le déploiement, parce que le relais de
 * l'agent de Meta et la publication la lisent dès le premier appel. Sans elle, chaque geste d'envoi lèverait
 * `42P01` et plus aucun outil maison qui envoie ne partirait.
 */
const lire = (chemin: string): string => readFileSync(new URL(chemin, import.meta.url), 'utf8');
const SQL = lire('../db/migrations/0185_verrous_courts.sql');
const sansCommentaires = (t: string): string => t.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n');
const instructions = decouperInstructions(SQL)
  .map(sansCommentaires)
  .map((i) => i.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim())
  .filter((i) => i !== '');

describe('migration 0185', () => {
  it('🔴 une table, trois colonnes non nulles, la clé primaire sur la clé, et rien d’autre', () => {
    expect(instructions).toEqual([
      'create table if not exists verrous_courts ( cle text primary key, jeton text not null, expire_le timestamptz not null )',
    ]);
  });

  it('dans une transaction ordinaire, et sans accent grave (le runner lit le fichier dans un gabarit de chaîne)', () => {
    expect(veutHorsTransaction(SQL)).toBe(false);
    expect(SQL).not.toContain('`');
  });

  it('🔴 l’adaptateur nomme exactement cette table et ces colonnes', () => {
    const adaptateur = lire('../src/db/verrous-courts.pg.ts');
    const requetes = [...adaptateur.matchAll(/`([^`]*)`/g)].map((m) => m[1]!).filter((q) => /verrous_courts/.test(q));
    expect(requetes.length).toBeGreaterThanOrEqual(3);
    const colonnes = new Set(requetes.flatMap((q) => q.match(/\b(cle|jeton|expire_le)\b/g) ?? []));
    expect([...colonnes].sort()).toEqual(['cle', 'expire_le', 'jeton']);
  });
});
