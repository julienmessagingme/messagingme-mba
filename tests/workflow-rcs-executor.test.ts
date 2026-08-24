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

function monter(graph: WorkflowGraph, nonJoignables: string[] = [], avecRcs = true, enAttenteSur?: string) {
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
      findWaitingByWaId: async () => (enAttenteSur
        ? { id: 'run-1', tenantId: 't1', workflowId: 'w1', waId: '33600000002', currentNode: enAttenteSur, status: 'waiting' as const, lastMessageId: null }
        : null),
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

  it('envoie les BOUTONS du bloc, et ecarte ceux qui sont malformes au lieu de tout bloquer', async () => {
    const g = parseGraph({
      nodes: [{
        id: 'r', type: 'rcs_message', position: pos,
        data: {
          text: 'Bonjour',
          suggestions: [
            { kind: 'reply', text: 'Oui', postbackData: 'oui' },
            { kind: 'openUrl', text: 'Site', url: 'pas-une-url', postbackData: 'site' },
          ],
        },
      }],
      edges: [],
    })!;
    const { provider, executor } = monter(g);
    await executor.start('t1', 'w1', g, { waId: '+33600000002', contactId: 'c1' });

    expect(provider.sent).toHaveLength(1);
    // `postbackData` REECRIT en `btn:0` a l'envoi, alors que le bloc porte 'oui' : c'est ce nom-la que le
    // builder donne a la sortie du bouton, et c'est donc le seul qui permette au clic de retrouver sa
    // branche quand smsmode nous le renvoie. Voir `normaliserPostbacks`.
    expect(provider.sent[0]!.msg).toEqual({
      kind: 'text',
      text: 'Bonjour',
      suggestions: [{ kind: 'reply', text: 'Oui', postbackData: 'btn:0' }],
    });
  });

  it('envoie un texte NU quand le bloc n a aucun bouton', async () => {
    const g = parseGraph({
      nodes: [{ id: 'r', type: 'rcs_message', position: pos, data: { text: 'Bonjour' } }],
      edges: [],
    })!;
    const { provider, executor } = monter(g);
    await executor.start('t1', 'w1', g, { waId: '+33600000002', contactId: 'c1' });
    expect(provider.sent[0]!.msg).toEqual({ kind: 'text', text: 'Bonjour' });
  });

  /**
   * La cascade RCS -> WhatsApp. Chez smsmode la joignabilite ne se demande pas AVANT l'envoi : elle se
   * constate apres, sur un rapport de livraison. C'est donc ce rapport, et lui seul, qui allume la sortie
   * « non joignable » d'un bloc deja parti.
   */
  it('un rapport UNDELIVERABLE fait repartir le parcours par la sortie « non joignable »', async () => {
    const g = graphe();
    const { templates, executor } = monter(g, [], true, 'r');
    const bascule = await executor.rcsUndeliverable('t1', '33600000002', 'msg-smsmode-1');
    expect(bascule).toBe(true);
    expect(templates).toEqual(['relance']); // le repli WhatsApp est parti
  });

  // 🔴 La garde qui justifie une methode a part. Sur un run qui attend AUTRE CHOSE qu'un bloc RCS, un
  // `advance(..., 'unreachable')` retomberait sur la premiere arete libre et ferait avancer le parcours d'un
  // cran sur un accuse qui ne le concerne pas.
  it('ne touche PAS a un parcours qui attend sur un autre bloc', async () => {
    const g = parseGraph({
      nodes: [
        { id: 'tpl', type: 'template', position: pos, data: { templateName: 'accueil', language: 'fr' } },
        { id: 'apres', type: 'action', position: pos, data: { actionKind: 'add_tag', tag: 'avance-a-tort' } },
      ],
      edges: [{ id: 'e1', source: 'tpl', target: 'apres' }],
    })!;
    const { tags, executor } = monter(g, [], true, 'tpl');
    const bascule = await executor.rcsUndeliverable('t1', '33600000002', 'msg-smsmode-2');
    expect(bascule).toBe(false);
    expect(tags).toEqual([]);
  });
});
