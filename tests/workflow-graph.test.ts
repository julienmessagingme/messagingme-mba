import { describe, it, expect } from 'vitest';
import { parseGraph, isWorkflowNodeType } from '../src/workflow/graph';

const node = (id: string, type: string, over: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, data: {}, ...over });

describe('isWorkflowNodeType', () => {
  it('accepte les types connus, rejette le reste', () => {
    for (const t of ['template', 'quick_message', 'inbox', 'flow', 'condition', 'action', 'wait', 'rcs_message']) expect(isWorkflowNodeType(t)).toBe(true);
    expect(isWorkflowNodeType('mba')).toBe(false);
    expect(isWorkflowNodeType(3)).toBe(false);
  });

  it('🔴 accepte encore les types LEGACY, sinon un ancien scénario devient inenregistrable', () => {
    // `parseGraph` rejette le graphe ENTIER dès qu'un type lui est inconnu. `tag`/`field` (remplacés par le bloc
    // Action) et `mba_handoff`/`mba_disable` (retirés du produit) ne sont plus dans la palette, mais un scénario
    // enregistré avant leur retrait doit continuer de se sauvegarder. Sans cette tolérance, l'utilisateur se
    // prendrait un « graphe invalide » sur un scénario qu'il n'a pas modifié.
    for (const t of ['tag', 'field', 'mba_handoff', 'mba_disable']) expect(isWorkflowNodeType(t), t).toBe(true);
  });

  it('🔴 un graphe contenant un bloc legacy se parse ENTIÈREMENT, sans perdre les autres blocs', () => {
    const g = parseGraph({
      nodes: [node('n1', 'mba_handoff'), node('n2', 'template', { data: { templateName: 'promo' } })],
      edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
    });
    expect(g).not.toBeNull();
    expect(g?.nodes.map((n) => n.id)).toEqual(['n1', 'n2']);
    expect(g?.edges).toHaveLength(1);
  });
});

describe('parseGraph', () => {
  it('graphe valide -> sanitisé (champs inconnus retirés)', () => {
    const g = parseGraph({
      nodes: [node('n1', 'tag', { data: { tag: 'vip' }, junk: 1 }), node('n2', 'template', { position: { x: 10, y: 20 } })],
      edges: [{ id: 'e1', source: 'n1', target: 'n2', junk: 'x' }],
    });
    expect(g).not.toBeNull();
    expect(g!.nodes.map((n) => n.id)).toEqual(['n1', 'n2']);
    expect(g!.nodes[0]).toEqual({ id: 'n1', type: 'tag', position: { x: 0, y: 0 }, data: { tag: 'vip' } });
    expect(g!.edges[0]).toEqual({ id: 'e1', source: 'n1', target: 'n2' });
  });

  it('graphe vide autorisé', () => {
    expect(parseGraph({ nodes: [], edges: [] })).toEqual({ nodes: [], edges: [] });
  });

  it('arête orpheline (node inexistant) -> null (intégrité référentielle)', () => {
    expect(parseGraph({ nodes: [node('n1', 'tag')], edges: [{ id: 'e1', source: 'n1', target: 'nX' }] })).toBeNull();
  });

  it('type de node inconnu -> null', () => {
    expect(parseGraph({ nodes: [node('n1', 'wat')], edges: [] })).toBeNull();
  });

  it('id de node dupliqué -> null', () => {
    expect(parseGraph({ nodes: [node('n1', 'tag'), node('n1', 'inbox')], edges: [] })).toBeNull();
  });

  it('position non numérique -> null', () => {
    expect(parseGraph({ nodes: [node('n1', 'tag', { position: { x: 'a', y: 0 } })], edges: [] })).toBeNull();
  });

  it('nodes/edges non tableau -> null', () => {
    expect(parseGraph({ nodes: {}, edges: [] })).toBeNull();
    expect(parseGraph(null)).toBeNull();
    expect(parseGraph({ nodes: [] })).toBeNull();
  });

  it('sourceHandle conservé si non vide (branche PB2)', () => {
    const g = parseGraph({ nodes: [node('n1', 'template'), node('n2', 'inbox')], edges: [{ id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'oui' }] });
    expect(g!.edges[0]!.sourceHandle).toBe('oui');
  });

  it('caps : > 200 nodes ou > 400 edges -> null (anti-DoS)', () => {
    const many = Array.from({ length: 201 }, (_, i) => node(`n${i}`, 'tag'));
    expect(parseGraph({ nodes: many, edges: [] })).toBeNull();
    const two = [node('a', 'tag'), node('b', 'inbox')];
    const manyEdges = Array.from({ length: 401 }, (_, i) => ({ id: `e${i}`, source: 'a', target: 'b' }));
    expect(parseGraph({ nodes: two, edges: manyEdges })).toBeNull();
  });
});
