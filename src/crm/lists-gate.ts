/**
 * Gate effectif des campagnes via listes HubSpot (cluster HubSpot F3-b).
 *
 * La pause du toggle « Synchronisation » (F3-a, `phone_numbers.hubspot_paused_at`) doit AUSSI suspendre les campagnes
 * via listes HubSpot, réversiblement et SANS écraser le réglage d'origine de l'utilisateur (`hubspot_lists_enabled`)
 * pour que la reprise le restaure tel quel.
 *
 * Les listes ne sont ouvertes que si l'utilisateur les a activées (`hubspotListsEnabled`) ET que la pause n'est pas
 * active (`campaignsPaused=false`). Le flag `tenant_settings.campaigns_paused` est posé/effacé par l'action Pause du
 * toggle Synchronisation, DANS LA MÊME TRANSACTION que `phone_numbers.hubspot_paused_at` (cf. `setHubspotConnected`),
 * donc les deux moitiés de la pause (push conv-analyzer + campagnes listes) sont pilotées ensemble sans drift possible.
 * La reprise remet `campaigns_paused=false` et restaure le réglage d'origine `hubspotListsEnabled`, jamais écrasé.
 */
export function listsGateOpen(hubspotListsEnabled: boolean, campaignsPaused: boolean): boolean {
  return hubspotListsEnabled && !campaignsPaused;
}
