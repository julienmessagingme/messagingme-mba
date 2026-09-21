import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * 0162 : les outils maison de l'agent de Meta, et l'accusé de nos envois (spec 2026-09-21-outils-maison-mba).
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE : les deux CHECK, mot pour mot. Le premier RELÂCHE 0159 pour les seuls outils de
 * l'agent de Meta ; le second empêche ce drapeau de servir d'échappatoire à autre chose (un connecteur, une
 * action d'agent). Un CHECK réécrit de mémoire serait le moyen le plus sûr d'en perdre un sens.
 */
const sql = readFileSync(new URL('../db/migrations/0162_outils_maison_mba.sql', import.meta.url), 'utf8');
const compact = sql.replace(/\s+/g, ' ');
/** Le SQL sans ses commentaires : un commentaire qui dit « aucun index » ne doit pas passer pour un index. */
const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

describe('migration 0162', () => {
  it('ajoute le drapeau avec un défaut qui ne change rien aux lignes existantes', () => {
    expect(compact).toContain('add column if not exists pour_agent_meta boolean not null default false');
  });
  it('🔴 relâche 0159 pour les seuls outils de l’agent de Meta', () => {
    expect(compact).toContain('drop constraint if exists agent_tools_action_par_agent_chk');
    expect(compact).toContain("check (origin <> 'mba' or agent_id is not null or pour_agent_meta)");
  });
  it('🔴 le drapeau ne vaut QUE pour un outil maison sans agent', () => {
    expect(compact).toContain("check (not pour_agent_meta or (origin = 'mba' and agent_id is null))");
  });
  it('ajoute l’accusé, nullable, sans défaut ni index', () => {
    expect(compact).toContain('alter table conversation_messages add column if not exists accuse_le timestamptz;');
    expect(code).not.toMatch(/index[^;]*accuse_le/i);
  });
});
