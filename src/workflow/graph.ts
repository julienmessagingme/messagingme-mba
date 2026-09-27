/**
 * Modèle du graphe d'un workflow (bot builder). Pur : parsing, validation, sanitisation, aucune IO.
 * Un workflow = des blocs (nodes) reliés par des arêtes (edges) ; l'exécuteur interprète `data` selon le type.
 */

// `action` = bloc unifié (tag, champ) via `data.actionKind` ; `tag`/`field` restent lus pour les scénarios
// existants, la palette ne crée plus que `action`.
// `inbox` = « Assigner à un agent » : le scénario s'arrête et la conversation passe à un humain (« À traiter »).
// Il ne coupe pas l'agent de Meta lui-même (c'est le message qui le précède qui a pris le fil) : il revendique
// le fil pour l'humain, ce qui suffit à ce que la règle du hors-script ne le rende plus à l'agent.
// `mba_handoff` / `mba_disable` : retirés du produit, le moteur les traverse en passe-plat. Ils restent acceptés
// ici, comme `tag`/`field` : `parseGraph` rejette le graphe entier dès qu'un type est inconnu, donc un ancien
// scénario qui en contient deviendrait impossible à sauvegarder.
// `rcs_message` = envoi RCS, deux sorties typées ('sent' / 'unreachable') : sa branche dépend de la
// joignabilité, donc d'un appel réseau, et le walk (pur) rend la main à l'executor pour cette IO.
// `email` = « Envoi de mail » : action synchrone non bloquante (même branche que `tag`), l'IO étant faite
// best-effort par l'executor après coup.
// `question` : question au contact, avec ou sans menu (liste interactive WhatsApp). Attend une réponse ET porte
// une échéance. Sorties : `row:<i>` par ligne, `timeout` à l'échéance, l'arête libre pour une réponse écrite.
// `http` = « Appel HTTP » : joue un appel de Tools > Connecteurs API et range la réponse dans un champ. Action
// synchrone non bloquante ; le bloc désigne un appel de la bibliothèque, il ne le décrit pas.
// `js` = « Fonction JS » : transforme un champ par du JavaScript du client, exécuté dans QuickJS (WebAssembly)
// avec plafonds de temps et de mémoire (voir `src/workflow/fonction-js.ts`).
export const WORKFLOW_NODE_TYPES = ['template', 'quick_message', 'inbox', 'flow', 'question', 'tag', 'field', 'condition', 'action', 'wait', 'mba_handoff', 'mba_disable', 'rcs_message', 'email', 'agent', 'http', 'js'] as const;
export type WorkflowNodeType = (typeof WORKFLOW_NODE_TYPES)[number];
export function isWorkflowNodeType(t: unknown): t is WorkflowNodeType {
  return typeof t === 'string' && (WORKFLOW_NODE_TYPES as readonly string[]).includes(t);
}

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  position: { x: number; y: number };
  /** Config du bloc, dépend du type (templateName / flowId / tag / key+value...). Opaque ici. */
  data: Record<string, unknown>;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  /** Port de sortie (branche), ex. bouton quick-reply d'un template. */
  sourceHandle?: string;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

const MAX_NODES = 200;
const MAX_EDGES = 400;

/**
 * Parse + sanitise un graphe reçu du client. Renvoie un graphe propre (champs inconnus retirés) ou null si
 * invalide : ids manquants/dupliqués, type de node inconnu, position non numérique, arête pointant un node
 * inexistant, ou graphe trop gros. Ne fait aucune hypothèse sur `data` (opaque).
 */
export function parseGraph(v: unknown): WorkflowGraph | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const g = v as { nodes?: unknown; edges?: unknown };
  if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) return null;
  if (g.nodes.length > MAX_NODES || g.edges.length > MAX_EDGES) return null;

  const nodes: WorkflowNode[] = [];
  const nodeIds = new Set<string>();
  for (const raw of g.nodes) {
    if (!raw || typeof raw !== 'object') return null;
    const n = raw as { id?: unknown; type?: unknown; position?: unknown; data?: unknown };
    if (typeof n.id !== 'string' || n.id === '' || nodeIds.has(n.id)) return null;
    if (!isWorkflowNodeType(n.type)) return null;
    const pos = n.position as { x?: unknown; y?: unknown } | null | undefined;
    const x = Number(pos?.x);
    const y = Number(pos?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const data = n.data && typeof n.data === 'object' && !Array.isArray(n.data) ? (n.data as Record<string, unknown>) : {};
    nodes.push({ id: n.id, type: n.type, position: { x, y }, data });
    nodeIds.add(n.id);
  }

  const edges: WorkflowEdge[] = [];
  const edgeIds = new Set<string>();
  for (const raw of g.edges) {
    if (!raw || typeof raw !== 'object') return null;
    const e = raw as { id?: unknown; source?: unknown; target?: unknown; sourceHandle?: unknown };
    if (typeof e.id !== 'string' || e.id === '' || edgeIds.has(e.id)) return null;
    if (typeof e.source !== 'string' || typeof e.target !== 'string') return null;
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) return null; // intégrité référentielle
    edges.push({ id: e.id, source: e.source, target: e.target, ...(typeof e.sourceHandle === 'string' && e.sourceHandle !== '' ? { sourceHandle: e.sourceHandle } : {}) });
    edgeIds.add(e.id);
  }

  return { nodes, edges };
}
