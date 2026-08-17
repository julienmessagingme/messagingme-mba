import { describe, it, expect } from 'vitest';
import { parseGraph } from '../src/workflow/graph';
import type { WorkflowGraph } from '../src/workflow/graph';
import { WorkflowExecutor } from '../src/workflow/executor';
import type { WorkflowExecutorDeps } from '../src/workflow/executor';
import type { RunState } from '../src/workflow/run-store.pg';
import { RcsSender } from '../src/rcs/sender';
import { Reachability } from '../src/rcs/reachability';
import type { ReachabilityStore } from '../src/rcs/reachability';
import { FakeRcsProvider } from '../src/rcs/fake';

const pos = { x: 0, y: 0 };

class SansCache implements ReachabilityStore {
  async get() {
    return null;
  }
  async put() {
    /* rien */
  }
}

/** Scénario : bloc RCS, sortie « envoyé » vers un tag, sortie « non joignable » vers un template WhatsApp. */
function graphe(): WorkflowGraph {
  return parseGraph({
    nodes: [
      { id: 'r', type: 'rcs_message', position: pos, data: { text: 'Bonjour en RCS' } },
      { id: 'suite', type: 'action', position: pos, data: { actionKind: 'add_tag', tag: 'rcs-recu' } },
      { id: 'repli', type: 'template', position: pos, data: { templateName: 'relance', language: 'fr' } },
    ],
    edges: [
      { id: 'e1', source: 'r', target: 'suite', sourceHandle: 'sent' },
      { id: 'e2', source: 'r', target: 'repli', sourceHandle: 'unreachable' },
    ],
  })!;
}

function monter(graph: WorkflowGraph, nonJoignables: string[] = [], avecRcs = true) {
  const provider = new FakeRcsProvider({ unreachable: new Set(nonJoignables) });
  const rcsSender = new RcsSender(provider, new Reachability(provider, new SansCache(), () => 0), {
    isOptedOut: async () => false,
  });
  const etats: Array<Record<string, unknown>> = [];
  const tags: string[] = [];
  const templates: string[] = [];
  const deps: WorkflowExecutorDeps = {
    getGraph: async () => graph,
    applyTag: async (_t, _w, tag) => {
      tags.push(tag);
    },
    setField: async () => {},
    removeTag: async () => {},
    clearField: async () => {},
    sendTemplate: async (_t, _w, name) => {
      templates.push(name);
    },
    sendQuickMessage: async () => {},
    sendFlow: async () => {},
    now: () => 1_000,
    runs: {
      start: async (_tenantId: string, _workflowId: string, _waId: string, _contactId: string | null, state: RunState) => {
        etats.push({ ...state });
        return { id: 'run-1' };
      },
      setState: async (_id: string, state: RunState) => {
        etats.push({ ...state });
      },
      findWaitingByWaId: async () => null,
    },
    ...(avecRcs ? { rcs: { sender: rcsSender, agentIdFor: async () => 'agent-1' } } : {}),
  };
  return { provider, deps, etats, tags, templates, executor: new WorkflowExecutor(deps) };
}

describe('bloc RCS a l execution', () => {
  it('envoie et met le run EN ATTENTE sur le bloc quand le numero est joignable', async () => {
    const g = graphe();
    const { provider, etats, executor } = monter(g);
    await executor.start('t1', 'w1', g, { waId: '+33600000002', contactId: 'c1' });

    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]).toMatchObject({ agentId: 'agent-1', e164: '+33600000002', msg: { kind: 'text', text: 'Bonjour en RCS' } });
    expect(etats.at(-1)).toMatchObject({ currentNode: 'r', status: 'waiting' });
  });

  it('n envoie RIEN et part sur la branche de repli WhatsApp quand le numero n est pas joignable', async () => {
    const g = graphe();
    const { provider, templates, executor } = monter(g, ['+33600000001']);
    await executor.start('t1', 'w1', g, { waId: '+33600000001', contactId: 'c1' });

    expect(provider.sent).toHaveLength(0);
    expect(templates).toEqual(['relance']);
  });

  it('part sur la branche de repli quand le canal RCS n est pas cable du tout', async () => {
    const g = graphe();
    const { templates, executor } = monter(g, [], false);
    await executor.start('t1', 'w1', g, { waId: '+33600000002', contactId: 'c1' });
    expect(templates).toEqual(['relance']);
  });

  it('termine le run quand le numero n est pas joignable ET que la sortie de repli n est pas cablee', async () => {
    const g = parseGraph({
      nodes: [
        { id: 'r', type: 'rcs_message', position: pos, data: { text: 'Bonjour' } },
        { id: 'suite', type: 'action', position: pos, data: { actionKind: 'add_tag', tag: 'rcs-recu' } },
      ],
      edges: [{ id: 'e1', source: 'r', target: 'suite', sourceHandle: 'sent' }],
    })!;
    const { provider, tags, etats, executor } = monter(g, ['+33600000001']);
    await executor.start('t1', 'w1', g, { waId: '+33600000001', contactId: 'c1' });

    expect(provider.sent).toHaveLength(0);
    // La sortie 'sent' ne doit PAS être volée par le repli absent.
    expect(tags).toEqual([]);
    expect(etats.filter((e) => e.status === 'waiting')).toHaveLength(0);
  });

  it('n envoie RIEN quand le bloc n a pas de texte configure, et part en repli', async () => {
    const g = parseGraph({
      nodes: [
        { id: 'r', type: 'rcs_message', position: pos, data: {} },
        { id: 'repli', type: 'template', position: pos, data: { templateName: 'relance', language: 'fr' } },
      ],
      edges: [{ id: 'e2', source: 'r', target: 'repli', sourceHandle: 'unreachable' }],
    })!;
    const { provider, templates, executor } = monter(g);
    await executor.start('t1', 'w1', g, { waId: '+33600000002', contactId: 'c1' });

    expect(provider.sent).toHaveLength(0);
    expect(templates).toEqual(['relance']);
  });
});
