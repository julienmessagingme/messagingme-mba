/**
 * La conversion du coût d'un appel de modèle, en un seul endroit.
 *
 * 🔴 Le Vercel AI Gateway rend le coût en dollars, la colonne de budget est en micro-euros : toute conversion
 * passe par ici. Le taux est un paramètre commercial de la configuration serveur, pas un cours : le client
 * charge, consomme et lit un solde en euros stables, sans dépendance réseau sur le chemin d'un tour.
 */

/** Micro-euros par euro. Le micro-euro tient très large dans un `number` (2^53 = 9 milliards d'euros). */
const MICRO = 1_000_000;

/** Le coût converti, pas encore arrondi : l'arrondi se fait une seule fois, par la fonction qui rend un montant. */
function microBrut(coutDollars: number, tauxEurParDollar: number): number {
  if (!Number.isFinite(coutDollars) || coutDollars <= 0) return 0;
  const taux = Number.isFinite(tauxEurParDollar) && tauxEurParDollar > 0 ? tauxEurParDollar : 1;
  return coutDollars * taux * MICRO;
}

/**
 * Le coût BRUT d'un appel, en micro-euros. Un taux absent, nul ou aberrant retombe sur 1, jamais sur zéro : un
 * zéro rendrait toute consommation gratuite et désarmerait le plafond en silence.
 *
 * 🔴 C'est NOTRE dépense, pas ce que paie un client : seuls les deux assistants de configuration, sur notre clé,
 * s'en servent. Tout ce qui débite le crédit d'un espace passe par `prixClientMicroEur` (inventaire tenu par
 * `tests/agent-devise.test.ts`).
 */
export function microEurosDepuisDollars(coutDollars: number, tauxEurParDollar: number): number {
  return Math.round(microBrut(coutDollars, tauxEurParDollar));
}

/**
 * La commission en facteur. Absente, négative ou illisible, elle vaut 0, jamais une remise. Partagée par le
 * tarif AFFICHÉ (`prixParMillion`, `modeles.ts`) et le montant DÉBITÉ (`prixClientMicroEur`) : le prix annoncé
 * est le prix payé.
 */
export function facteurCommission(commissionPct: number): number {
  return Number.isFinite(commissionPct) && commissionPct >= 0 ? 1 + commissionPct / 100 : 1;
}

/**
 * Ce que le crédit d'un espace paie pour un appel, en micro-euros : le coût du Gateway au taux commercial, majoré
 * de notre commission (celle de l'offre de l'espace, `commissionPour`, `src/offres/commission.ts`), arrondi une seule fois.
 *
 * 🔴 Le seul calcul du montant débité. Ses appelants (le cerveau de l'agent, donc le tour et l'essai de la console,
 * et la traduction) l'importent ; un appelant de plus l'importe aussi, il ne recopie pas la formule.
 */
export function prixClientMicroEur(coutDollars: number, tauxEurParDollar: number, commissionPct: number): number {
  return Math.round(microBrut(coutDollars, tauxEurParDollar) * facteurCommission(commissionPct));
}

/** Micro-euros vers euros, pour l'affichage. Deux décimales : c'est de l'argent, pas une mesure. */
export function eurosDepuisMicro(microEur: number): number {
  return Math.round(microEur / 10_000) / 100;
}

/**
 * Le chemin inverse : nos micro-euros vers des dollars entiers, pour le plafond d'une clé du Gateway (Vercel
 * compte en dollars, minimum 1).
 *
 * 🔴 Arrondi vers le haut : notre garde (`run-turn.ts`, solde en euros, avant l'appel) doit mordre avant le
 * filet de Vercel, qui n'existe que pour un bug de comptage. Arrondi vers le bas, le filet coupait le client
 * avant qu'il ait consommé ce qu'il a payé. Le prix : au pire un dollar de plus que le crédit si notre
 * comptage casse.
 *
 * Le minimum se juge sur le crédit brut, avant l'arrondi : sinon `ceil` ferait d'un centime un plafond de
 * 1 $, et « pas de crédit, pas de clé, pas d'agent » ne tiendrait plus. L'appelant lit `null` comme « pas
 * assez de crédit ». Un taux aberrant retombe sur 1, jamais sur une division par zéro.
 */
export const PLAFOND_GATEWAY_MIN_DOLLARS = 1;

export function dollarsDepuisMicroEuros(microEur: number, tauxEurParDollar: number): number | null {
  if (!Number.isFinite(microEur) || microEur <= 0) return null;
  const taux = Number.isFinite(tauxEurParDollar) && tauxEurParDollar > 0 ? tauxEurParDollar : 1;
  const brut = microEur / MICRO / taux;
  if (brut < PLAFOND_GATEWAY_MIN_DOLLARS) return null;
  return Math.ceil(brut);
}
