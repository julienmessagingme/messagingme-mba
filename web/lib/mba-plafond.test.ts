import { describe, it, expect } from 'vitest';
import { UNITE_PAR_DEFAUT, estimationPlafond } from './mba-plafond';

/**
 * 🔴 RELECTURE DU 2026-10-02 : « AI-turn budgets apply to each conversation » (Meta). Un plafond en réponses ne borne
 * pas la dépense, il borne chaque conversation. Vérifié dans les deux sens : l'unité par défaut remise à `ai_turn`, ou
 * la portée d'un plafond en réponses remise à `business_manager`, ces cas échouent.
 */
describe('le plafond de l’agent de Meta : ce que borne chaque unité', () => {
  it('🔴 l’unité par défaut est le JETON, le seul plafond qui borne la dépense totale', () => {
    expect(UNITE_PAR_DEFAUT).toBe('token');
  });

  it('🔴 un plafond en réponses se compte PAR CONVERSATION, et son estimation le dit', () => {
    const e = estimationPlafond('ai_turn', 500);
    expect(e.portee).toBe('conversation');
    // 500 réponses à 4 ou 5 cents : 20 à 25 $ PAR CONVERSATION, pas au total.
    expect(e.minUsd).toBeCloseTo(20);
    expect(e.maxUsd).toBeCloseTo(25);
  });

  it('un plafond en jetons borne tout le Business Manager : 10 millions de jetons, 20 $', () => {
    expect(estimationPlafond('token', 10_000_000)).toEqual({ portee: 'business_manager', minUsd: 20, maxUsd: 20 });
  });
});
