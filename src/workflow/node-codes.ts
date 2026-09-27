import type { WorkflowGraph } from './graph';
import { makeCode } from '../ids/code';

const ULID_RE = '[0-9A-HJKMNP-TV-Z]{26}';

/**
 * Attribue côté serveur le code public de chaque node (`nod_<code-client>_<ULID>`, dans `node.data.code`).
 * Un code valide du même tenant est conservé (stabilité des codes = contrat API) ; un code absent, malformé ou
 * d'un autre tenant est refait : le client ne peut pas imposer un code. Les edges ne sont pas touchées (elles
 * référencent `node.id`). Les nodes déjà valides sont rendus par référence, ce qui permet au backfill de voir
 * que rien n'a changé.
 */
export function mintNodeCodes(graph: WorkflowGraph, tenantCode: string): WorkflowGraph {
  const valid = new RegExp(`^nod_${tenantCode}_${ULID_RE}$`);
  return {
    nodes: graph.nodes.map((n) => {
      const existing = typeof n.data.code === 'string' ? n.data.code : '';
      if (valid.test(existing)) return n;
      return { ...n, data: { ...n.data, code: makeCode('nod', tenantCode) } };
    }),
    edges: graph.edges,
  };
}
