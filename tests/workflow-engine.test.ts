import { describe, it, expect } from 'vitest';
import { walk, entryNode, nextNode } from '../src/workflow/engine';
import type { WorkflowGraph, WorkflowNodeType } from '../src/workflow/graph';

const n = (id: string, type: WorkflowNodeType, data: Record<string, unknown> = {}): WorkflowGraph['nodes'][number] => ({ id, type, position: { x: 0, y: 0 }, data });
const e = (id: string, source: string, target: string) => ({ id, source, target });

// tag(vip) -> template(promo) -> inbox
const linear: WorkflowGraph = {
  nodes: [n('t', 'tag', { tag: 'vip' }), n('tpl', 'template', { templateName: 'promo', language: 'fr' }), n('ib', 'inbox')],
  edges: [e('e1', 't', 'tpl'), e('e2', 'tpl', 'ib')],
};

describe('entryNode / nextNode', () => {
  it('entryNode = bloc sans arête entrante', () => {
    expect(entryNode(linear)).toBe('t');
  });
  it('nextNode = cible de la 1re arête sortante', () => {
    expect(nextNode(linear, 't')).toBe('tpl');
    expect(nextNode(linear, 'ib')).toBeNull();
  });
  it('graphe vide -> entryNode null', () => {
    expect(entryNode({ nodes: [], edges: [] })).toBeNull();
  });
});

describe('walk', () => {
  it('depuis l\'entrée : applique le tag SYNCHRONE puis s\'arrête au template (waiting)', () => {
    const r = walk(linear, entryNode(linear)!);
    expect(r.actions).toEqual([
      { kind: 'tag', tag: 'vip' },
      { kind: 'sendTemplate', templateName: 'promo', language: 'fr' },
    ]);
    expect(r.rest).toEqual({ status: 'waiting', nodeId: 'tpl' });
  });

  it('depuis le bloc après le template (inbox) : rest=inbox, aucune action', () => {
    const r = walk(linear, nextNode(linear, 'tpl')!);
    expect(r.actions).toEqual([]);
    expect(r.rest).toEqual({ status: 'inbox' });
  });

  it('bloc field -> action field', () => {
    const g: WorkflowGraph = { nodes: [n('f', 'field', { fieldKey: 'ville', value: 'Lyon' }), n('ib', 'inbox')], edges: [e('e', 'f', 'ib')] };
    const r = walk(g, 'f');
    expect(r.actions).toEqual([{ kind: 'field', key: 'ville', value: 'Lyon' }]);
    expect(r.rest).toEqual({ status: 'inbox' });
  });

  it('tag sans arête sortante -> done', () => {
    const g: WorkflowGraph = { nodes: [n('t', 'tag', { tag: 'x' })], edges: [] };
    expect(walk(g, 't').rest).toEqual({ status: 'done' });
  });

  it('cycle -> stoppe (done), pas de boucle infinie', () => {
    const g: WorkflowGraph = { nodes: [n('a', 'tag', { tag: 'a' }), n('b', 'tag', { tag: 'b' })], edges: [e('e1', 'a', 'b'), e('e2', 'b', 'a')] };
    const r = walk(g, 'a');
    expect(r.actions).toEqual([{ kind: 'tag', tag: 'a' }, { kind: 'tag', tag: 'b' }]);
    expect(r.rest).toEqual({ status: 'done' });
  });

  it('bloc de départ inconnu -> done sans action', () => {
    expect(walk(linear, 'zzz')).toEqual({ actions: [], rest: { status: 'done' } });
  });

  it('template sans templateName -> pas d\'action mais attend quand même', () => {
    const g: WorkflowGraph = { nodes: [n('tpl', 'template')], edges: [] };
    const r = walk(g, 'tpl');
    expect(r.actions).toEqual([]);
    expect(r.rest).toEqual({ status: 'waiting', nodeId: 'tpl' });
  });
});
