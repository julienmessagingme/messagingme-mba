import { describe, it, expect } from 'vitest';
import { WorkflowExecutor } from '../src/workflow/executor';
import type { WorkflowGraph, WorkflowNodeType } from '../src/workflow/graph';
import type { WorkflowRunRow, RunState } from '../src/workflow/run-store.pg';

const n = (id: string, type: WorkflowNodeType, data: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, data });
const e = (id: string, source: string, target: string) => ({ id, source, target });
const eh = (id: string, source: string, target: string, sourceHandle: string) => ({ id, source, target, sourceHandle });

class FakeRuns {
  run: WorkflowRunRow | null = null;
  async start(tenantId: string, workflowId: string, waId: string, _contactId: string | null, state: RunState): Promise<{ id: string }> {
    this.run = { id: 'r1', workflowId, tenantId, waId, currentNode: state.currentNode, status: state.status, lastMessageId: null };
    return { id: 'r1' };
  }
  async findWaitingByWaId(_t: string, waId: string): Promise<WorkflowRunRow | null> {
    return this.run && this.run.status === 'waiting' && this.run.waId === waId ? this.run : null;
  }
  async setState(id: string, state: RunState): Promise<void> {
    if (this.run && this.run.id === id) this.run = { ...this.run, currentNode: state.currentNode, status: state.status, lastMessageId: state.lastMessageId ?? this.run.lastMessageId };
  }
}

function make(graph: WorkflowGraph) {
  const runs = new FakeRuns();
  const calls: string[] = [];
  const ex = new WorkflowExecutor({
    runs,
    getGraph: async () => graph,
    applyTag: async (_t, _w, tag) => { calls.push(`tag:${tag}`); },
    setField: async (_t, _w, k, v) => { calls.push(`field:${k}=${v}`); },
    sendTemplate: async (_t, _w, name) => { calls.push(`tpl:${name}`); },
  });
  return { ex, runs, calls };
}

describe('WorkflowExecutor', () => {
  // tag -> template -> inbox
  const linear: WorkflowGraph = {
    nodes: [n('t', 'tag', { tag: 'vip' }), n('tpl', 'template', { templateName: 'promo', language: 'fr' }), n('ib', 'inbox')],
    edges: [e('e1', 't', 'tpl'), e('e2', 'tpl', 'ib')],
  };

  it('start : pose le tag, envoie le template, run en attente au template', async () => {
    const { ex, runs, calls } = make(linear);
    await ex.start('t1', 'wf1', linear, { waId: '33600', contactId: 'c1' });
    expect(calls).toEqual(['tag:vip', 'tpl:promo']);
    expect(runs.run).toMatchObject({ status: 'waiting', currentNode: 'tpl' });
  });

  it('advance : le contact répond -> la conversation arrive en inbox (run terminé)', async () => {
    const { ex, runs, calls } = make(linear);
    await ex.start('t1', 'wf1', linear, { waId: '33600', contactId: 'c1' });
    await ex.advance('t1', '33600', 'msg1');
    expect(runs.run).toMatchObject({ status: 'inbox', currentNode: null });
    expect(calls).toEqual(['tag:vip', 'tpl:promo']); // pas de nouvel envoi (inbox n'a pas d'action)
  });

  it('workflow 100% synchrone (tag seul) : action appliquée, AUCUN run persistant', async () => {
    const g: WorkflowGraph = { nodes: [n('t', 'tag', { tag: 'x' })], edges: [] };
    const { ex, runs, calls } = make(g);
    await ex.start('t1', 'wf1', g, { waId: '33600', contactId: 'c1' });
    expect(calls).toEqual(['tag:x']);
    expect(runs.run).toBeNull();
  });

  it('advance idempotent : un même message ne fait pas avancer 2 fois', async () => {
    // tag -> tpl1 -> tpl2 -> inbox : après la 1re réponse, run attend au tpl2.
    const g: WorkflowGraph = {
      nodes: [n('t', 'tag', { tag: 'a' }), n('tpl1', 'template', { templateName: 't1', language: 'fr' }), n('tpl2', 'template', { templateName: 't2', language: 'fr' }), n('ib', 'inbox')],
      edges: [e('e1', 't', 'tpl1'), e('e2', 'tpl1', 'tpl2'), e('e3', 'tpl2', 'ib')],
    };
    const { ex, runs, calls } = make(g);
    await ex.start('t1', 'wf1', g, { waId: '33600', contactId: 'c1' });
    expect(calls).toEqual(['tag:a', 'tpl:t1']);
    await ex.advance('t1', '33600', 'm1'); // -> envoie t2, attend au tpl2
    expect(runs.run).toMatchObject({ status: 'waiting', currentNode: 'tpl2', lastMessageId: 'm1' });
    await ex.advance('t1', '33600', 'm1'); // MÊME message -> no-op
    expect(calls).toEqual(['tag:a', 'tpl:t1', 'tpl:t2']); // pas de 2e envoi de t2
  });

  it('advance sans run en attente -> no-op', async () => {
    const { ex } = make(linear);
    await expect(ex.advance('t1', '33600', 'm1')).resolves.toBeUndefined();
  });

  // template à 2 boutons quick-reply -> 2 branches (btn:0 -> tag oui, btn:1 -> tag non).
  const branched: WorkflowGraph = {
    nodes: [
      n('tpl', 'template', { templateName: 'promo', language: 'fr', templateButtons: [{ type: 'QUICK_REPLY', text: 'Oui' }, { type: 'QUICK_REPLY', text: 'Non' }] }),
      n('ta', 'tag', { tag: 'oui' }), n('tb', 'tag', { tag: 'non' }), n('ib', 'inbox'),
    ],
    edges: [eh('e0', 'tpl', 'ta', 'btn:0'), eh('e1', 'tpl', 'tb', 'btn:1'), e('e2', 'ta', 'ib'), e('e3', 'tb', 'ib')],
  };

  it('advance BRANCHE par bouton : btn:1 -> suit l\'arête de CE bouton', async () => {
    const { ex, runs, calls } = make(branched);
    await ex.start('t1', 'wf1', branched, { waId: '33600', contactId: 'c1' });
    expect(runs.run).toMatchObject({ status: 'waiting', currentNode: 'tpl' });
    await ex.advance('t1', '33600', 'm1', 'btn:1'); // tape « Non »
    expect(calls).toContain('tag:non');
    expect(calls).not.toContain('tag:oui');
    expect(runs.run).toMatchObject({ status: 'inbox' });
  });

  it('advance REPLI : réponse texte (buttonPayload null) -> 1re arête sortante', async () => {
    const { ex, calls } = make(branched);
    await ex.start('t1', 'wf1', branched, { waId: '33600', contactId: 'c1' });
    await ex.advance('t1', '33600', 'm2', null);
    expect(calls).toContain('tag:oui'); // 1re arête (btn:0)
    expect(calls).not.toContain('tag:non');
  });

  it('advance REPLI : bouton non câblé (btn:9) -> 1re arête sortante', async () => {
    const { ex, calls } = make(branched);
    await ex.start('t1', 'wf1', branched, { waId: '33600', contactId: 'c1' });
    await ex.advance('t1', '33600', 'm3', 'btn:9');
    expect(calls).toContain('tag:oui'); // repli : aucun handle btn:9 -> nextNode
  });

  // Capture le 6e arg (explicitParams) de sendTemplate pour vérifier le câblage campagne workflow.
  function makeCapturing(graph: WorkflowGraph) {
    const runs = new FakeRuns();
    const captured: Array<string[] | undefined> = [];
    const ex = new WorkflowExecutor({
      runs,
      getGraph: async () => graph,
      applyTag: async () => {},
      setField: async () => {},
      sendTemplate: async (_t, _w, _name, _lang, _btns, explicitParams) => { captured.push(explicitParams); },
    });
    return { ex, captured };
  }

  it('start avec firstTemplateParams : le 1er sendTemplate reçoit ces params (campagne workflow, pas de re-résolution)', async () => {
    const g: WorkflowGraph = {
      nodes: [n('tpl', 'template', { templateName: 'promo', language: 'fr' }), n('ib', 'inbox')],
      edges: [e('e1', 'tpl', 'ib')],
    };
    const { ex, captured } = makeCapturing(g);
    await ex.start('t1', 'wf1', g, { waId: '33600', contactId: 'c1' }, ['Julie']);
    expect(captured).toEqual([['Julie']]);
  });

  it('advance : sendTemplate SANS explicitParams (hints stockés -> comportement inchangé)', async () => {
    // tpl1 -> tpl2 -> inbox : start envoie tpl1 AVEC params, l\'advance envoie tpl2 SANS params (undefined).
    const g: WorkflowGraph = {
      nodes: [n('tpl1', 'template', { templateName: 't1', language: 'fr' }), n('tpl2', 'template', { templateName: 't2', language: 'fr' }), n('ib', 'inbox')],
      edges: [e('e1', 'tpl1', 'tpl2'), e('e2', 'tpl2', 'ib')],
    };
    const { ex, captured } = makeCapturing(g);
    await ex.start('t1', 'wf1', g, { waId: '33600', contactId: 'c1' }, ['Julie']);
    await ex.advance('t1', '33600', 'm1');
    expect(captured).toEqual([['Julie'], undefined]);
  });
});
