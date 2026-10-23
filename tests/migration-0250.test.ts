import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decouperInstructions, veutHorsTransaction } from '../src/db/migration-directives';
import { BUDGET_CONVERSATION_MAX_MICRO_EUR, MAX_APPELS_OUTILS_AGENT, MAX_TOURS_AGENT, saisieDeModification } from '../src/agent/gestion';

/**
 * 0250 : les limites de réponses et d'actions d'une conversation d'agent montent au maximum (décision de Julien du
 * 2026-10-23), pour les agents restés à l'ancien défaut. Le maximum est celui que la base et la console acceptent :
 * un défaut au-delà ferait échouer chaque création d'agent sur le CHECK.
 */
const lire = (chemin: string): string => readFileSync(new URL(chemin, import.meta.url), 'utf8');
const SQL = lire('../db/migrations/0250_limites_conversation_au_maximum.sql');
const sansCommentaires = (t: string): string => t.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n');
const instructions = decouperInstructions(SQL)
  .map(sansCommentaires)
  .map((i) => i.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim())
  .filter((i) => i !== '');

describe('migration 0250', () => {
  it('🔴 les défauts passent à 20 et 60, et seuls les agents restés à 8 (ou à 12) suivent, colonne par colonne', () => {
    expect(instructions).toEqual([
      "set local lock_timeout = '5s'",
      'alter table agents alter column max_tours set default 20',
      'alter table agents alter column max_appels_outils set default 60',
      'update agents set max_tours = 20 where max_tours = 8',
      'update agents set max_appels_outils = 60 where max_appels_outils = 12',
    ]);
  });

  it('🔴 les nouveaux défauts sont les maxima du CHECK de 0086 et de la saisie de la console', () => {
    const creation = lire('../db/migrations/0086_agent_ia.sql');
    const maxCheck = (colonne: string) => Number(new RegExp(`${colonne}\\s+int\\s+not null default \\d+\\s+check \\(${colonne} between \\d+ and (\\d+)\\)`).exec(creation)![1]);
    const champs = saisieDeModification.shape;
    expect(maxCheck('max_tours')).toBe(20);
    expect(maxCheck('max_appels_outils')).toBe(60);
    expect(champs.maxTours.unwrap().maxValue).toBe(20);
    expect(champs.maxAppelsOutils.unwrap().maxValue).toBe(60);
    // Les constantes que `set_agent_limits` annonce et applique sont celles de la saisie : un seul jeu de bornes.
    expect(MAX_TOURS_AGENT).toBe(champs.maxTours.unwrap().maxValue);
    expect(MAX_APPELS_OUTILS_AGENT).toBe(champs.maxAppelsOutils.unwrap().maxValue);
    expect(BUDGET_CONVERSATION_MAX_MICRO_EUR).toBe(champs.budgetMicroEur.unwrap().maxValue);
  });

  it('dans une transaction ordinaire, et sans accent grave (le runner lit le fichier dans un gabarit de chaîne)', () => {
    expect(veutHorsTransaction(SQL)).toBe(false);
    expect(SQL).not.toContain('`');
  });
});
