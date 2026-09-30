import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decouperInstructions, veutHorsTransaction } from '../src/db/migration-directives';
import { ACTIONS, HANDLED_BY, INTENTS, NOTE_MAX, NOTE_MIN, SENTIMENTS, SUJET_MAX } from '../src/analysis/schema';

/**
 * LA MIGRATION 0196 ET LE SCHÉMA DE L'ANALYSE PARLENT DES MÊMES CODES (Tout sur la fiche, lot 1).
 *
 * 🔴 La copie de l'analyse sur la fiche s'écrit dans la TRANSACTION de `save` : une valeur que Zod accepte et que
 * ces CHECK refusent ferait échouer l'analyse entière, et le job la rejouerait, appel au modèle compris, jusqu'à
 * la DLQ. La parité se DÉRIVE du fichier SQL et de `src/analysis/schema.ts`, rien n'est recopié ici.
 */
const SQL = readFileSync(new URL('../db/migrations/0196_fiche_analyse.sql', import.meta.url), 'utf8');
// Sans les commentaires : un commentaire d'en-tête voyage avec l'instruction qui le suit, et il cite des noms.
const instructions = decouperInstructions(SQL).map((i) => i.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n'));
const codes = (texte: string): string[] => [...texte.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]!);
const colonne = (nom: string): string => {
  const i = instructions.find((x) => x.includes(`add column if not exists ${nom} `));
  expect(i, `la colonne ${nom} n’est plus ajoutée par 0196`).toBeDefined();
  return i!;
};

describe('migration 0196', () => {
  it('🔴 les listes fermées des CHECK sont exactement celles du schéma', () => {
    expect(codes(colonne('analyse_intention')).sort()).toEqual([...INTENTS].sort());
    expect(codes(colonne('analyse_sentiment')).sort()).toEqual([...SENTIMENTS].sort());
    expect(codes(colonne('analyse_traitee_par')).sort()).toEqual([...HANDLED_BY].sort());
    expect(codes(colonne('analyse_action')).sort()).toEqual([...ACTIONS].sort());
  });

  it('🔴 les notes et le sujet sont bornés comme dans le schéma', () => {
    expect(colonne('analyse_satisfaction')).toContain(`between ${NOTE_MIN} and ${NOTE_MAX}`);
    expect(colonne('analyse_urgence')).toContain(`between ${NOTE_MIN} and ${NOTE_MAX}`);
    expect(colonne('analyse_sujet')).toContain(`char_length(analyse_sujet) between 1 and ${SUJET_MAX}`);
  });

  it('🔴 la conversation d’origine se détache à son effacement, sans jamais effacer la fiche', () => {
    expect(colonne('analyse_conversation_id')).toMatch(/references conversations\(id\) on delete set null/);
  });

  it('les colonnes sont nullables et sans défaut : null veut dire « jamais analysé »', () => {
    for (const i of instructions.filter((x) => x.includes('add column if not exists'))) {
      expect(i, i.slice(0, 80)).not.toMatch(/not null|default/i);
    }
  });

  it('la cohérence exige une copie entière, sauf les notes et la conversation', () => {
    const i = instructions.find((x) => x.includes('add constraint contacts_analyse_coherence_check'))!;
    const pleine = i.slice(i.indexOf(' or ('));
    for (const c of ['analyse_le', 'analyse_fenetre_fin', 'analyse_intention', 'analyse_sentiment', 'analyse_resolue', 'analyse_sujet', 'analyse_traitee_par', 'analyse_action']) {
      expect(pleine, c).toContain(`${c} is not null`);
    }
    for (const c of ['analyse_satisfaction', 'analyse_urgence', 'analyse_conversation_id']) {
      expect(pleine, c).not.toContain(c);
    }
  });

  it('hors transaction, et chaque instruction rejouable', () => {
    expect(veutHorsTransaction(SQL)).toBe(true);
    for (const i of instructions) {
      expect(i, i.slice(0, 80)).toMatch(/add column if not exists|drop constraint if exists|add constraint contacts_analyse_coherence_check|create index concurrently if not exists|set lock_timeout = '5s'|reset lock_timeout/);
    }
    // Le délai de verrou est posé AVANT la première écriture, et retiré après la dernière.
    expect(instructions[0]).toMatch(/^\s*set lock_timeout = '5s'\s*$/);
    expect(instructions[instructions.length - 1]).toMatch(/^\s*reset lock_timeout\s*$/);
    // La contrainte de cohérence est RETIRÉE avant d'être reposée : sans ça, un rejeu après un échec plus bas lèverait.
    const retrait = instructions.findIndex((x) => x.includes('drop constraint if exists contacts_analyse_coherence_check'));
    const pose = instructions.findIndex((x) => x.includes('add constraint contacts_analyse_coherence_check'));
    expect(retrait).toBeGreaterThanOrEqual(0);
    expect(pose).toBe(retrait + 1);
  });

  it('l’index partiel sert l’action de la clé étrangère', () => {
    const i = instructions.find((x) => x.includes('create index concurrently if not exists contacts_analyse_conversation_idx'))!;
    expect(i).toMatch(/on contacts \(analyse_conversation_id\)\s+where analyse_conversation_id is not null/);
  });
});
