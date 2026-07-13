/**
 * Modèle du graphe d'un workflow (bot builder). PUR : parsing/validation/sanitisation, aucune IO.
 * Un workflow = des blocs (nodes) reliés par des arêtes (edges). PB1 : on stocke/valide/édite le graphe.
 * L'exécution (machine à états par contact) arrive en PB2 et interprétera `data` selon le type de node.
 */

export const WORKFLOW_NODE_TYPES = ['template', 'inbox', 'flow', 'tag', 'field'] as const;
export type WorkflowNodeType = (typeof WORKFLOW_NODE_TYPES)[number];
export function isWorkflowNodeType(t: unknown): t is WorkflowNodeType {
  return typeof t === 'string' && (WORKFLOW_NODE_TYPES as readonly string[]).includes(t);
}

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  position: { x: number; y: number };
  /** Config du bloc, dépend du type (templateName / flowId / tag / key+value...). Opaque en PB1. */
  data: Record<string, unknown>;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  /** Port de sortie (branche) : réservé pour PB2 (ex. bouton quick-reply d'un template). */
  sourceHandle?: string;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

const MAX_NODES = 200;
const MAX_EDGES = 400;

/**
 * Parse + SANITISE un graphe reçu du client. Renvoie un graphe propre (champs inconnus retirés) ou null si
 * invalide : ids manquants/dupliqués, type de node inconnu, position non numérique, arête pointant un node
 * inexistant (intégrité référentielle), ou graphe trop gros. Ne fait AUCUNE hypothèse sur `data` (opaque).
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
