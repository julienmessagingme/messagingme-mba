/**
 * Les campagnes par listes HubSpot sont-elles ouvertes ? Oui si l'utilisateur les a activées
 * (`hubspot_lists_enabled`) et que la pause de synchronisation n'est pas active (`tenant_settings.campaigns_paused`).
 * La pause pose ce drapeau dans la même transaction que `phone_numbers.hubspot_paused_at` (`setHubspotConnected`),
 * sans jamais écraser le réglage d'origine : la reprise le restaure tel quel.
 */
export function listsGateOpen(hubspotListsEnabled: boolean, campaignsPaused: boolean): boolean {
  return hubspotListsEnabled && !campaignsPaused;
}
