/**
 * Le risque de désengagement : ses niveaux et les codes de ses raisons, PARTAGÉS par le serveur
 * (`src/engagement/risque.ts`, qui le calcule) et la console (`web/lib/risque.ts`, qui l'affiche). La console type
 * ses libellés sur ces codes : un code sans libellé ne compile plus.
 */

export const NIVEAUX_RISQUE = ['inconnu', 'faible', 'moyen', 'eleve'] as const;
export type NiveauRisque = (typeof NIVEAUX_RISQUE)[number];

/**
 * Les codes des raisons, courts et stables : ce sont des identifiants, qui partent tels quels chez l'outil du
 * client (`em_risk_reasons`) et dans l'API publique (`engagementRisk.reasons`).
 */
export const RAISONS_RISQUE = [
  'stop', 'bloque', 'silence_60j', 'silence_30j', 'sans_reponse', 'non_lu', 'reclamation', 'negatif', 'insatisfait', 'injoignable',
] as const;
export type RaisonRisque = (typeof RAISONS_RISQUE)[number];
