/**
 * Les sorties RÉSERVÉES du bloc agent : les handles que la plateforme emprunte d'elle-même, par opposition à
 * ceux que le client déclare sur son outil « terminer ».
 *
 * Source UNIQUE, et c'est le but : ces noms voyagent entre le tour (`run-turn.ts`), les outils maison
 * (`resolvers/mba.ts`) et le builder qui les dessine sur le bloc. Écrits en littéral à trois endroits, ils
 * finiraient par diverger d'une lettre, et une sortie qui ne correspond à aucune arête est un parcours qui
 * part par la première arête venue.
 *
 * ⚠️ `timeout` n'est PAS dans cette liste et c'est délibéré : l'inactivité de l'agent emprunte le handle du
 * bloc Question, sans préfixe, pour qu'il n'y ait qu'un seul vocabulaire dans le builder.
 */

/**
 * Le contact ne répond plus. SANS préfixe `sortie:`, volontairement : c'est le handle du bloc Question,
 * réemprunté tel quel pour qu'il n'y ait qu'un seul vocabulaire dans le builder. Déclaré ici quand même,
 * pour que le nom ne vive pas en littéral dans l'exécuteur d'un côté et dans le builder de l'autre.
 */
export const SORTIE_TIMEOUT = 'timeout';

/** Tours, appels d'outils ou budget épuisés. */
export const SORTIE_PLAFOND = 'plafond';

/**
 * L'agent passe la main à un humain (outil `mba_escalader_humain`). Le client câble ce handle vers ce qu'il
 * veut voir après une escalade : un message d'attente, un tag, une fin de parcours.
 */
export const SORTIE_HUMAIN = 'humain';

/** Repli : le modèle a échoué, l'envoi a été refusé, la fiche d'agent est introuvable. */
export const SORTIE_ECHEC = 'echec';

/**
 * L'agent n'a AUCUNE source pour répondre. C'est le garde-fou anti-hallucination, et il est déterministe :
 * le score de recherche est calculé en code et comparé à un seuil en code, jamais laissé au jugement du
 * modèle. Le client câble ce handle vers le transfert humain ou le renvoi aux coordonnées.
 */
export const SORTIE_SANS_SOURCE = 'sans_source';

