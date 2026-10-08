import type { SourceOffres } from './offre.pg';

/**
 * LA COMMISSION SUR LE CRÉDIT IA DE L'ESPACE (lot 6, livraison C, tâche 17), en pourcent : celle de son offre, lue dans
 * la grille (`DROITS[offre].limites.commissionPct`, `src/offres/offres.ts`), seule source. Le tour d'agent et son essai,
 * la traduction et le tarif des modèles affiché la lisent par ici : le prix annoncé est le prix payé, et un espace en
 * Base ne paie jamais le tarif du Pro.
 *
 * Par `OffresEnCache` (une lecture par 30 s et par process) : une offre illisible y rend l'Entreprise, donc la commission
 * la plus basse. Une panne de la lecture ne coupe aucun tour et ne fait jamais payer plus cher.
 */
export function commissionPour(offres: SourceOffres): (tenantId: string) => Promise<number> {
  return async (tenantId) => (await offres.offreDe(tenantId)).droits.limites.commissionPct;
}
