import { describe, it, expect } from 'vitest';
import { walk, entryNode, nextNode, nextNodeByHandle, opensOutsideServiceWindow } from '../src/workflow/engine';
import type { WorkflowGraph, WorkflowNodeType } from '../src/workflow/graph';

const n = (id: string, type: WorkflowNodeType, data: Record<string, unknown> = {}): WorkflowGraph['nodes'][number] => ({ id, type, position: { x: 0, y: 0 }, data });
const e = (id: string, source: string, target: string) => ({ id, source, target });
const eh = (id: string, source: string, target: string, sourceHandle: string) => ({ id, source, target, sourceHandle });

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

describe('nextNodeByHandle', () => {
  const g: WorkflowGraph = {
    nodes: [n('tpl', 'template', { templateName: 'p' }), n('a', 'tag', { tag: 'a' }), n('b', 'tag', { tag: 'b' })],
    edges: [eh('e0', 'tpl', 'a', 'btn:0'), eh('e1', 'tpl', 'b', 'btn:1')],
  };
  it('suit l\'arête du handle demandé', () => {
    expect(nextNodeByHandle(g, 'tpl', 'btn:0')).toBe('a');
    expect(nextNodeByHandle(g, 'tpl', 'btn:1')).toBe('b');
  });
  it('handle inconnu -> null (le repli nextNode est géré par l\'appelant)', () => {
    expect(nextNodeByHandle(g, 'tpl', 'btn:9')).toBeNull();
    expect(nextNode(g, 'tpl')).toBe('a'); // repli = 1re arête
  });
});

describe('walk : action sendTemplate porte les boutons du template', () => {
  it('template avec boutons -> action { buttons }', () => {
    const g: WorkflowGraph = {
      nodes: [n('tpl', 'template', { templateName: 'promo', language: 'fr', templateButtons: [{ type: 'QUICK_REPLY', text: 'Oui' }, { type: 'URL', text: 'Site', url: 'https://x' }] })],
      edges: [],
    };
    const r = walk(g, 'tpl');
    expect(r.actions).toEqual([{ kind: 'sendTemplate', templateName: 'promo', language: 'fr', buttons: [{ type: 'QUICK_REPLY', text: 'Oui' }, { type: 'URL', text: 'Site' }] }]);
  });
});

describe('walk : quick_message', () => {
  it('corps + réponses -> action sendQuickMessage (ordre préservé), waiting', () => {
    const g: WorkflowGraph = { nodes: [n('qm', 'quick_message', { body: 'Ça te va ?', quickReplies: ['Oui', 'Non'] })], edges: [] };
    const r = walk(g, 'qm');
    expect(r.actions).toEqual([{ kind: 'sendQuickMessage', body: 'Ça te va ?', buttons: [{ type: 'QUICK_REPLY', text: 'Oui' }, { type: 'QUICK_REPLY', text: 'Non' }] }]);
    expect(r.rest).toEqual({ status: 'waiting', nodeId: 'qm' });
  });
  it('sans corps -> pas d\'action mais attend quand même (bloc bloquant)', () => {
    const g: WorkflowGraph = { nodes: [n('qm', 'quick_message', { body: '', quickReplies: ['Oui'] })], edges: [] };
    const r = walk(g, 'qm');
    expect(r.actions).toEqual([]);
    expect(r.rest).toEqual({ status: 'waiting', nodeId: 'qm' });
  });
  it('aucune réponse non vide -> pas d\'action', () => {
    const g: WorkflowGraph = { nodes: [n('qm', 'quick_message', { body: 'Salut', quickReplies: ['', ''] })], edges: [] };
    expect(walk(g, 'qm').actions).toEqual([]);
  });
});

describe('walk : node flow (Lot 7 : envoi du formulaire, fini le no-op)', () => {
  it('flowId + nom -> action sendFlow avec accroche et cta par défaut, waiting', () => {
    const g: WorkflowGraph = { nodes: [n('f', 'flow', { flowId: 'fl1', flowName: 'Prise de RDV' })], edges: [] };
    const r = walk(g, 'f');
    expect(r.actions).toEqual([{ kind: 'sendFlow', flowId: 'fl1', flowName: 'Prise de RDV', body: 'Formulaire : Prise de RDV', cta: 'Envoyer' }]);
    expect(r.rest).toEqual({ status: 'waiting', nodeId: 'f' });
  });
  it('accroche et cta du node prioritaires (cta tronqué à 30)', () => {
    const g: WorkflowGraph = { nodes: [n('f', 'flow', { flowId: 'fl1', flowName: 'RDV', body: ' Réserve ton créneau ', cta: 'Un libellé beaucoup trop long pour un bouton' })], edges: [] };
    expect(walk(g, 'f').actions).toEqual([
      { kind: 'sendFlow', flowId: 'fl1', flowName: 'RDV', body: 'Réserve ton créneau', cta: 'Un libellé beaucoup trop long ' },
    ]);
  });
  it('sans flowId -> pas d\'action mais attend quand même (bloc bloquant, contrat historique)', () => {
    const g: WorkflowGraph = { nodes: [n('f', 'flow', {})], edges: [] };
    const r = walk(g, 'f');
    expect(r.actions).toEqual([]);
    expect(r.rest).toEqual({ status: 'waiting', nodeId: 'f' });
  });
});

describe('opensOutsideServiceWindow (garde fenêtre 24 h à l\'ouverture)', () => {
  it('flow (ou chaîne synchrone -> flow) en ouverture -> true', () => {
    const direct: WorkflowGraph = { nodes: [n('f', 'flow', { flowId: 'fl1' })], edges: [] };
    expect(opensOutsideServiceWindow(direct)).toBe(true);
    const chained: WorkflowGraph = {
      nodes: [n('t', 'tag', { tag: 'vip' }), n('f', 'flow', { flowId: 'fl1' })],
      edges: [e('e1', 't', 'f')],
    };
    expect(opensOutsideServiceWindow(chained)).toBe(true);
  });
  it('quick_message en ouverture -> true ; template en ouverture -> false', () => {
    const qm: WorkflowGraph = { nodes: [n('q', 'quick_message', { body: 'Salut', quickReplies: ['Oui'] })], edges: [] };
    expect(opensOutsideServiceWindow(qm)).toBe(true);
    expect(opensOutsideServiceWindow(linear)).toBe(false);
  });
  it('flow APRÈS un template (pas en ouverture) -> false ; flow d\'ouverture NON configuré (sans flowId) -> false', () => {
    const after: WorkflowGraph = {
      nodes: [n('tpl', 'template', { templateName: 'promo', language: 'fr' }), n('f', 'flow', { flowId: 'fl1' })],
      edges: [e('e1', 'tpl', 'f')],
    };
    expect(opensOutsideServiceWindow(after)).toBe(false);
    // Node flow vide : aucune action produite -> le graphe reste enregistrable pendant la construction.
    const unconfigured: WorkflowGraph = { nodes: [n('f', 'flow', {})], edges: [] };
    expect(opensOutsideServiceWindow(unconfigured)).toBe(false);
  });
  it('graphe vide -> false', () => {
    expect(opensOutsideServiceWindow({ nodes: [], edges: [] })).toBe(false);
  });
});

describe('walk', () => {
  it('depuis l\'entrée : applique le tag SYNCHRONE puis s\'arrête au template (waiting)', () => {
    const r = walk(linear, entryNode(linear)!);
    expect(r.actions).toEqual([
      { kind: 'tag', tag: 'vip' },
      { kind: 'sendTemplate', templateName: 'promo', language: 'fr', buttons: [] },
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
