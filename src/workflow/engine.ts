import type { WorkflowGraph, WorkflowNode } from './graph';

/**
 * Moteur d'exécution d'un workflow, PUR (aucune IO). Un run avance en LIGNE DROITE : on suit la 1re arête
 * sortante de chaque bloc. Les blocs SYNCHRONES (tag/field) produisent une action et on continue ; un bloc
 * `template`/`flow` produit son action puis ATTEND une réponse du contact ; `inbox` est terminal (remontée
 * humaine). V1 volontairement simple : pas de branche par bouton (réservé plus tard via sourceHandle).
 */

/** Bouton d'un template (dénormalisé sur le node à la sélection) : sert à envoyer un payload contrôlé par
 *  bouton quick-reply (branche déterministe) et à afficher les sorties dans l'éditeur. */
export interface WorkflowButton { type: string; text: string }

export type WorkflowAction =
  | { kind: 'tag'; tag: string }
  | { kind: 'field'; key: string; value: string }
  | { kind: 'sendTemplate'; templateName: string; language: string; buttons: WorkflowButton[] }
  | { kind: 'sendQuickMessage'; body: string; buttons: WorkflowButton[] };

export type WalkRest =
  | { status: 'waiting'; nodeId: string } // en attente d'une réponse (après un template ou un formulaire)
  | { status: 'inbox' } // conversation remontée à l'humain (terminal)
  | { status: 'done' }; // fin de chaîne (plus d'arête sortante)

export interface WalkResult {
  actions: WorkflowAction[];
  rest: WalkRest;
}

/** Bloc d'entrée d'un workflow = un bloc SANS arête entrante (racine). Défaut : le 1er bloc. null si vide. */
export function entryNode(graph: WorkflowGraph): string | null {
  if (graph.nodes.length === 0) return null;
  const hasIncoming = new Set(graph.edges.map((e) => e.target));
  const root = graph.nodes.find((n) => !hasIncoming.has(n.id));
  return (root ?? graph.nodes[0]!).id;
}

/** Le bloc suivant (cible de la 1re arête sortante). null s'il n'y en a pas. */
export function nextNode(graph: WorkflowGraph, nodeId: string): string | null {
  return graph.edges.find((e) => e.source === nodeId)?.target ?? null;
}

/** Le bloc suivant POUR un handle de sortie donné (branche par bouton : sourceHandle = `btn:<index>`).
 *  null si aucune arête ne part de ce handle. */
export function nextNodeByHandle(graph: WorkflowGraph, nodeId: string, handle: string): string | null {
  return graph.edges.find((e) => e.source === nodeId && e.sourceHandle === handle)?.target ?? null;
}

function actionOf(node: WorkflowNode): WorkflowAction | null {
  if (node.type === 'tag') {
    const tag = String(node.data.tag ?? '').trim();
    return tag ? { kind: 'tag', tag } : null;
  }
  if (node.type === 'field') {
    const key = String(node.data.fieldKey ?? node.data.key ?? '').trim();
    return key ? { kind: 'field', key, value: String(node.data.value ?? '') } : null;
  }
  if (node.type === 'template') {
    const templateName = String(node.data.templateName ?? '').trim();
    if (!templateName) return null;
    const raw = Array.isArray(node.data.templateButtons) ? node.data.templateButtons : [];
    const buttons: WorkflowButton[] = raw.map((b) => ({
      type: String((b as { type?: unknown }).type ?? ''),
      text: String((b as { text?: unknown }).text ?? ''),
    }));
    return { kind: 'sendTemplate', templateName, language: String(node.data.language ?? 'fr'), buttons };
  }
  if (node.type === 'quick_message') {
    const body = String(node.data.body ?? '').trim();
    // Les réponses rapides gardent leur ORDRE (index = handle btn:<i> pour la branche) : on ne filtre PAS ici,
    // la couche d'envoi filtre les vides en préservant l'index. Bloc incomplet (pas de corps ou aucune réponse
    // non vide) -> null (no-op), comme un template sans templateName.
    const raw = Array.isArray(node.data.quickReplies) ? node.data.quickReplies : [];
    const buttons: WorkflowButton[] = raw.map((q) => ({ type: 'QUICK_REPLY', text: String(q ?? '') }));
    if (!body || !buttons.some((b) => b.text.trim() !== '')) return null;
    return { kind: 'sendQuickMessage', body, buttons };
  }
  return null;
}

/**
 * Parcourt le graphe depuis `startNodeId` : accumule les actions des blocs synchrones, s'arrête au 1er bloc
 * bloquant (template/flow -> waiting, inbox -> inbox) ou en fin de chaîne (done). Anti-cycle : un bloc déjà
 * visité arrête le parcours (done). Un `startNodeId` inconnu -> done sans action.
 */
export function walk(graph: WorkflowGraph, startNodeId: string): WalkResult {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const actions: WorkflowAction[] = [];
  const visited = new Set<string>();
  let current: string | null = startNodeId;

  while (current) {
    if (visited.has(current)) return { actions, rest: { status: 'done' } };
    visited.add(current);
    const node = byId.get(current);
    if (!node) return { actions, rest: { status: 'done' } };

    if (node.type === 'inbox') return { actions, rest: { status: 'inbox' } };
    if (node.type === 'template' || node.type === 'flow' || node.type === 'quick_message') {
      const a = actionOf(node);
      if (a) actions.push(a);
      return { actions, rest: { status: 'waiting', nodeId: current } };
    }
    // tag / field : bloc synchrone -> action + on continue.
    const a = actionOf(node);
    if (a) actions.push(a);
    current = nextNode(graph, current);
  }
  return { actions, rest: { status: 'done' } };
}
