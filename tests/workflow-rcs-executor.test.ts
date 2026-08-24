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

function monter(graph: WorkflowGraph, nonJoignables: string[] = [], avecRcs = true, enAttenteSur?: string, vars?: Record<string, string | null>) {
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
    ...(avecRcs
      ? { rcs: { sender: rcsSender, agentIdFor: async () => 'agent-1', ...(vars ? { varsFor: async () => vars } : {}) } }
      : {}),
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

  it('bascule en CARTE des qu un visuel est renseigne, boutons DANS la carte', async () => {
    const g = parseGraph({
      nodes: [{
        id: 'r', type: 'rcs_message', position: pos,
        data: {
          text: 'Notre offre',
          imageUrl: 'https://x/visuel.jpg',
          suggestions: [{ kind: 'reply', text: 'Oui', postbackData: 'oui' }],
        },
      }],
      edges: [],
    })!;
    const { provider, executor } = monter(g);
    await executor.start('t1', 'w1', g, { waId: '+33600000002', contactId: 'c1' });
    // Dans la carte, le bouton s'affiche en pleine largeur et y reste ; sous le message il ne serait qu'une
    // pastille ephemere. Et sa charge utile est bien renumerotee `btn:0` MEME dans la carte, sans quoi le clic
    // ne retrouverait plus sa branche.
    expect(provider.sent[0]!.msg).toEqual({
      kind: 'card',
      card: {
        description: 'Notre offre',
        mediaUrl: 'https://x/visuel.jpg',
        mediaHeight: 'TALL',
        suggestions: [{ kind: 'reply', text: 'Oui', postbackData: 'btn:0' }],
      },
    });
  });

  it('remplace les variables du contact dans le message', async () => {
    const g = parseGraph({
      nodes: [{ id: 'r', type: 'rcs_message', position: pos, data: { text: 'Bonjour {{prenom}}, a {{ville}} ?' } }],
      edges: [],
    })!;
    const { provider, executor } = monter(g, [], true, undefined, { prenom: 'Julien', ville: null });
    await executor.start('t1', 'w1', g, { waId: '+33600000002', contactId: 'c1' });
    // `ville` sans valeur laisse un BLANC : un message part toujours, jamais bloque par une fiche incomplete.
    expect(provider.sent[0]!.msg).toEqual({ kind: 'text', text: 'Bonjour Julien, a  ?' });
  });

  // Sans variable dans le message, la fiche du contact n'est PAS lue : une campagne de 5 000 numeros sur un
  // message fige ne doit pas declencher 5 000 lectures pour rien.
  it('ne lit PAS la fiche du contact quand le message n a aucune variable', async () => {
    const g = parseGraph({
      nodes: [{ id: 'r', type: 'rcs_message', position: pos, data: { text: 'Bonjour' } }],
      edges: [],
    })!;
    let lectures = 0;
    const { deps, provider } = monter(g);
    const executor = new WorkflowExecutor({
      ...deps,
      rcs: { ...deps.rcs!, varsFor: async () => { lectures += 1; return {}; } },
    });
    await executor.start('t1', 'w1', g, { waId: '+33600000002', contactId: 'c1' });
    expect(provider.sent).toHaveLength(1);
    expect(lectures).toBe(0);
  });

  /**
   * Sans bouton, un bloc RCS n'attend rien d'autre que son accuse : c'est le rapport DELIVERED qui relance
   * le parcours. Sans cette reprise, un scenario << RCS puis attente puis relance >> resterait bloque pour
   * tout contact qui ne repond pas, c'est-a-dire la quasi-totalite.
   */
  it('un rapport DELIVERED relance le parcours par « envoye » quand le bloc n a aucun bouton', async () => {
    const g = graphe();
    const { tags, executor } = monter(g, [], true, 'r');
    const repris = await executor.rcsDelivered('t1', '33600000002', 'msg-smsmode-3');
    expect(repris).toBe(true);
    expect(tags).toEqual(['rcs-recu']);
  });

  // 🔴 L'inverse, et c'est le cas qui casserait tout : l'accuse arrive en quelques secondes, le contact
  // repond bien plus tard. Avancer sur << remis >> enverrait son clic dans le vide.
  it('NE relance PAS sur DELIVERED quand le bloc propose un bouton reponse', async () => {
    const g = parseGraph({
      nodes: [
        {
          id: 'r', type: 'rcs_message', position: pos,
          data: { text: 'Bonjour', suggestions: [{ kind: 'reply', text: 'Oui', postbackData: 'oui' }] },
        },
        { id: 'suite', type: 'action', position: pos, data: { actionKind: 'add_tag', tag: 'rcs-recu' } },
      ],
      edges: [{ id: 'e1', source: 'r', target: 'suite', sourceHandle: 'sent' }],
    })!;
    const { tags, executor } = monter(g, [], true, 'r');
    const repris = await executor.rcsDelivered('t1', '33600000002', 'msg-smsmode-4');
    expect(repris).toBe(false);
    expect(tags).toEqual([]);
  });

  it('un rapport DELIVERED ne touche PAS un parcours qui attend sur un autre bloc', async () => {
    const g = parseGraph({
      nodes: [
        { id: 'tpl', type: 'template', position: pos, data: { templateName: 'accueil', language: 'fr' } },
        { id: 'apres', type: 'action', position: pos, data: { actionKind: 'add_tag', tag: 'avance-a-tort' } },
      ],
      edges: [{ id: 'e1', source: 'tpl', target: 'apres' }],
    })!;
    const { tags, executor } = monter(g, [], true, 'tpl');
    expect(await executor.rcsDelivered('t1', '33600000002', 'msg-smsmode-5')).toBe(false);
    expect(tags).toEqual([]);
  });
});
