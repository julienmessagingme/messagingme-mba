/**
 * Les sorties réservées du bloc agent : les handles que la plateforme emprunte d'elle-même, par opposition à
 * ceux que le client déclare sur son outil « terminer ».
 *
 * Source unique pour le tour, les outils maison et le builder : une sortie écrite en littéral qui diverge
 * d'une lettre ne correspond à aucune arête, et le parcours part par la première arête venue.
 */

/**
 * Le contact ne répond plus. Sans préfixe `sortie:` : c'est le handle du bloc Question, réemprunté pour qu'il
 * n'y ait qu'un seul vocabulaire dans le builder.
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
 * L'agent n'a aucune source pour répondre : le garde-fou anti-hallucination. Il est déterministe (score de
 * recherche comparé à un seuil, en code), jamais laissé au jugement du modèle.
 */
export const SORTIE_SANS_SOURCE = 'sans_source';

