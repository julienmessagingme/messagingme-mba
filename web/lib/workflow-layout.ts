// Disposition automatique des blocs d'un scénario, en COUCHES gauche->droite (horizontal). Module PUR (aucune
// dépendance React/@xyflow/navigateur au chargement) -> testable depuis la suite racine (tests/web-workflow-layout.test.ts).
// L'éditeur (WorkflowBuilder) applique le résultat via setNodes ; l'auto-save existant persiste les positions.

export interface LayoutNode { id: string }
export interface LayoutEdge { source: string; target: string }
export interface Pos { x: number; y: number }

const DEFAULT_COL_GAP = 260; // écart horizontal entre deux couches
const DEFAULT_ROW_GAP = 120; // écart vertical entre deux blocs d'une même couche

/**
 * Calcule une position {x,y} par node. couche(node) = plus long chemin depuis une racine (relaxation bornée à
 * N itérations -> jamais d'emballement sur un cycle). Les nodes d'une couche sont empilés verticalement et
 * CENTRÉS. x = couche * colGap (flux horizontal), y centré. Déterministe (ordre d'entrée préservé). Un node
 * déconnecté reste en couche 0 avec une position valide (jamais NaN). Une edge vers un node inexistant est ignorée.
 */
export function autoLayoutHorizontal(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  opts: { colGap?: number; rowGap?: number } = {},
): Map<string, Pos> {
  const colGap = opts.colGap ?? DEFAULT_COL_GAP;
  const rowGap = opts.rowGap ?? DEFAULT_ROW_GAP;
  const result = new Map<string, Pos>();
  if (nodes.length === 0) return result;

  const ids = nodes.map((n) => n.id);
  const idSet = new Set(ids);
  const validEdges = edges.filter((e) => idSet.has(e.source) && idSet.has(e.target));

  // Relaxation « plus long chemin » : layer(target) = max(layer(target), layer(source)+1). Bornée à nodes.length
  // itérations : converge pour un DAG, et reste finie/bornée sur un cycle (pas de boucle infinie).
  const layer = new Map<string, number>(ids.map((id) => [id, 0]));
  for (let iter = 0; iter < nodes.length; iter += 1) {
    let changed = false;
    for (const e of validEdges) {
      const ls = layer.get(e.source)!;
      if (layer.get(e.target)! < ls + 1) { layer.set(e.target, ls + 1); changed = true; }
    }
    if (!changed) break;
  }

  // Groupe par couche dans l'ordre d'entrée (déterminisme).
  const byLayer = new Map<number, string[]>();
  for (const id of ids) {
    const l = layer.get(id)!;
    const arr = byLayer.get(l);
    if (arr) arr.push(id); else byLayer.set(l, [id]);
  }

  for (const [l, groupIds] of byLayer) {
    const k = groupIds.length;
    groupIds.forEach((id, j) => {
      result.set(id, {
        x: Math.round(l * colGap),
        y: Math.round((j - (k - 1) / 2) * rowGap),
      });
    });
  }
  return result;
}
