import { PRIX_JETONS_USD_PAR_MILLION, PRIX_REPONSE_USD, type UniteBudget } from './api-mba';

/**
 * CE QUE BORNE UN PLAFOND DE L'AGENT DE META, selon son unité. Module PUR.
 *
 * 🔴 LES DEUX UNITÉS NE BORNENT PAS LA MÊME CHOSE, et la première version de l'écran les confondait (relecture du
 * 2026-10-02). Meta, mot pour mot : « Token budgets apply across the Business Manager » et « AI-turn budgets apply to
 * each conversation ». Seul le plafond en JETONS borne la dépense totale ; un plafond en réponses borne CHAQUE
 * conversation, et 500 réponses sur 200 conversations font 100 000 réponses. L'écran présentait le second par défaut,
 * avec un montant en dollars qui se lisait comme un total : un client se croyait protégé après une facture trop
 * chère, et ne l'était pas.
 *
 * D'où l'unité par défaut, le JETON, et une estimation qui dit sa portée.
 */
export const UNITE_PAR_DEFAUT: UniteBudget = 'token';

export interface EstimationPlafond {
  /** `business_manager` = la dépense de tous les numéros du Business Manager ; `conversation` = chaque conversation. */
  portee: 'business_manager' | 'conversation';
  /** L'ordre de grandeur en dollars au prix public, POUR CETTE PORTÉE. */
  minUsd: number;
  maxUsd: number;
}

/** L'estimation d'un plafond au prix public de Meta : 2 $ le million de jetons, 4 à 5 cents la réponse. */
export function estimationPlafond(unite: UniteBudget, max: number): EstimationPlafond {
  if (unite === 'token') {
    const usd = (max / 1_000_000) * PRIX_JETONS_USD_PAR_MILLION;
    return { portee: 'business_manager', minUsd: usd, maxUsd: usd };
  }
  return { portee: 'conversation', minUsd: max * PRIX_REPONSE_USD.min, maxUsd: max * PRIX_REPONSE_USD.max };
}
