import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decouperInstructions, veutHorsTransaction } from '../src/db/migration-directives';
import { MODES_REPONDEUR } from '../src/repondeur/mode';

/**
 * 0224 : « mon application répond » (lot 12, livraison B). Elle RELÂCHE un CHECK (cinq modes au lieu de quatre) et
 * AJOUTE une colonne nullable : l'ancien code y survit, mais un ancien worker lirait le mode inconnu comme « agent »,
 * d'où l'ordre : migration, puis l'API et les DEUX workers dans le même `up`, puis la console.
 */
const SQL = readFileSync(new URL('../db/migrations/0224_repondeur_application.sql', import.meta.url), 'utf8');
const sansCommentaires = (t: string): string => t.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n');
const instructions = decouperInstructions(SQL).map(sansCommentaires).map((i) => i.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim()).filter((i) => i !== '');

describe('migration 0224', () => {
  it('🔴 le CHECK du mode, reposé sous son nom, est EXACTEMENT la liste du code (`MODES_REPONDEUR`)', () => {
    const chk = instructions.find((i) => i.startsWith('alter table tenant_settings add constraint tenant_settings_repondeur_mode_chk'));
    expect([...(chk ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1])).toEqual([...MODES_REPONDEUR]);
    expect(instructions).toContain('alter table tenant_settings drop constraint if exists tenant_settings_repondeur_mode_chk');
  });

  it('🔴 l’adresse désignée en `on delete set null`, et un CHECK à sens unique (l’inverse est atteignable)', () => {
    expect(instructions).toContain(
      'alter table tenant_settings add column if not exists repondeur_adresse_id uuid constraint tenant_settings_repondeur_adresse_fk '
        + 'references adresses_evenements (id) on delete set null',
    );
    expect(instructions).toContain(
      "alter table tenant_settings add constraint tenant_settings_repondeur_adresse_chk check (repondeur_adresse_id is null or repondeur_mode = 'application')",
    );
  });

  it('dans une transaction ordinaire, et sans accent grave', () => {
    expect(veutHorsTransaction(SQL)).toBe(false);
    expect(SQL).not.toContain('`');
  });
});
