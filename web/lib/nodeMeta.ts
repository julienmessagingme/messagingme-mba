import type { WorkflowNodeType } from './api';

// Métadonnées d'affichage des types de node (blocs). Les libellés portent les DEUX langues ([fr, en]) :
// c'est une constante module (useT inappelable ici), résolue au rendu via t(...meta.label). Partagé par
// le builder de scénario et la page Contenu > Blocs (source unique, pas de duplication).
export const NODE_META: Record<WorkflowNodeType, { emoji: string; label: [string, string] }> = {
  template: { emoji: '📩', label: ['Envoi template', 'Send template'] },
  quick_message: { emoji: '⚡', label: ['Message rapide', 'Quick message'] },
  inbox: { emoji: '💬', label: ['Inbox', 'Inbox'] },
  flow: { emoji: '📋', label: ['Formulaire', 'Form'] },
  tag: { emoji: '🏷️', label: ['Ajout de tag', 'Add tag'] },
  field: { emoji: '✏️', label: ['Ajout de champ', 'Add field'] },
};

export const NODE_ORDER: WorkflowNodeType[] = ['template', 'quick_message', 'flow', 'tag', 'field', 'inbox'];

/** Repli pour un type de node NON encore connu du front (ex. un type ajouté côté backend avant son UI, comme
 *  `condition` en attendant la Phase 3). Évite un crash de rendu (`NODE_META[type].emoji` sur `undefined`) qui
 *  démonterait toute la page builder / « Contenu > Blocs ». */
export const UNKNOWN_NODE_META: { emoji: string; label: [string, string] } = { emoji: '🧩', label: ['Bloc', 'Block'] };

/** Métadonnées d'un type de node, TOLÉRANT un type inconnu (renvoie un repli neutre au lieu de `undefined`). À
 *  utiliser partout où le type provient de données de graphe (potentiellement en avance sur le front). */
export function nodeMetaOf(type: string): { emoji: string; label: [string, string] } {
  return (NODE_META as Record<string, { emoji: string; label: [string, string] }>)[type] ?? UNKNOWN_NODE_META;
}
