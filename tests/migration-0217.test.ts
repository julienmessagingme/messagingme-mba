import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decouperInstructions, veutHorsTransaction } from '../src/db/migration-directives';
import { TYPES_EVENEMENT } from '../src/inbox/evenements';
import { DELAI_SCENARIO_DEFAUT_S, DELAI_SCENARIO_MAX_S, DELAI_SCENARIO_MIN_S } from '../src/repondeur/mode';

/**
 * 0217 : qui répond au client (RC6). Elle AJOUTE (le mode, le scénario et son délai, la date du dernier départ du
 * scénario répondeur par contact), RELÂCHE (la contrainte d'une seule voix part, le CHECK des types d'événements
 * s'élargit à `mba_indisponible`) et REPREND (le mode de chaque espace, depuis l'état d'avant) : elle passe AVANT le
 * `up`. Ce que la base en fait vraiment (les CHECK à sens unique sous leur nom, la suppression d'un agent ou d'un
 * scénario qui ne lève pas, la réclamation atomique) : `tests/integration/repondeur.integration.test.ts`, en CI.
 */
const lire = (chemin: string): string => readFileSync(new URL(chemin, import.meta.url), 'utf8');
const SQL = lire('../db/migrations/0217_qui_repond.sql');
const sansCommentaires = (t: string): string => t.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n');
const instructions = decouperInstructions(SQL)
  .map(sansCommentaires)
  .map((i) => i.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim())
  .filter((i) => i !== '');
const indice = (debut: string): number => instructions.findIndex((i) => i.startsWith(debut));

describe('migration 0217', () => {
  it('🔴 le plafond d’attente du verrou vient en tête, dans une transaction', () => {
    expect(instructions[0]).toBe("set local lock_timeout = '5s'");
    // Le drop et l'add de chaque CHECK, et la reprise, ne laissent aucune fenêtre : tout ou rien.
    expect(veutHorsTransaction(SQL)).toBe(false);
  });

  it('🔴 la contrainte d’une seule voix PART, avant tout : un agent IA répondeur et l’agent de Meta allumé coexistent', () => {
    expect(instructions[1]).toBe('alter table tenant_settings drop constraint if exists tenant_settings_repondeur_une_voix_chk');
    expect(instructions.filter((i) => i.includes('une_voix') && !i.includes('drop constraint'))).toEqual([]);
  });

  it('🔴 le mode : défaut `equipe`, et son CHECK à ses QUATRE valeurs d’alors (0224 le repose à cinq)', () => {
    expect(instructions).toContain("alter table tenant_settings add column if not exists repondeur_mode text not null default 'equipe'");
    const chk = instructions.find((i) => i.startsWith('alter table tenant_settings add constraint tenant_settings_repondeur_mode_chk'));
    expect(chk).toBeDefined();
    expect([...(chk ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1])).toEqual(['mba', 'agent', 'scenario', 'equipe']);
  });

  it('🔴 le scénario en `on delete set null`, le délai au défaut et aux bornes du code', () => {
    expect(instructions).toContain(
      'alter table tenant_settings add column if not exists repondeur_workflow_id uuid constraint tenant_settings_repondeur_workflow_fk references workflows (id) on delete set null',
    );
    expect(instructions).toContain(
      `alter table tenant_settings add column if not exists repondeur_delai_scenario_s integer not null default ${DELAI_SCENARIO_DEFAUT_S}`,
    );
    expect(instructions).toContain(
      `alter table tenant_settings add constraint tenant_settings_repondeur_delai_chk check (repondeur_delai_scenario_s between ${DELAI_SCENARIO_MIN_S} and ${DELAI_SCENARIO_MAX_S})`,
    );
    // Nullable, sans défaut : aucun contact n'a encore vu partir de scénario répondeur.
    expect(instructions).toContain('alter table contacts add column if not exists repondeur_scenario_le timestamptz');
  });

  it('🔴 les CHECK À SENS UNIQUE (leçon de 0144) : une cible n’existe que dans son mode, jamais l’inverse', () => {
    // L'inverse (un mode `agent` sans agent) est l'état qu'une suppression laisse : le refuser ferait échouer la
    // suppression d'un agent ou d'un scénario.
    expect(instructions).toContain(
      "alter table tenant_settings add constraint tenant_settings_repondeur_agent_chk check (repondeur_agent_id is null or repondeur_mode = 'agent')",
    );
    expect(instructions).toContain(
      "alter table tenant_settings add constraint tenant_settings_repondeur_scenario_chk check (repondeur_workflow_id is null or repondeur_mode = 'scenario')",
    );
    expect(SQL).not.toMatch(/repondeur_mode <> 'agent' or repondeur_agent_id is not null/);
  });

  it('🔴 la reprise : agent, sinon MBA, sinon équipe ; APRÈS l’ajout de la colonne, AVANT les CHECK à sens unique', () => {
    const reprise = indice('update tenant_settings set repondeur_mode');
    expect(instructions[reprise]).toBe(
      "update tenant_settings set repondeur_mode = case when repondeur_agent_id is not null then 'agent' when mba_enabled then 'mba' else 'equipe' end",
    );
    expect(reprise).toBeGreaterThan(indice('alter table tenant_settings add column if not exists repondeur_mode'));
    // Posé avant la reprise, le CHECK de l'agent refuserait chaque espace à agent IA, encore en `equipe` par défaut.
    expect(reprise).toBeLessThan(indice('alter table tenant_settings add constraint tenant_settings_repondeur_agent_chk'));
    // Aucune autre écriture de données : ni suppression, ni insertion.
    expect(sansCommentaires(SQL)).not.toMatch(/^\s*(insert|delete|truncate)\b/im);
    expect(sansCommentaires(SQL)).not.toMatch(/\bdrop (table|column|index)\b/i);
  });

  it('🔴 le comptage d’avant et d’après est écrit dans la migration, avec la même règle que la reprise', () => {
    const commentaires = SQL.replace(/\s+/g, ' ');
    expect(commentaires).toContain("-- select case when repondeur_agent_id is not null then 'agent' when mba_enabled then 'mba' else 'equipe' end as mode,");
    expect(commentaires).toContain('-- select repondeur_mode, count(*) from public.tenant_settings group by 1 order by 1;');
  });

  it('🔴 le CHECK des types est EXACTEMENT la liste du code, sous le nom que 0192 a posé, `mba_indisponible` en dernier', () => {
    const i = instructions.indexOf('alter table conversation_evenements drop constraint if exists conversation_evenements_type_check');
    expect(i).toBeGreaterThan(-1);
    const pose = instructions[i + 1] ?? '';
    expect(pose).toMatch(/^alter table conversation_evenements add constraint conversation_evenements_type_check check \(type in \(/);
    const types = [...pose.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(types).toEqual([...TYPES_EVENEMENT]);
    expect(types.at(-1)).toBe('mba_indisponible');
  });

  it('sans accent grave : un commentaire SQL n’en porte pas', () => {
    expect(SQL).not.toContain('`');
  });
});
