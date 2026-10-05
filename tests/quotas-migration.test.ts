import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decouperInstructions, veutHorsTransaction } from '../src/db/migration-directives';

/**
 * LA MIGRATION 0208 (les quotas quotidiens de l'API par espace) ET LE CODE QUI LA LIT NOMMENT LES MÊMES COLONNES.
 * Même forme que 0181 : deux colonnes nullables sans défaut (null = le défaut de la configuration), un CHECK > 0 (un
 * réglage d'espace ne doit pas valoir 0, qui veut dire « aucun quota »), et un délai de verrou de 5 s.
 */
const lire = (chemin: string): string => readFileSync(new URL(chemin, import.meta.url), 'utf8');
const SQL = lire('../db/migrations/0208_quotas_api.sql');
const sansCommentaires = (t: string): string => t.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n');
const instructions = decouperInstructions(SQL)
  .map(sansCommentaires)
  .map((i) => i.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim())
  .filter((i) => i !== '');

describe('migration 0208', () => {
  it('🔴 deux colonnes entières, nullables, sans défaut, rejouables, chacune avec son CHECK > 0, sous un délai de verrou', () => {
    expect(instructions).toEqual([
      "set lock_timeout = '5s'",
      'alter table tenant_settings add column if not exists api_quota_envois_jour integer constraint tenant_settings_api_quota_envois_jour_positif check (api_quota_envois_jour > 0)',
      'alter table tenant_settings add column if not exists api_quota_fiches_jour integer constraint tenant_settings_api_quota_fiches_jour_positif check (api_quota_fiches_jour > 0)',
      'reset lock_timeout',
    ]);
  });

  it('dans une transaction ordinaire : les deux colonnes entrent ensemble ou pas du tout', () => {
    expect(veutHorsTransaction(SQL)).toBe(false);
  });

  it('🔴 le magasin nomme exactement ces deux colonnes, en lecture comme en écriture', () => {
    const magasin = lire('../src/auth/plafond-espace.pg.ts');
    const colonnes = [...new Set(magasin.match(/api_quota_[a-z_]+/g) ?? [])].sort();
    expect(colonnes).toEqual(['api_quota_envois_jour', 'api_quota_fiches_jour']);
  });
});
