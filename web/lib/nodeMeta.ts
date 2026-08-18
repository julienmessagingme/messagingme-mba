import type { WorkflowNodeType } from './api';

// Métadonnées d'affichage des types de node (blocs). Les libellés portent les DEUX langues ([fr, en]) :
// c'est une constante module (useT inappelable ici), résolue au rendu via t(...meta.label). Partagé par
// le builder de scénario et la page Contenu > Blocs (source unique, pas de duplication).
export const NODE_META: Record<WorkflowNodeType, { emoji: string; label: [string, string] }> = {
  template: { emoji: '📩', label: ['Envoi template', 'Send template'] },
  quick_message: { emoji: '⚡', label: ['Message rapide', 'Quick message'] },
  // Ce bloc EST l'« assigner à un agent » : il passe le fil à un humain et le fait apparaître dans
  // « À traiter ». Il s'appelait « Inbox », un nom de destination qui ne disait pas ce qu'il FAIT.
  inbox: { emoji: '🙋', label: ['Assigner à un agent', 'Assign to an agent'] },
  flow: { emoji: '📋', label: ['Formulaire', 'Form'] },
  tag: { emoji: '🏷️', label: ['Ajout de tag', 'Add tag'] }, // legacy : plus dans la palette, gardé pour le rendu des anciens blocs
  field: { emoji: '✏️', label: ['Ajout de champ', 'Add field'] }, // legacy : idem
  condition: { emoji: '🔀', label: ['Condition', 'Condition'] },
  wait: { emoji: '⏳', label: ['Attente', 'Wait'] },
  action: { emoji: '⚙️', label: ['Action', 'Action'] },
  rcs_message: { emoji: '📱', label: ['Message RCS', 'RCS message'] },
  // Blocs RETIRÉS du produit. Ces entrées ne servent plus qu'à RENDRE lisiblement un ancien scénario qui en
  // contient encore : ils ne sont plus dans la palette, et le moteur les traverse sans rien faire.
  mba_handoff: { emoji: '🗑️', label: ['Bloc MBA (retiré)', 'MBA block (removed)'] },
  mba_disable: { emoji: '🗑️', label: ['Bloc MBA (retiré)', 'MBA block (removed)'] },
};

// La palette ne propose plus `tag`/`field` séparés : le bloc « Action » les regroupe (ajouter/retirer tag, màj/vider champ).
export const NODE_ORDER: WorkflowNodeType[] = ['template', 'quick_message', 'flow', 'action', 'condition', 'wait', 'inbox'];

// Bloc RCS : présenté à part et GRISÉ tant que le tenant n'a pas d'agent RCS rattaché. Même doctrine que les
// blocs MBA. Le canal est construit de bout en bout, mais un agent doit être déposé et approuvé par Google et
// les opérateurs avant qu'un seul message puisse partir : proposer le bloc avant, c'est promettre un envoi qui
// finirait en erreur.
export const RCS_NODE_ORDER: WorkflowNodeType[] = ['rcs_message'];


/** Repli pour un type de node NON encore connu du front (ex. un type ajouté côté backend avant son UI, comme
 *  `condition` en attendant la Phase 3). Évite un crash de rendu (`NODE_META[type].emoji` sur `undefined`) qui
 *  démonterait toute la page builder / « Contenu > Blocs ». */
const UNKNOWN_NODE_META: { emoji: string; label: [string, string] } = { emoji: '🧩', label: ['Bloc', 'Block'] };

/** Métadonnées d'un type de node, TOLÉRANT un type inconnu (renvoie un repli neutre au lieu de `undefined`). À
 *  utiliser partout où le type provient de données de graphe (potentiellement en avance sur le front). */
export function nodeMetaOf(type: string): { emoji: string; label: [string, string] } {
  return (NODE_META as Record<string, { emoji: string; label: [string, string] }>)[type] ?? UNKNOWN_NODE_META;
}
