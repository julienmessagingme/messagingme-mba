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
