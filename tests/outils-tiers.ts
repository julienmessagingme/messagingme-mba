/**
 * LES OUTILS TIERS QUE LA DOCUMENTATION NE NOMME PAS (décision de Julien du 2026-09-24) : elle sert à tous
 * les intégrateurs. « batch » est cherché sans égard à la casse et hors d'un chemin, pour laisser passer
 * `/v1/contacts/batch`. Les deux derniers motifs sont le vocabulaire propre à un outil, qui le trahirait sans
 * le nommer.
 *
 * ⚠️ UNE SEULE LISTE, partagée par `tests/api-exemples.test.ts` (la page et ses exemples) et
 * `tests/web-signaux-parite.test.ts` (la section « Ce que nous remontons ») : deux copies divergeraient, et la
 * plus courte laisserait passer un nom que l'autre refuse.
 */
export const OUTILS_TIERS: ReadonlyArray<readonly [string, RegExp]> = [
  ['Batch', /(?<![/\w])batch(?!\w)/i],
  ['Brevo', /Brevo/i],
  ['Salesforce', /Salesforce|SFMC/],
  ['Splio', /Splio/i],
  ['HubSpot', /HubSpot/i],
  ['Klaviyo', /Klaviyo/i],
  ['Braze', /Braze/i],
  ['Zapier', /Zapier/i],
  ['smsmode', /smsmode/i],
  ['custom_id', /custom_id/],
  ['Universal Channel', /Universal Channel/i],
  // L'infrastructure sous-jacente de messagingme.app : elle reste invisible de tout ce qu'un client lit.
  ['UChat', /uchat/i],
];
