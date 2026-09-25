import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decouperInstructions, veutHorsTransaction } from '../src/db/migration-directives';

/**
 * LA MIGRATION 0181 (le plafond de l'API par espace) ET LE CODE QUI LA LIT NOMMENT LES MÊMES COLONNES.
 *
 * 🔴 Deux colonnes NULLABLES SANS DÉFAUT : `null` veut dire « le défaut de la configuration », et un défaut écrit
 * en base figerait la valeur du jour dans chaque ligne. Et un CHECK > 0 : un réglage d'espace ne doit pas pouvoir
 * valoir 0, qui dans la configuration veut dire « aucun plafond ».
 */
const lire = (chemin: string): string => readFileSync(new URL(chemin, import.meta.url), 'utf8');
const SQL = lire('../db/migrations/0181_plafond_api.sql');
const sansCommentaires = (t: string): string => t.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n');
const instructions = decouperInstructions(SQL)
  .map(sansCommentaires)
  .map((i) => i.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim())
  .filter((i) => i !== '');

describe('migration 0181', () => {
  it('🔴 deux colonnes entières, nullables, sans défaut, rejouables, chacune avec son CHECK > 0', () => {
    expect(instructions).toEqual([
      'alter table tenant_settings add column if not exists api_plafond_minute integer constraint tenant_settings_api_plafond_minute_positif check (api_plafond_minute > 0)',
      'alter table tenant_settings add column if not exists api_plafond_heure integer constraint tenant_settings_api_plafond_heure_positif check (api_plafond_heure > 0)',
    ]);
  });

  it('dans une transaction ordinaire : les deux colonnes entrent ensemble ou pas du tout', () => {
    expect(veutHorsTransaction(SQL)).toBe(false);
  });

  it('🔴 le magasin nomme exactement ces deux colonnes, en lecture comme en écriture', () => {
    const magasin = lire('../src/auth/plafond-espace.pg.ts');
    const colonnes = [...new Set(magasin.match(/api_plafond_[a-z]+/g) ?? [])].sort();
    expect(colonnes).toEqual(['api_plafond_heure', 'api_plafond_minute']);
  });
});
