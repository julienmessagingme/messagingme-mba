/**
 * Le solde prépayé du workspace, côté navigateur.
 *
 * 🔴 CE QUE CE SOLDE EST VRAIMENT. Un agent consomme un modèle à chaque message d'un contact, et cette
 * consommation est facturée. Le solde descend à chaque tour, du coût RÉEL rendu par le fournisseur. Vide,
 * les agents du workspace s'arrêtent : ils sortent par « Plafond atteint », comme pour les autres plafonds,
 * donc le client câble cette branche une seule fois quelle qu'en soit la raison.
 *
 * ⚠️ Aucune écriture de solde n'est ici, et ne doit y être : le client PAIE (page Crédit IA, Stripe), et seul le
 * webhook signé de Stripe crédite ; l'exploitation garde sa recharge manuelle. Un client qui pourrait se
 * créditer lui-même n'aurait plus de prépayé. Le solde paie les agents IA ET la traduction de l'Inbox.
 */

/** Miroir de `eurosDepuisMicro` (`src/agent/devise.ts`), que les deux builds ne partagent pas. Deux
 *  décimales : c'est de l'argent, pas une mesure. `tests/agent-devise.test.ts` ancre la parité. */
export function eurosDepuisMicro(microEur: number): number {
  return Math.round(microEur / 10_000) / 100;
}

/** Sous ce solde, on prévient. Un demi-euro laisse de quoi tenir quelques conversations, pas plus : c'est
 *  le moment de le dire, pas quand il est déjà vide et que les agents se sont tus. */
export const SOLDE_BAS_MICRO_EUR = 500_000;
