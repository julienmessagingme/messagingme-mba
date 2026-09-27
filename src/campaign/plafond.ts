/**
 * Le plafond de taille d'une campagne : empêche le serveur d'accepter par accident un envoi trop gros.
 * La valeur vit en configuration (`CAMPAIGN_MAX_RECIPIENTS`) pour se relever sans redéployer.
 *
 * Le refus sort en 422 et jamais en 5xx : Cloudflare remplace le corps de toute réponse 5xx par sa propre
 * page, donc le message destiné à l'utilisateur serait perdu.
 */

export const PLAFOND_DESTINATAIRES_DEFAUT = 20_000;

/**
 * Rend le message de refus si le nombre visé dépasse le plafond, sinon `null`. Le message porte les deux
 * nombres, pour que l'opérateur sache de combien il dépasse.
 */
export function refusDePlafond(vises: number, plafond: number): string | null {
  if (vises <= plafond) return null;
  return `Cette campagne viserait ${vises.toLocaleString('fr-FR')} destinataires, au-dessus du plafond de ${plafond.toLocaleString('fr-FR')}. Restreignez la sélection.`;
}
