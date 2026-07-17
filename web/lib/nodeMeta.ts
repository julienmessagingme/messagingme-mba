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
