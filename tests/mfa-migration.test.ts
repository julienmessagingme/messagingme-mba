import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decouperInstructions, veutHorsTransaction } from '../src/db/migration-directives';

/**
 * LA MIGRATION 0182 (le second facteur) ET LE MAGASIN QUI LA LIT NOMMENT LES MÊMES COLONNES.
 *
 * 🔴 ADDITIVE, nullable, SANS défaut, rejouable : `null` veut dire « aucun facteur », l'état de tout le monde avant
 * elle. Elle passe AVANT le déploiement, parce que `findIdentity` lit `mfa_active_le` à chaque connexion.
 */
const lire = (chemin: string): string => readFileSync(new URL(chemin, import.meta.url), 'utf8');
const SQL = lire('../db/migrations/0182_mfa_identites.sql');
const sansCommentaires = (t: string): string => t.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n');
const instructions = decouperInstructions(SQL)
  .map(sansCommentaires)
  .map((i) => i.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim())
  .filter((i) => i !== '');

describe('migration 0182', () => {
  it('🔴 quatre colonnes nullables SANS défaut sur identities, et la table des codes en cascade sur l’identité', () => {
    expect(instructions).toEqual([
      'alter table identities add column if not exists mfa_secret_enc text',
      'alter table identities add column if not exists mfa_active_le timestamptz',
      'alter table identities add column if not exists mfa_dernier_pas bigint',
      'alter table identities add column if not exists mfa_secret_attente_enc text',
      'create table if not exists mfa_codes_secours ( identity_id uuid not null references identities (id) on delete cascade, code_hash text not null, utilise_le timestamptz, primary key (identity_id, code_hash) )',
    ]);
  });

  it('dans une transaction ordinaire, et sans accent grave (le runner lit le fichier dans un gabarit de chaîne)', () => {
    expect(veutHorsTransaction(SQL)).toBe(false);
    expect(SQL).not.toContain('`');
  });

  it('🔴 le magasin et la connexion nomment exactement ces colonnes, et aucune autre', () => {
    const magasin = lire('../src/auth/mfa-store.pg.ts') + lire('../src/auth/store.ts');
    // La table et l'alias de `findIdentity` (`mfa_actif`) ne sont pas des colonnes d'identities.
    const colonnes = [...new Set(magasin.match(/\bmfa_[a-z_]+/g) ?? [])].filter((c) => c !== 'mfa_codes_secours' && c !== 'mfa_actif').sort();
    expect(colonnes).toEqual(['mfa_active_le', 'mfa_dernier_pas', 'mfa_secret_attente_enc', 'mfa_secret_enc']);
  });
});
