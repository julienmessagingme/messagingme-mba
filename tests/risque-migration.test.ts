import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decouperInstructions, veutHorsTransaction } from '../src/db/migration-directives';
import { MAX_RAISONS, NIVEAUX_RISQUE, RAISONS_RISQUE, SCORE_MAX } from '../src/engagement/risque';

/**
 * LA MIGRATION 0178 ET LES RÈGLES PARLENT DES MÊMES CODES (lot 7 de l'API publique).
 *
 * Les niveaux et les raisons sont fermés DEUX fois : par le type (`src/engagement/risque.ts`) et par les CHECK de
 * la base. Une raison ajoutée à la grille sans migration ferait échouer l'écriture du lot de fiches en cours,
 * chaque nuit, sans que rien ne le dise avant la production. La parité se DÉRIVE du fichier SQL, elle ne se
 * relit pas.
 */
const SQL = readFileSync(new URL('../db/migrations/0178_risque_desengagement.sql', import.meta.url), 'utf8');
// Sans les commentaires : un commentaire d'en-tête voyage avec l'instruction qui le suit, et il cite des noms.
const instructions = decouperInstructions(SQL).map((i) => i.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n'));
const codes = (texte: string): string[] => [...texte.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]!);

describe('migration 0178', () => {
  it('🔴 les niveaux du CHECK sont exactement ceux des règles', () => {
    const i = instructions.find((x) => x.includes('add column if not exists risque_niveau'))!;
    expect(codes(i).sort()).toEqual([...NIVEAUX_RISQUE].sort());
  });

  it('🔴 les raisons du CHECK sont exactement celles des règles, trois au plus', () => {
    const i = instructions.find((x) => x.includes('add column if not exists risque_raisons'))!;
    expect(codes(i.slice(i.indexOf('array['))).sort()).toEqual([...RAISONS_RISQUE].sort());
    expect(i).toContain(`cardinality(risque_raisons) <= ${MAX_RAISONS}`);
  });

  it('le score est borné comme dans les règles', () => {
    expect(instructions.find((x) => x.includes('risque_score smallint'))).toContain(`between 0 and ${SCORE_MAX}`);
  });

  it('hors transaction, et chaque instruction rejouable', () => {
    expect(veutHorsTransaction(SQL)).toBe(true);
    for (const i of instructions) {
      expect(i, i.slice(0, 80)).toMatch(/add column if not exists|drop constraint if exists|add constraint contacts_risque_coherence_check|create index concurrently if not exists/);
    }
    // La contrainte de cohérence est RETIRÉE avant d'être reposée : sans ça, un rejeu après un échec plus bas lèverait.
    const retrait = instructions.findIndex((x) => x.includes('drop constraint if exists contacts_risque_coherence_check'));
    const pose = instructions.findIndex((x) => x.includes('add constraint contacts_risque_coherence_check'));
    expect(retrait).toBeGreaterThanOrEqual(0);
    expect(pose).toBe(retrait + 1);
  });
});
