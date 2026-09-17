/**
 * COMBIEN DE TEMPS LES CONVERSATIONS D'UN ESPACE SE GARDENT, POUR DE VRAI.
 *
 * 🔴 CE MODULE EXISTE PARCE QUE LA REGLE A DEUX NIVEAUX ET QU'ELLE ETAIT ECRITE A UN SEUL ENDROIT : la
 * purge. L'ecran de synthese, lui, annoncait la duree de l'INSTANCE a tous les espaces (« Les conversations
 * et leurs analyses sont conservees N jours »), figee au demarrage du process. Tant que personne ne reglait
 * sa propre duree, les deux disaient la meme chose ; le jour ou un espace se met a 30, l'ecran continuait
 * d'annoncer 90 pendant que ses donnees disparaissaient a 30. Releve en revue le 2026-09-17, alors que la
 * colonne venait d'etre posee (migration 0155) : le defaut etait ARME, pas encore atteignable.
 *
 * 🔴 LES DEUX ZEROS NE DISENT PAS LA MEME CHOSE, ET C'EST TOUT LE SUJET.
 *  - `0` au niveau de l'INSTANCE est le LEVIER D'URGENCE : il arrete la purge PARTOUT, y compris chez les
 *    espaces qui ont choisi leur propre duree. Un levier qui n'arrete pas tout n'est pas un levier.
 *  - `0` au niveau d'un ESPACE ne desactive que cet espace. C'est le choix du client.
 * Les inverser, ou n'en garder qu'un, produirait soit une purge qu'on ne peut plus arreter, soit un reglage
 * client qui ne sert a rien.
 *
 * ⚠️ LA PURGE NE PEUT PAS APPELER CETTE FONCTION, et il faut le savoir en la lisant : elle est UNE SEULE
 * instruction SQL qui balaie tous les espaces a la fois, donc elle porte la meme regle en `coalesce` et en
 * retour anticipe. `tests/retention-effective.test.ts` tient les deux ecritures cote a cote : il exerce
 * cette fonction ET relit le texte de la purge pour verifier que ses deux gardes sont toujours la.
 *
 * Module PUR : aucun acces base, aucun etat.
 */

/**
 * La duree REELLEMENT appliquee a un espace, en jours. `0` veut dire « jamais purge ».
 *
 * @param instance le defaut de l'instance (`CONVERSATION_RETENTION_DAYS`)
 * @param espace   ce que l'espace a regle, ou `null` s'il n'a rien regle
 */
export function retentionEffective(instance: number, espace: number | null): number {
  // Le levier d'urgence d'abord : il gagne sur tout, y compris sur un espace qui a choisi une duree.
  if (!(instance > 0)) return 0;
  if (espace === null) return Math.floor(instance);
  // Une valeur negative en base est impossible (CHECK de la migration 0155), mais la lire sans la borner
  // ferait afficher « conservees -5 jours » si le CHECK disparaissait un jour.
  return espace > 0 ? Math.floor(espace) : 0;
}
