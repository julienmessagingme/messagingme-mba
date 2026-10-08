import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decouperInstructions, veutHorsTransaction } from '../src/db/migration-directives';
import { prixClientMicroEur } from '../src/agent/devise';
import { DROITS } from '../src/offres/offres';
import { schema } from '../src/config';

/**
 * 0222 : le budget par conversation d'un agent passe de 0,03 € à 0,07 € (lot 6, livraison C, rouge de la relecture,
 * décision de Julien du 2026-10-08). La recherche dans la connaissance entre désormais dans le coût du tour, donc dans ce
 * budget : sans la hausse, un agent avec une base de connaissance se taisait (« Plafond atteint ») bien plus tôt.
 */
const lire = (chemin: string): string => readFileSync(new URL(chemin, import.meta.url), 'utf8');
const SQL = lire('../db/migrations/0222_budget_recherche.sql');
const sansCommentaires = (t: string): string => t.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n');
const instructions = decouperInstructions(SQL)
  .map(sansCommentaires)
  .map((i) => i.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim())
  .filter((i) => i !== '');

describe('migration 0222', () => {
  it('🔴 le défaut passe à 70 000 micro-euros, et seuls les agents restés au défaut d’avant suivent', () => {
    expect(instructions).toEqual([
      "set local lock_timeout = '5s'",
      'alter table agents alter column budget_micro_eur set default 70000',
      'update agents set budget_micro_eur = 70000 where budget_micro_eur = 30000',
    ]);
  });

  it('🔴 le nouveau budget laisse au modèle la place d’avant ET paie toutes les recherches permises, en Base', () => {
    // Le pire cas : chaque appel d'outil permis par défaut est une recherche (0,002 $ le reranker, mesuré), au tarif de la
    // Base (la commission la plus haute), au taux par défaut de l'instance.
    const appels = Number(/max_appels_outils\s+int\s+not null default (\d+)/.exec(lire('../db/migrations/0086_agent_ia.sql'))![1]);
    const taux = schema.parse({}).EUR_PER_USD;
    const recherche = prixClientMicroEur(0.002, taux, DROITS.base.limites.commissionPct);
    const budget = Number(/set default (\d+)/.exec(SQL)![1]);
    expect(budget).toBeGreaterThanOrEqual(30_000 + appels * recherche);
  });

  it('dans une transaction ordinaire, et sans accent grave (le runner lit le fichier dans un gabarit de chaîne)', () => {
    expect(veutHorsTransaction(SQL)).toBe(false);
    expect(SQL).not.toContain('`');
  });
});
