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

function monter(graph: WorkflowGraph, nonJoignables: string[] = [], avecRcs = true, enAttenteSur?: string, vars?: Record<string, string | null>, canal: 'whatsapp' | 'rcs' = 'whatsapp') {
  const provider = new FakeRcsProvider({ unreachable: new Set(nonJoignables) });
  const rcsSender = new RcsSender(provider, new Reachability(provider, new SansCache(), () => 0), {
    isOptedOut: async () => false,
  });
  const etats: Array<Record<string, unknown>> = [];
  const tags: string[] = [];
  const templates: string[] = [];
  const quickWhatsApp: string[] = [];
  const fil: Array<{ body: string; messageId: string }> = [];
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
    sendQuickMessage: async (_t, _w, body) => { quickWhatsApp.push(body); },
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
        ? { id: 'run-1', tenantId: 't1', workflowId: 'w1', waId: '33600000002', currentNode: enAttenteSur, status: 'waiting' as const, lastMessageId: null, channel: canal }
        : null),
    },
    ...(avecRcs
      ? { rcs: { sender: rcsSender, agentIdFor: async () => 'agent-1', recordOutbound: async (_t: string, _w: string, m: { body: string; messageId: string }) => { fil.push(m); }, ...(vars ? { varsFor: async () => vars } : {}) } }
      : {}),
  };
  return { provider, deps, etats, tags, templates, quickWhatsApp, fil, executor: new WorkflowExecutor(deps) };
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

  /**
   * CE QUI SE PASSE APRÈS UN PREMIER BLOC RCS. Question de Julien du 2026-08-24, verifiee ici plutot
   * qu'affirmee : brancher un envoi derriere un bloc RCS, est-ce que ca part ?
   *
   * Reponse mesuree : un TEMPLATE part (il n'a besoin d'aucune fenetre), un message de SESSION ne part pas si
   * le contact n'a pas ecrit sur WhatsApp depuis 24 h, ce qui est le cas normal quand l'echange a eu lieu en
   * RCS. Ce n'est pas un defaut de notre code, c'est la regle de WhatsApp ; ce qui compte est que le parcours
   * ne fasse pas SEMBLANT d'avoir envoye.
   */
  it('un TEMPLATE branche derriere « envoye » part bien quand le rapport de livraison arrive', async () => {
    const g = parseGraph({
      nodes: [
        { id: 'r', type: 'rcs_message', position: pos, data: { text: 'Bonjour en RCS' } },
        { id: 'tpl', type: 'template', position: pos, data: { templateName: 'suite', language: 'fr' } },
      ],
      edges: [{ id: 'e1', source: 'r', target: 'tpl', sourceHandle: 'sent' }],
    })!;
    const { templates, executor } = monter(g, [], true, 'r');
    expect(await executor.rcsDelivered('t1', '33600000002', 'msg-1')).toBe(true);
    expect(templates).toEqual(['suite']);
  });

  it('un TEMPLATE branche derriere un BOUTON part quand le contact tape ce bouton', async () => {
    const g = parseGraph({
      nodes: [
        {
          id: 'r', type: 'rcs_message', position: pos,
          data: { text: 'Bonjour', suggestions: [{ kind: 'reply', text: 'Oui', postbackData: 'oui' }] },
        },
        { id: 'tpl', type: 'template', position: pos, data: { templateName: 'apres-clic', language: 'fr' } },
      ],
      edges: [{ id: 'e1', source: 'r', target: 'tpl', sourceHandle: 'btn:0' }],
    })!;
    const { templates, executor } = monter(g, [], true, 'r');
    // C'est exactement ce que le webhook de reponses appelle quand smsmode renvoie le clic.
    await executor.advance('t1', '33600000002', 'mo-1', 'btn:0', 'rcs');
    expect(templates).toEqual(['apres-clic']);
  });

  /**
   * 🔴 LE MULTICANAL, tel que Julien l'a demande le 2026-08-24.
   *
   * Un << message rapide >> est un texte avec des reponses en un tap : WhatsApp sait le faire, le RCS aussi.
   * Le bloc dit donc l'INTENTION, pas le canal ; c'est le PARCOURS qui porte le canal. Un contact qui vient de
   * cliquer un bouton RCS n'a jamais ecrit sur WhatsApp : envoyer la suite en WhatsApp la ferait refuser par
   * Meta (fenetre de 24 h) et tuerait le parcours.
   */
  it('un MESSAGE RAPIDE derriere un bloc RCS part EN RCS, avec ses boutons', async () => {
    const g = parseGraph({
      nodes: [
        {
          id: 'r', type: 'rcs_message', position: pos,
          data: { text: 'Bonjour', suggestions: [{ kind: 'reply', text: 'Clique 2', postbackData: 'c2' }] },
        },
        { id: 'qm', type: 'quick_message', position: pos, data: { body: 'Ca vous va ?', quickReplies: ['Oui', 'Non'] } },
      ],
      edges: [{ id: 'e1', source: 'r', target: 'qm', sourceHandle: 'btn:0' }],
    })!;
    const { provider, quickWhatsApp, executor } = monter(g, [], true, 'r', undefined, 'rcs');

    await executor.advance('t1', '33600000002', 'mo-1', 'btn:0', 'rcs');

    // Parti sur le RESEAU RCS, pas par WhatsApp.
    expect(quickWhatsApp).toEqual([]);
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]!.msg).toEqual({
      kind: 'text',
      text: 'Ca vous va ?',
      // Les libelles deviennent des boutons REPONSE, dans le meme ordre : c'est ce qui fait revenir le clic
      // sur la bonne sortie du bloc.
      suggestions: [
        { kind: 'reply', text: 'Oui', postbackData: 'btn:0' },
        { kind: 'reply', text: 'Non', postbackData: 'btn:1' },
      ],
    });
  });

  /**
   * L'AUTRE branche du meme montage : un template Meta derriere le bloc RCS. La, on BASCULE volontairement sur
   * WhatsApp, et le parcours doit s'en souvenir pour la suite.
   */
  it('un TEMPLATE derriere un bloc RCS bascule le parcours sur WhatsApp', async () => {
    const g = parseGraph({
      nodes: [
        {
          id: 'r', type: 'rcs_message', position: pos,
          data: { text: 'Bonjour', suggestions: [{ kind: 'reply', text: 'Recois un whatsapp', postbackData: 'w' }] },
        },
        { id: 'tpl', type: 'template', position: pos, data: { templateName: 'rdv_randstad', language: 'fr' } },
      ],
      edges: [{ id: 'e1', source: 'r', target: 'tpl', sourceHandle: 'btn:0' }],
    })!;
    const { provider, templates, etats, executor } = monter(g, [], true, 'r', undefined, 'rcs');

    await executor.advance('t1', '33600000002', 'mo-2', 'btn:0', 'rcs');

    expect(templates).toEqual(['rdv_randstad']);
    expect(provider.sent).toHaveLength(0);
    expect(etats.at(-1)).toMatchObject({ channel: 'whatsapp' });
  });

  // Le canal ne suit pas une INTENTION, il suit ce que le contact a RECU : un envoi RCS saute (desabonne, agent
  // absent) part au repli WhatsApp, et le parcours doit rester sur WhatsApp.
  it('le parcours passe sur le canal RCS SEULEMENT si le message est parti', async () => {
    const g = graphe();
    const { etats, executor } = monter(g);
    await executor.start('t1', 'w1', g, { waId: '+33600000002', contactId: 'c1' });
    expect(etats.at(-1)).toMatchObject({ channel: 'rcs' });

    const { etats: etats2, executor: executor2 } = monter(g, ['+33600000002']);
    await executor2.start('t1', 'w1', g, { waId: '+33600000002', contactId: 'c1' });
    expect(etats2.at(-1)).toMatchObject({ channel: 'whatsapp' });
  });

  /**
   * Le seul montage qui reste impossible : un FORMULAIRE WhatsApp (Flow) derriere un RCS. Il n'a pas
   * d'equivalent RCS, donc il part forcement en WhatsApp, et Meta le refuse hors fenetre. Le parcours ne fait
   * pas semblant : il clot et remonte la conversation a un humain.
   */
  it('un FORMULAIRE derriere un bloc RCS est refuse, et la conversation remonte', async () => {
    const g = parseGraph({
      nodes: [
        { id: 'r', type: 'rcs_message', position: pos, data: { text: 'Bonjour' } },
        { id: 'f', type: 'flow', position: pos, data: { flowId: 'fl1', body: 'Formulaire', cta: 'Ouvrir' } },
      ],
      edges: [{ id: 'e1', source: 'r', target: 'f', sourceHandle: 'sent' }],
    })!;
    const { deps } = monter(g, [], true, 'r', undefined, 'rcs');
    const remontees: string[] = [];
    const etats: Array<Record<string, unknown>> = [];
    const executor = new WorkflowExecutor({
      ...deps,
      sendFlow: async () => 'fenêtre de 24 h fermée (131047)',
      escalateToHuman: async (_t, waId) => { remontees.push(waId); },
      runs: { ...deps.runs, setState: async (_id, state) => { etats.push({ ...state }); } },
    });
    await executor.rcsDelivered('t1', '33600000002', 'msg-2');
    expect(remontees).toEqual(['33600000002']);
    expect(etats.at(-1)).toMatchObject({ status: 'inbox', currentNode: null });
  });

  /**
   * 🔴 Un message RCS parti par un SCENARIO doit apparaitre dans le fil, comme un template ou un message
   * rapide. Signale par Julien le 2026-08-24 : il voyait la reponse du contact sans jamais voir la question,
   * ce qui rend une conversation illisible pour l'operateur qui la reprend.
   */
  it('journalise le message RCS d un bloc dans le FIL de conversation', async () => {
    const g = graphe();
    const { fil, executor } = monter(g);
    await executor.start('t1', 'w1', g, { waId: '+33600000002', contactId: 'c1' });
    expect(fil).toHaveLength(1);
    expect(fil[0]!.body).toBe('Bonjour en RCS');
    expect(fil[0]!.messageId).not.toBe('');
  });

  it('journalise aussi un message rapide parti EN RCS', async () => {
    const g = parseGraph({
      nodes: [
        { id: 'r', type: 'rcs_message', position: pos, data: { text: 'Bonjour', suggestions: [{ kind: 'reply', text: 'Oui', postbackData: 'o' }] } },
        { id: 'qm', type: 'quick_message', position: pos, data: { body: 'Ca vous va ?', quickReplies: ['Oui', 'Non'] } },
      ],
      edges: [{ id: 'e1', source: 'r', target: 'qm', sourceHandle: 'btn:0' }],
    })!;
    const { fil, executor } = monter(g, [], true, 'r', undefined, 'rcs');
    await executor.advance('t1', '33600000002', 'mo-1', 'btn:0', 'rcs');
    expect(fil.map((m) => m.body)).toEqual(['Ca vous va ?']);
  });

  // Un envoi SAUTE n'a rien montre au contact : il n'a rien a faire dans le fil non plus.
  it('n ecrit RIEN dans le fil quand l envoi est saute', async () => {
    const g = graphe();
    const { fil, executor } = monter(g, ['+33600000002']);
    await executor.start('t1', 'w1', g, { waId: '+33600000002', contactId: 'c1' });
    expect(fil).toEqual([]);
  });
});

/**
 * Etancheite des canaux au RETOUR (lot 2026-08-25). Les deux tuyaux partagent le MEME espace de handles
 * `btn:<i>` (src/rcs/schema.ts et src/meta/client.ts) : sans le canal, rien ne distingue un tap de suggestion
 * RCS d'un tap de bouton WhatsApp, et `advance` faisait avancer le parcours d'un cran sur un retour qui ne le
 * concernait pas. Le client recevait alors la suite d'un parcours auquel il n'avait pas repondu.
 */
describe('etancheite des canaux : advance refuse un retour du mauvais tuyau', () => {
  /** Bloc `type` en attente, une seule sortie `btn:0` vers un tag : le tag est le temoin d'avancement. */
  function grapheEnAttente(type: 'template' | 'quick_message' | 'rcs_message'): WorkflowGraph {
    const data = type === 'template' ? { templateName: 'question', language: 'fr' } : { body: 'Ca vous va ?', text: 'Ca vous va ?' };
    return parseGraph({
      nodes: [
        { id: 'n', type, position: pos, data },
        { id: 'suite', type: 'action', position: pos, data: { actionKind: 'add_tag', tag: 'avance' } },
      ],
      edges: [{ id: 'e1', source: 'n', target: 'suite', sourceHandle: 'btn:0' }],
    })!;
  }

  it('un tap de suggestion RCS n avance PAS un parcours qui attend une reponse WhatsApp', async () => {
    const g = grapheEnAttente('template');
    const { tags, etats, executor } = monter(g, [], true, 'n', undefined, 'whatsapp');

    await executor.advance('t1', '33600000002', 'mo-rcs', 'btn:0', 'rcs');
    expect(tags).toEqual([]); // le parcours n a pas bouge
    expect(etats).toEqual([]); // ni avance, ni clos : le run reste `waiting`, et lastMessageId n est PAS ecrit

    // Et le retour du BON tuyau avance bien : la garde ne casse pas le chemin nominal.
    await executor.advance('t1', '33600000002', 'wamid.1', 'btn:0', 'whatsapp');
    expect(tags).toEqual(['avance']);
  });

  it('un message WhatsApp n avance PAS un parcours qui attend sur un bloc RCS', async () => {
    // Sans la garde, `handle` valait 'sent' par defaut sur un bloc RCS : un simple message WhatsApp
    // (« c est quoi ce message ? ») reprenait la sortie « envoye » alors qu aucun rapport n etait arrive.
    const g = graphe();
    const { tags, etats, executor } = monter(g, [], true, 'r', undefined, 'rcs');

    await executor.advance('t1', '33600000002', 'wamid.2', null, 'whatsapp');
    expect(tags).toEqual([]);
    expect(etats).toEqual([]);
  });

  it('le canal attendu vient du PARCOURS, pas du type du bloc : un message rapide en RCS attend du RCS', async () => {
    // 🔴 Le piege de ce lot. Ecrire « bloc non-RCS = whatsapp » serait faux : un message rapide derriere un
    // bloc RCS est ENVOYE en RCS (apply suit le canal du parcours) et attend donc une reponse RCS. C est
    // exactement ce que la migration 0082 est venue corriger. Ce test echoue si on l ecrit a l envers.
    const g = grapheEnAttente('quick_message');
    const { tags, executor } = monter(g, [], true, 'n', undefined, 'rcs');

    await executor.advance('t1', '33600000002', 'wamid.3', 'btn:0', 'whatsapp');
    expect(tags).toEqual([]); // le bloc n est pas RCS, mais le PARCOURS l est

    await executor.advance('t1', '33600000002', 'mo-rcs', 'btn:0', 'rcs');
    expect(tags).toEqual(['avance']);
  });
});
