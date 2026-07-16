import type { WorkflowGraph } from './graph';
import { makeCode } from '../ids/code';

const ULID_RE = '[0-9A-HJKMNP-TV-Z]{26}';

/**
 * Minte côté SERVEUR le code public de chaque node (`nod_<code-client>_<ULID>`, stocké dans `node.data.code`).
 * - Un code VALIDE du MÊME tenant est CONSERVÉ (stabilité des codes = contrat API).
 * - Un code absent, malformé ou d'un AUTRE tenant (graphe copié / client qui forge) est (re)minté : le client
 *   ne peut pas imposer un code.
 * - Les edges ne sont JAMAIS touchés (elles référencent `node.id`, l'uuid interne, pas le code).
 * Les nodes déjà valides sont retournés par RÉFÉRENCE (permet au backfill de détecter « rien n'a changé »).
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
