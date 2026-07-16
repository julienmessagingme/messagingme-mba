import { describe, it, expect } from 'vitest';
import { mintNodeCodes } from '../src/workflow/node-codes';
import type { WorkflowGraph } from '../src/workflow/graph';

const CODE_RE = /^nod_k7m2p3_[0-9A-HJKMNP-TV-Z]{26}$/;
const n = (id: string, data: Record<string, unknown> = {}): WorkflowGraph['nodes'][number] => ({ id, type: 'tag', position: { x: 0, y: 0 }, data });

describe('mintNodeCodes', () => {
  it('remplit un code absent (format nod_<client>_<ulid>), data préservée, edges intactes', () => {
    const g: WorkflowGraph = { nodes: [n('a', { tag: 'vip' }), n('b')], edges: [{ id: 'e1', source: 'a', target: 'b' }] };
    const m = mintNodeCodes(g, 'k7m2p3');
    expect(m.nodes[0]!.data.code).toMatch(CODE_RE);
    expect(m.nodes[1]!.data.code).toMatch(CODE_RE);
    expect(m.nodes[0]!.data.tag).toBe('vip');
    expect(m.edges).toBe(g.edges); // strictement inchangées (même référence)
  });

  it('CONSERVE un code valide du même tenant (stabilité = contrat API, même référence de node)', () => {
    const code = 'nod_k7m2p3_0123456789ABCDEFGHJKMNPQRS';
    const g: WorkflowGraph = { nodes: [n('a', { code })], edges: [] };
    const m = mintNodeCodes(g, 'k7m2p3');
    expect(m.nodes[0]).toBe(g.nodes[0]); // référence identique -> « rien n'a changé » détectable (backfill)
    expect(m.nodes[0]!.data.code).toBe(code);
  });

  it('RE-MINT un code étranger (autre tenant) ou malformé (le client ne peut pas imposer un code)', () => {
    const g: WorkflowGraph = {
      nodes: [n('a', { code: 'nod_autre1_0123456789ABCDEFGHJKMNPQRS' }), n('b', { code: 'forge' }), n('c', { code: 42 })],
      edges: [],
    };
    const m = mintNodeCodes(g, 'k7m2p3');
    for (const node of m.nodes) expect(node.data.code).toMatch(CODE_RE);
  });

  it('graphe vide -> ok, deux mints -> codes distincts', () => {
    expect(mintNodeCodes({ nodes: [], edges: [] }, 'k7m2p3')).toEqual({ nodes: [], edges: [] });
    const g: WorkflowGraph = { nodes: [n('a'), n('b')], edges: [] };
    const m = mintNodeCodes(g, 'k7m2p3');
    expect(m.nodes[0]!.data.code).not.toBe(m.nodes[1]!.data.code);
  });
});
