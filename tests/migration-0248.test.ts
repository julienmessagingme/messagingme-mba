import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decouperInstructions, veutHorsTransaction } from '../src/db/migration-directives';
import { prixClientMicroEur } from '../src/agent/devise';
import { DROITS } from '../src/offres/offres';
import { schema } from '../src/config';

/**
 * 0248 : le budget par conversation d'un agent n'a plus de limite par défaut (décision de Julien du 2026-10-22). Le
 * client paie son crédit IA ; la Free passée à 100 % de commission le même jour aurait sinon coupé ses conversations
 * environ 25 % plus tôt. 100 € est le maximum que la fiche accepte : aucune limite en pratique.
 */
const lire = (chemin: string): string => readFileSync(new URL(chemin, import.meta.url), 'utf8');
const SQL = lire('../db/migrations/0248_budget_conversation_sans_limite.sql');
const sansCommentaires = (t: string): string => t.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n');
const instructions = decouperInstructions(SQL)
  .map(sansCommentaires)
  .map((i) => i.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim())
  .filter((i) => i !== '');

describe('migration 0248', () => {
  it('🔴 le défaut passe au maximum de la fiche, et seuls les agents restés au défaut de 0222 suivent', () => {
    expect(instructions).toEqual([
      "set local lock_timeout = '5s'",
      'alter table agents alter column budget_micro_eur set default 100000000',
      'update agents set budget_micro_eur = 100000000 where budget_micro_eur = 70000',
    ]);
    // Le maximum que la fiche accepte : un budget au défaut reste réglable dans ses bornes.
    const max = Number(/budgetMicroEur: z\.number\(\)\.int\(\)\.min\(1\)\.max\(([0-9_]+)\)/.exec(lire('../src/agent/gestion.ts'))![1]!.replace(/_/g, ''));
    expect(Number(/set default (\d+)/.exec(SQL)![1])).toBe(max);
  });

  it('🔴 aucune offre ne coupe plus une conversation par son budget avant ses tours et ses appels d’outils', () => {
    // Le pire cas de 0222, à la commission la plus haute d'aujourd'hui (la Free) : le modèle, plus chaque appel d'outil
    // permis par défaut en recherche, tient cent fois dans le budget.
    const appels = Number(/max_appels_outils\s+int\s+not null default (\d+)/.exec(lire('../db/migrations/0086_agent_ia.sql'))![1]);
    const taux = schema.parse({}).EUR_PER_USD;
    const plusHaute = Math.max(...Object.values(DROITS).map((d) => d.limites.commissionPct));
    expect(plusHaute).toBe(DROITS.base.limites.commissionPct);
    const pire = 30_000 + appels * prixClientMicroEur(0.002, taux, plusHaute);
    expect(Number(/set default (\d+)/.exec(SQL)![1])).toBeGreaterThanOrEqual(100 * pire);
  });

  it('dans une transaction ordinaire, et sans accent grave (le runner lit le fichier dans un gabarit de chaîne)', () => {
    expect(veutHorsTransaction(SQL)).toBe(false);
    expect(SQL).not.toContain('`');
  });
});
