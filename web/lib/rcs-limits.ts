/**
 * Longueur maximale d'un message RCS texte. MIROIR de `RCS_TEXTE_MAX` (src/rcs/schema.ts), recopié plutôt
 * qu'importé : les deux builds ne partagent aucun module, et tirer du code serveur ici l'embarquerait dans le
 * bundle client.
 *
 * Sans cette borne côté écran, l'opérateur tapait sa réponse, cliquait, et se la faisait refuser par le
 * serveur sans savoir pourquoi. `web/lib/rcs-limits.test.ts` casse si les deux valeurs divergent.
 */
export const RCS_TEXTE_MAX = 3072;
