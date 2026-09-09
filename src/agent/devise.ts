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
 * 🔴 ON ARRONDIT VERS LE HAUT, ET LE SENS N'EST PAS INTERCHANGEABLE. Il y a DEUX barrières sur la dépense
 * d'un espace, et elles n'ont pas le même rôle :
 *   - la NÔTRE (`run-turn.ts`, `solde <= 0`) est la garde. Elle compte en EUROS, dans la monnaie où le
 *     client a payé, et elle s'applique AVANT l'appel au modèle ;
 *   - celle de VERCEL (le plafond de la clé) est le FILET. Elle existe pour le cas où notre comptage a un
 *     bug, et pour empêcher qu'un espace mange le solde commun.
 * Un filet doit donc être PLUS LARGE que la garde qu'il double. Arrondi vers le BAS, il mordait le premier :
 * mesuré le 2026-09-09, un crédit de 10 € donnait un plafond de 10 $, atteint à 9,20 € consommés. Le client
 * perdait 8 % de ce qu'il avait payé, et notre garde ne servait plus jamais. **Un filet qui se déclenche
 * avant la garde n'est pas un filet, c'est la garde, et la moins précise des deux.**
 *
 * ⚠️ Ce que ça coûte, et qui est le bon prix : si notre comptage casse, le filet laisse passer jusqu'à un
 * dollar de plus que le crédit. Borné, et sans commune mesure avec un client coupé avant d'avoir consommé
 * ce qu'il a acheté.
 *
 * ⚠️ LE MINIMUM SE JUGE SUR LE CRÉDIT BRUT, AVANT L'ARRONDI. Autrement `ceil` remonterait 0,20 € à un
 * plafond de 1 $, et la règle « pas de crédit, pas de clé, donc pas d'agent » cesserait de tenir : il
 * suffirait d'un centime pour ouvrir un agent. L'appelant traite ce `null` comme « pas assez de crédit ».
 *
 * ⚠️ Même défense du taux que ci-dessus, mais dans l'autre sens : un taux aberrant retombe sur 1, jamais sur
 * une division par zéro qui rendrait un plafond infini.
 */
export const PLAFOND_GATEWAY_MIN_DOLLARS = 1;

export function dollarsDepuisMicroEuros(microEur: number, tauxEurParDollar: number): number | null {
  if (!Number.isFinite(microEur) || microEur <= 0) return null;
  const taux = Number.isFinite(tauxEurParDollar) && tauxEurParDollar > 0 ? tauxEurParDollar : 1;
  const brut = microEur / MICRO / taux;
  if (brut < PLAFOND_GATEWAY_MIN_DOLLARS) return null;
  return Math.ceil(brut);
}
