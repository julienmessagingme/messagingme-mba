import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decouperInstructions, veutHorsTransaction } from '../src/db/migration-directives';
import { TYPES_EVENEMENT } from '../src/inbox/evenements';

/**
 * 0232 : les actions de l'agent IA (plan docs/superpowers/plans/2026-10-13-actions-agent.md). Elle AJOUTE la table
 * qui retient qu'une action est partie (une fois par jour, par contact et par action) et RELÂCHE le CHECK des types de
 * la frise à `action_agent` : elle passe AVANT le code qui écrit l'une et l'autre. L'ancien code n'écrit ni la table ni
 * ce type : il y survit.
 */
const SQL = readFileSync(new URL('../db/migrations/0232_actions_agent.sql', import.meta.url), 'utf8');
const sansCommentaires = (t: string): string => t.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n');
const instructions = decouperInstructions(SQL).map(sansCommentaires).map((i) => i.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim()).filter((i) => i !== '');

describe('migration 0232', () => {
  it('🔴 le plafond d’attente du verrou en tête, en transaction ordinaire, sans accent grave', () => {
    expect(instructions[0]).toBe("set local lock_timeout = '5s'");
    expect(veutHorsTransaction(SQL)).toBe(false);
    expect(SQL).not.toContain('`');
  });

  it('🔴 une action par jour, par contact et par action : la contrainte d’unicité, sous son nom', () => {
    const table = instructions.find((i) => i.startsWith('create table if not exists agent_actions'));
    expect(table).toBeDefined();
    expect(table).toContain('constraint agent_actions_une_par_jour unique (tool_id, wa_id, jour)');
  });

  it('🔴 tout s’efface avec son espace, son outil, son agent ou sa conversation (les champs recueillis sont des données du contact)', () => {
    const table = instructions.find((i) => i.startsWith('create table if not exists agent_actions')) ?? '';
    for (const ref of ['references tenants(id) on delete cascade', 'references agent_tools(id) on delete cascade',
      'references agents(id) on delete cascade', 'references conversations(id) on delete cascade']) {
      expect(table).toContain(ref);
    }
  });

  it('🔴 le CHECK de la frise reposé sous son nom, avec action_agent en dernier : le miroir de TYPES_EVENEMENT', () => {
    expect(instructions).toContain('alter table conversation_evenements drop constraint if exists conversation_evenements_type_check');
    const pose = instructions.find((i) => i.startsWith('alter table conversation_evenements add constraint conversation_evenements_type_check'));
    expect(pose).toBeDefined();
    const types = [...(pose ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(types).toEqual([...TYPES_EVENEMENT]);
    expect(types.at(-1)).toBe('action_agent');
  });
});
