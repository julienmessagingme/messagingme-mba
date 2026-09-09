/**
 * La conversion du coût d'un appel de modèle, en UN SEUL endroit.
 *
 * 🔴 C'ÉTAIT LA DETTE D1, ET C'ÉTAIT UN BUG D'UNITÉ SILENCIEUX. Le Vercel AI Gateway rend le coût de chaque
 * appel en DOLLARS (`coutDollars`, `llm/chat-client.ts`), et la colonne de budget s'appelle
 * `budget_micro_eur`. On additionnait donc des dollars dans une colonne d'euros, et le plafond réglé par le
 * client dans la console était comparé à un nombre qui n'était pas dans la même monnaie. Faux d'un facteur
 * de change : trop haut on dépasse, trop bas l'agent se coupe tout seul.
 *
 * 🔴 LE TAUX EST UN PARAMÈTRE COMMERCIAL, PAS UN COURS. Il vit dans la configuration serveur et ne bouge que
 * quand Julien le décide. C'est délibéré : le client charge des euros, consomme des euros, et lit un solde en
 * euros stable. Aller chercher un cours en temps réel ferait varier le prix d'une même conversation d'un jour
 * à l'autre, pour un gain nul (la marge absorbe très largement la variation), et ajouterait une dépendance
 * réseau sur le chemin d'un tour.
 */

/** Micro-euros par euro. Le micro-euro tient très large dans un `number` (2^53 = 9 milliards d'euros). */
const MICRO = 1_000_000;

/**
 * Le coût d'un appel, en micro-euros.
 *
 * ⚠️ Un taux absent, nul ou aberrant retombe sur un facteur de 1, JAMAIS sur zéro. Un zéro rendrait toute
 * consommation gratuite, donc désarmerait le plafond en silence, ce qui est exactement la panne qu'on ne
 * veut pas : mieux vaut facturer un dollar pour un euro (l'écart est de quelques pour cent) que de ne rien
 * facturer du tout.
 */
export function microEurosDepuisDollars(coutDollars: number, tauxEurParDollar: number): number {
  if (!Number.isFinite(coutDollars) || coutDollars <= 0) return 0;
  const taux = Number.isFinite(tauxEurParDollar) && tauxEurParDollar > 0 ? tauxEurParDollar : 1;
  return Math.round(coutDollars * taux * MICRO);
}

/** Micro-euros vers euros, pour l'affichage. Deux décimales : c'est de l'argent, pas une mesure. */
export function eurosDepuisMicro(microEur: number): number {
  return Math.round(microEur / 10_000) / 100;
}

/**
 * Le chemin INVERSE : un montant de nos micro-euros vers des dollars ENTIERS, pour le plafond d'une clé du
 * Gateway (2026-09-09). Vercel raisonne en dollars et n'accepte pas moins de 1.
 *
 * 🔴 ON ARRONDIT VERS LE BAS, ET LE SENS N'EST PAS INTERCHANGEABLE. Ce plafond borne ce qu'un client peut
 * dépenser avec le crédit qu'il a ACHETÉ ; arrondir vers le haut lui laisserait dépenser un peu plus que ce
 * qu'il a payé, à chaque rechargement, indéfiniment. Vers le bas, il est coupé une fraction de dollar trop
 * tôt, ce que notre propre décompte du solde a de toute façon déjà fait avant.
 *
 * ⚠️ Rend `null` sous le minimum de Vercel plutôt que de poser 1 : un plafond gonflé à 1 $ pour un crédit de
 * 0,20 € donnerait au client cinq fois ce qu'il a payé, et surtout il MENTIRAIT sur ce que le plafond
 * garantit. L'appelant traite ce `null` comme « pas assez de crédit », qui est la vérité.
 *
 * ⚠️ Même défense du taux que ci-dessus, mais dans l'autre sens : un taux aberrant retombe sur 1, jamais sur
 * une division par zéro qui rendrait un plafond infini.
 */
export const PLAFOND_GATEWAY_MIN_DOLLARS = 1;

export function dollarsDepuisMicroEuros(microEur: number, tauxEurParDollar: number): number | null {
  if (!Number.isFinite(microEur) || microEur <= 0) return null;
  const taux = Number.isFinite(tauxEurParDollar) && tauxEurParDollar > 0 ? tauxEurParDollar : 1;
  const dollars = Math.floor(microEur / MICRO / taux);
  return dollars >= PLAFOND_GATEWAY_MIN_DOLLARS ? dollars : null;
}
