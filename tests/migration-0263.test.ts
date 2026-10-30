import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decouperInstructions, veutHorsTransaction } from '../src/db/migration-directives';
import { REPONDEURS_ETAGE } from '../src/campaign/etages';

/**
 * 0263 : le répondeur d'un étage de campagne (plan docs/superpowers/plans/2026-10-30-repondeur-par-etage.md, tâche 1).
 * Deux colonnes de `campaign_etages` que l'ancien code ignore et que le nouveau écrit (la création d'une campagne) et lit
 * (la remise de chaque entrant) : elles passent AVANT le code. Ce que la base doit refuser, et ce qu'elle doit laisser
 * passer, ne se prouve que contre Postgres (`tests/integration/repondeur-par-etage.integration.test.ts`) ; ce fichier
 * garde la FORME des instructions, dont les deux pièges du NULL.
 */
const SQL = readFileSync(new URL('../db/migrations/0263_etage_repondeur.sql', import.meta.url), 'utf8');
const sansCommentaires = (t: string): string => t.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n');
const instructions = decouperInstructions(SQL)
  .map(sansCommentaires)
  .map((i) => i.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim())
  .filter((i) => i !== '');

describe('migration 0263', () => {
  it('🔴 l’agent IA est une clé étrangère en on delete set null, sous un nom : supprimer l’agent ne détruit pas l’étage', () => {
    expect(instructions).toContain('alter table campaign_etages add column if not exists repondeur_agent_id uuid '
      + 'constraint campaign_etages_repondeur_agent_fk references agents (id) on delete set null');
  });

  it('🔴 les deux CHECK de cohérence sont écrits sans le piège du NULL (un CHECK qui vaut NULL passe)', () => {
    expect(instructions).toContain("alter table campaign_etages add constraint campaign_etages_repondeur_devenir_chk check (repondeur is null or devenir is not distinct from 'mba')");
    expect(instructions).toContain("alter table campaign_etages add constraint campaign_etages_repondeur_agent_chk check (repondeur_agent_id is null or repondeur is not distinct from 'agent')");
    // La forme fautive, cherchée dans le code et pas dans les commentaires (qui la citent pour l'interdire) : sur un
    // devenir nul, `devenir = 'mba'` vaut NULL et le CHECK laisse passer un répondeur.
    const code = instructions.join('\n');
    expect(code).not.toMatch(/devenir = 'mba'/);
    expect(code).not.toMatch(/repondeur = 'agent'/);
  });

  it('🔴 AUCUN CHECK « agent exige un identifiant » : le set null de la suppression d’un agent le violerait (23514)', () => {
    for (const i of instructions) {
      expect(i, i).not.toMatch(/repondeur_agent_id is not null/);
      expect(i, i).not.toMatch(/repondeur <> 'agent'|repondeur != 'agent'|repondeur is distinct from 'agent'/);
    }
  });

  it('les valeurs du CHECK sont celles que le code valide (`REPONDEURS_ETAGE`), lues dans le fichier', () => {
    const check = /campaign_etages_repondeur_chk check \(repondeur is null or repondeur in \(([^)]*)\)\)/.exec(instructions.join('\n'));
    expect(check, 'le CHECK des valeurs n’est plus écrit sous cette forme : ce test ne garde plus rien').not.toBeNull();
    const valeurs = check![1]!.split(',').map((v) => v.trim().replace(/^'|'$/g, ''));
    expect(valeurs).toEqual([...REPONDEURS_ETAGE]);
  });

  it('ses instructions, dans l’ordre, après le lock_timeout, en transaction ordinaire et sans accent grave', () => {
    expect(veutHorsTransaction(SQL)).toBe(false);
    expect(instructions).toEqual([
      "set local lock_timeout = '5s'",
      'alter table campaign_etages add column if not exists repondeur text',
      'alter table campaign_etages add column if not exists repondeur_agent_id uuid '
        + 'constraint campaign_etages_repondeur_agent_fk references agents (id) on delete set null',
      'alter table campaign_etages drop constraint if exists campaign_etages_repondeur_chk',
      "alter table campaign_etages add constraint campaign_etages_repondeur_chk check (repondeur is null or repondeur in ('mba', 'agent'))",
      'alter table campaign_etages drop constraint if exists campaign_etages_repondeur_devenir_chk',
      "alter table campaign_etages add constraint campaign_etages_repondeur_devenir_chk check (repondeur is null or devenir is not distinct from 'mba')",
      'alter table campaign_etages drop constraint if exists campaign_etages_repondeur_agent_chk',
      "alter table campaign_etages add constraint campaign_etages_repondeur_agent_chk check (repondeur_agent_id is null or repondeur is not distinct from 'agent')",
    ]);
    expect(SQL).not.toContain('`');
  });
});
