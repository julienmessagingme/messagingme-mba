import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decouperInstructions, veutHorsTransaction } from '../src/db/migration-directives';

/**
 * 0245 : les campagnes depuis Claude (plan du 2026-10-20). Ce que seul le texte de la migration peut dire avant qu'elle ne
 * passe en production : la date prévue est NULLABLE (l'ancien code insère sans elle), la confirmation part avec sa
 * campagne, et tout se rejoue sans erreur.
 */
const SQL = readFileSync(new URL('../db/migrations/0245_campagnes_assistant.sql', import.meta.url), 'utf8');
const sansCommentaires = (t: string): string => t.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n');
const instructions = decouperInstructions(SQL).map(sansCommentaires).map((i) => i.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim()).filter((i) => i !== '');
const table = (nom: string): string => instructions.find((i) => i.startsWith(`create table if not exists ${nom} `)) ?? '';

describe('migration 0245', () => {
  it('🔴 dans une transaction, sous un délai de verrou, sans accent grave', () => {
    expect(veutHorsTransaction(SQL)).toBe(false);
    expect(SQL).not.toContain('`');
    expect(instructions[0]).toBe("set local lock_timeout = '5s'");
  });

  it('🔴 la date prévue d’un brouillon : nullable, sans défaut, donc l’ancien code survit', () => {
    expect(instructions).toContain('alter table campaigns add column if not exists prevue_le timestamptz');
  });

  it('🔴 la confirmation : une par campagne, effacée avec elle, le code jamais en clair', () => {
    const t = table('campagne_confirmations');
    expect(t).toContain('campaign_id uuid primary key references campaigns(id) on delete cascade');
    expect(t).toContain('tenant_id uuid not null');
    expect(t).toContain('code_empreinte text not null');
    expect(t).toContain('etat_empreinte text not null');
    expect(t).toContain('expire_le timestamptz not null');
    expect(t).toContain('utilise_le timestamptz');
    expect(t).not.toMatch(/\bcode text\b/);
  });

  it('rejouable : chaque création et chaque ajout portent leur « if not exists »', () => {
    for (const i of instructions.filter((x) => /^(create|alter table .* add column)/.test(x))) {
      expect(i).toMatch(/if not exists/);
    }
    expect(instructions).toHaveLength(3);
  });
});
