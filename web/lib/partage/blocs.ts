/**
 * Les blocs d'un scénario, tels que le moteur les valide et que la console les dessine.
 */

/**
 * Les types de bloc. Le serveur valide le graphe sur cette liste à l'enregistrement (`parseGraph` rejette le graphe
 * entier dès qu'un type est inconnu) ; la console ne dessine que ceux-là (`NODE_META`, typé dessus). Ce que fait
 * chaque type est décrit au moteur (`src/workflow/graph.ts`). Un type retiré du produit y reste tant que des
 * scénarios enregistrés peuvent le contenir.
 */
export const WORKFLOW_NODE_TYPES = [
  'template', 'quick_message', 'inbox', 'flow', 'question', 'tag', 'field', 'condition', 'action', 'wait', 'mba_handoff',
  'mba_disable', 'rcs_message', 'email', 'agent', 'http', 'js', 'aller_a', 'vers_mba',
] as const;
export type WorkflowNodeType = (typeof WORKFLOW_NODE_TYPES)[number];

/**
 * Nombre maximal de destinataires d'un bloc « Envoi de mail ». Le moteur TRONQUE au-delà (`parseGraph` ne regarde pas
 * `data`, donc un graphe fabriqué à la main passerait autant d'adresses qu'il veut, et un refus ferait du bloc un no-op
 * muet) ; la console masque le bouton « + » une fois la borne atteinte.
 */
export const MAX_DESTINATAIRES_EMAIL = 3;
