/**
 * Combien de temps les conversations d'un espace se gardent réellement : la règle a deux niveaux, et l'écran
 * comme la purge doivent annoncer la même durée.
 *
 * 🔴 Les deux zéros ne disent pas la même chose : `0` au niveau de l'instance est le levier d'urgence qui
 * arrête la purge partout, y compris chez les espaces qui ont choisi leur durée ; `0` au niveau d'un espace
 * ne désactive que lui.
 *
 * La purge, une seule instruction SQL pour tous les espaces, porte la même règle en `coalesce` et ne peut pas
 * appeler cette fonction : un test relit les deux. Module pur.
 */

/**
 * La durée réellement appliquée à un espace, en jours. `0` veut dire « jamais purgé ».
 *
 * @param instance le defaut de l'instance (`CONVERSATION_RETENTION_DAYS`)
 * @param espace   ce que l'espace a regle, ou `null` s'il n'a rien regle
 */
export function retentionEffective(instance: number, espace: number | null): number {
  // Le levier d'urgence d'abord : il gagne sur tout, y compris sur un espace qui a choisi une duree.
  if (!(instance > 0)) return 0;
  if (espace === null) return Math.floor(instance);
  // Une valeur négative est impossible en base (CHECK), mais on borne quand même l'affichage.
  return espace > 0 ? Math.floor(espace) : 0;
}
