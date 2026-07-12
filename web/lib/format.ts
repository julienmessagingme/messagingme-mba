/** Formatage partagé (dashboard, campagnes, graphes). */

/** Coût estimé : 4 décimales sous 1 (tarifs au message), 2 sinon. Nombre nu (devise = « devise du compte »). */
export function fmtCost(n: number): string {
  return n.toFixed(n < 1 ? 4 : 2);
}

/** Nombre entier lisible (séparateurs FR). */
export function fmtNum(n: number): string {
  return n.toLocaleString('fr-FR');
}

/** Pourcentage borné (num/den) affiché sans décimale ; '—' si dénominateur nul. */
export function fmtPct(num: number, den: number): string {
  if (den <= 0) return '—';
  return `${Math.round((num / den) * 100)} %`;
}
