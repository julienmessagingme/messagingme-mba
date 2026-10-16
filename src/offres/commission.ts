import type { SourceOffres } from './offre.pg';

/**
 * LA COMMISSION SUR LE CRÉDIT IA DE L'ESPACE (lot 6, livraison C, tâche 17), en pourcent : celle de son offre, lue dans
 * la grille (`DROITS[offre].limites.commissionPct`, `src/offres/offres.ts`), seule source, ou celle qu'une Entreprise a
 * négociée (`tenants.entreprise_commission_pct`, posée par `/ops`, spec offres v2). Le tour d'agent et son essai, la
 * traduction et le tarif des modèles affiché la lisent par ici : le prix annoncé est le prix payé, et un espace en Base
 * ne paie jamais le tarif du Pro.
 *
 * Par `OffresEnCache` (une lecture par 30 s et par process) : une offre illisible y rend l'Entreprise PAR DÉFAUT, donc
 * 10 %. Une panne de la lecture ne coupe aucun tour ; elle ne fait payer plus cher qu'une Entreprise négociée sous 10 %,
 * le temps de la panne.
 */
export function commissionPour(offres: SourceOffres): (tenantId: string) => Promise<number> {
  return async (tenantId) => (await offres.offreDe(tenantId)).droits.limites.commissionPct;
}
