import { MarkerType, type Node, type Edge } from '@xyflow/react';
import type { WorkflowGraph, WorkflowNodeType } from '@/lib/api';
import { poigneeCanevas, poigneeGraphe, uneAreteParSortie } from '@/lib/workflow-sorties';

/**
 * La FRONTIÈRE entre le graphe enregistré et le canevas React Flow, plus le peu que les deux côtés du builder
 * (les blocs dessinés, le panneau de configuration) lisent tous les deux.
 *
 * Sorti de `WorkflowBuilder.tsx` le 2026-09-01 : le fichier portait 1 860 lignes, dont le bloc dessiné, le
 * panneau de config et l'enregistrement, qui ne partagent que ces quelques primitives. Elles vivent ici pour
 * que les trois fichiers les IMPORTENT au lieu d'en garder chacun une copie (c'est ce qui avait fait diverger
 * la palette et le menu du fil, cf. `nodeMeta.ts`).
 */

export type RFNode = Node<Record<string, unknown>>;
export type RFEdge = Edge;

/** Style commun de toutes les arêtes : type `wf` (la courbe avec + et poubelle) et la flèche au bout. */
export const EDGE_OPTS = { type: 'wf', markerEnd: { type: MarkerType.ArrowClosed, color: '#94a3b8' } };

/** Destinataire tel que porté par `data.to` du node email : `{kind:'literal',value}` ou `{kind:'field',field}`,
 *  lu défensivement (le graphe est opaque, cf. `actionOf` côté moteur). */
export type EmailRecipientData = { kind?: string; value?: string; field?: string };

/** Les sorties DÉCLARÉES d'un bloc agent, lues défensivement : `data` est du JSON libre, et un scénario
 *  enregistré par une version antérieure ne doit jamais faire tomber l'éditeur. */
export function sortiesDuBloc(data: Record<string, unknown>): Array<{ code: string; label: string }> {
  if (!Array.isArray(data.sorties)) return [];
  return (data.sorties as Array<{ code?: unknown; label?: unknown }>)
    .map((s) => ({ code: String(s?.code ?? '').trim(), label: String(s?.label ?? '').trim() }))
    .filter((s) => s.code !== '')
    .map((s) => ({ code: s.code, label: s.label === '' ? s.code : s.label }));
}

export function toRF(graph: WorkflowGraph): { nodes: RFNode[]; edges: RFEdge[] } {
  return {
    nodes: graph.nodes.map((n) => ({ id: n.id, type: 'wf', position: n.position, data: { wfType: n.type, ...n.data } })),
    // 🔴 La sortie libre est NOMMÉE dans le canevas (`libre`) alors qu'elle ne l'est pas en base : sans nom,
    // React Flow ancre la flèche sur la PREMIÈRE poignée du bloc, donc sur la ligne de la première réponse
    // rapide, où une autre flèche part déjà. Voir `lib/workflow-sorties.ts`.
    edges: uneAreteParSortie(graph.edges).map((e) => ({ id: e.id, source: e.source, target: e.target, ...EDGE_OPTS, sourceHandle: poigneeCanevas(e.sourceHandle) })),
  };
}

export function fromRF(nodes: RFNode[], edges: RFEdge[]): WorkflowGraph {
  return {
    nodes: nodes.map((n) => {
      const { wfType, ...rest } = n.data as { wfType?: WorkflowNodeType };
      return { id: n.id, type: (wfType ?? 'template') as WorkflowNodeType, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) }, data: rest };
    }),
    // La sortie libre redevient une arête SANS poignée : c'est le contrat du moteur, et il ne change pas.
    edges: edges.map((e) => {
      const h = poigneeGraphe(e.sourceHandle);
      return { id: e.id, source: e.source, target: e.target, ...(h ? { sourceHandle: h } : {}) };
    }),
  };
}
