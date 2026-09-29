/**
 * Les offres de recharge du crédit IA : ce qu'on vend, et ce que chacune crédite.
 *
 * 🔴 LE CLIENT NE CHOISIT JAMAIS UN MONTANT, seulement une offre de cette liste. Le prix Stripe de chaque offre vit
 * dans la configuration serveur (`STRIPE_PRIX_REFILL_*`), le crédit qu'elle donne vit ICI : c'est lui que le webhook
 * accorde, après l'avoir recoupé avec ce que Stripe dit avoir encaissé (`htCentimes`).
 *
 * HT (décision de Julien du 2026-09-28) : 50 € payés hors taxe donnent 50 € de crédit, la TVA s'ajoute au paiement.
 * Le crédit se DÉRIVE du prix hors taxe, il ne se recopie pas : deux nombres écrits séparément finiraient par
 * diverger, et le webhook refuserait alors tous les paiements de l'offre.
 */

export const OFFRES_RECHARGE = ['refill_50', 'refill_100'] as const;
export type OffreRecharge = typeof OFFRES_RECHARGE[number];

export interface DefinitionOffre {
  offre: OffreRecharge;
  /** Ce que Stripe doit avoir encaissé hors taxe, en centimes d'euro (`amount_subtotal` de la session). */
  htCentimes: number;
  /** Le libellé des journaux et de la note du mouvement. L'écran a le sien, traduit. */
  libelle: string;
}

const DEFINITIONS: Readonly<Record<OffreRecharge, DefinitionOffre>> = {
  refill_50: { offre: 'refill_50', htCentimes: 5_000, libelle: 'Refill 50 € HT' },
  refill_100: { offre: 'refill_100', htCentimes: 10_000, libelle: 'Refill 100 € HT' },
};

export function estOffreRecharge(v: unknown): v is OffreRecharge {
  return typeof v === 'string' && (OFFRES_RECHARGE as readonly string[]).includes(v);
}

export function definitionOffre(offre: OffreRecharge): DefinitionOffre {
  return DEFINITIONS[offre];
}

/** Le crédit accordé, en micro-euros : un centime hors taxe vaut dix mille micro-euros de crédit. */
export function creditDeLOffre(offre: OffreRecharge): number {
  return DEFINITIONS[offre].htCentimes * 10_000;
}
