/**
 * LA RÈGLE DE DÉFILEMENT DU FIL D'INBOX (lot 2 du plan post-audit, 2026-09-02).
 *
 * 🔴 Le défaut qu'elle corrige, et c'était une régression introduite le 2026-09-02 : la mesure « suis-je en
 * bas ? » était faite APRÈS l'ajout des messages, dans un `useEffect` qui s'exécute une fois le DOM commité.
 * Deux conséquences purement arithmétiques, et les deux se voient à l'écran :
 *
 *  - à l'OUVERTURE d'une conversation longue, `scrollTop` vaut 0 et `scrollHeight` est grand, donc la mesure
 *    répond « non, tu n'es pas en bas » : le fil ne descendait pas et l'opérateur atterrissait sur le plus
 *    vieux message de l'historique ;
 *  - à l'ARRIVÉE d'un message plus haut que la tolérance, le fil était en bas AVANT l'ajout mais ne l'est
 *    plus après : il ne suivait pas le message qui venait d'arriver.
 *
 * D'où ce module : la mesure ne vaut que prise AVANT que le contenu ne bouge, donc elle est faite sur
 * l'événement de défilement (le seul moment où la position change du fait de l'opérateur) et conservée. Sortie
 * de la page pour être testable sans DOM, comme les autres règles du dossier `lib`.
 */

/**
 * Tolérance en pixels. Personne ne pose son fil au pixel près, et un fil « presque en bas » est un fil qu'on
 * suit. Plus haut que ça, l'opérateur lit, on ne le dérange pas.
 */
export const TOLERANCE_BAS_PX = 80;

/** La géométrie d'un conteneur défilant. Volontairement structurelle : aucun DOM n'est requis pour la tester. */
export interface GeometrieFil {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

/**
 * Le fil est-il posé en bas ? `null` (conteneur pas encore monté) vaut OUI : à l'ouverture, la seule position
 * qui a du sens est le message le plus récent.
 */
export function estEnBas(fil: GeometrieFil | null): boolean {
  if (!fil) return true;
  return fil.scrollHeight - fil.scrollTop - fil.clientHeight < TOLERANCE_BAS_PX;
}

/**
 * Faut-il descendre après une mise à jour des messages ?
 *
 * `premierChargement` est un cas EXPLICITE et non une conséquence de la mesure : à l'ouverture, on descend
 * quoi qu'en dise la géométrie. C'est justement ce que l'ancien code déduisait, et déduisait faux sur une
 * conversation longue.
 *
 * `etaitEnBas` doit venir d'une mesure prise AVANT l'ajout des messages. Passer une mesure d'après revient à
 * réintroduire le défaut, la hauteur du nouveau message suffisant à faire répondre « non ».
 */
export function doitDescendre(opts: { premierChargement: boolean; etaitEnBas: boolean }): boolean {
  return opts.premierChargement || opts.etaitEnBas;
}
