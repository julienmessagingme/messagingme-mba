/**
 * Le nom de la ligne de Campagnes d'un envoi né d'un workflow HubSpot. 🔴 Un contrat, relu à deux endroits : le chiffre
 * d'affaires attribué (`src/shopify/ventes.pg.ts`) n'en fait jamais une source, comme un envoi par l'API, et le moteur de
 * campagne démarre son scénario en `workflow_hubspot` (`lancementDeCampagne`). Sans dépendance : le store des campagnes
 * l'importe.
 */
export const PREFIXE_LIGNE_HUBSPOT = 'HubSpot · workflow ';

/** Les types de lancement qu'une campagne à scénario peut porter (`src/workflow/lancements.ts`). */
export type LancementDeCampagne = 'campagne_scenario' | 'workflow_hubspot';

/**
 * Le type de lancement du scénario d'une campagne, lu sur son nom (cadrage `~/mm-hubspot/docs/2026-10-29-action-workflow-
 * scenario-cadrage.md`, décision 3) : la ligne d'un workflow HubSpot ne reprend jamais le fil à un opérateur. Plutôt qu'une
 * colonne, que chaque envoi écrirait sur le chemin chaud. Une campagne qu'un opérateur nommerait ainsi n'en devient que
 * plus prudente.
 */
export function lancementDeCampagne(nom: string | null): LancementDeCampagne {
  return nom !== null && nom.startsWith(PREFIXE_LIGNE_HUBSPOT) ? 'workflow_hubspot' : 'campagne_scenario';
}
