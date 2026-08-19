import { describe, it, expect } from 'vitest';
import { walk } from '../src/workflow/engine';
import { WorkflowExecutor } from '../src/workflow/executor';
import type { WorkflowGraph } from '../src/workflow/graph';

/**
 * La MESURE PAR BLOC d'un scénario (socle de « Analytics > Mes tableaux »).
 *
 * Rien ne reliait un message envoyé au bloc qui l'a envoyé : `conversation_messages` ne porte pas
 * d'identifiant de bloc, et `workflow_runs` ne garde que la position courante. C'est `walk()` qui porte
 * désormais ce lien, et l'exécuteur qui l'enregistre.
 */
const n = (id: string, type: string, data: Record<string, unknown> = {}) =>
  ({ id, type, position: { x: 0, y: 0 }, data }) as WorkflowGraph['nodes'][number];

describe('walk : chaque action sait de quel bloc elle vient', () => {
  it('🔴 le bloc d’origine accompagne l’action, il n’est plus perdu', () => {
    const g: WorkflowGraph = {
      nodes: [n('a', 'action', { actionKind: 'add_tag', tag: 'vu' }), n('t', 'template', { templateName: 'promo', language: 'fr' })],
      edges: [{ id: 'e0', source: 'a', target: 't' }],
    };
    expect(walk(g, 'a').actions.map((e) => e.nodeId)).toEqual(['a', 't']);
  });

  it('deux blocs du MÊME type restent distincts (c’est tout l’enjeu d’un tableau par bloc)', () => {
    // Compter « les envois du template promo » ne dirait pas lequel des deux blocs a envoyé. Sans identifiant
    // de bloc, un scénario qui réutilise un template deviendrait immesurable.
    const g: WorkflowGraph = {
      nodes: [
        n('m1', 'quick_message', { body: 'un' }),
        n('m2', 'quick_message', { body: 'deux' }),
      ],
      edges: [{ id: 'e0', source: 'm1', target: 'm2' }],
    };
    expect(walk(g, 'm1').actions.map((e) => e.nodeId)).toEqual(['m1', 'm2']);
  });
});

/** Exécuteur à dépendances minimales. `mesures` capte ce qui serait écrit dans le journal des blocs. */
function executeur(graph: WorkflowGraph, opts: { envoiRate?: boolean; sansDep?: boolean } = {}) {
  const mesures: Array<Record<string, unknown>> = [];
  const run = { id: 'r1', workflowId: 'wf1', tenantId: 't1', waId: '33600000001', currentNode: 'n1', lastMessageId: null };
  const deps: Record<string, unknown> = {
    runs: { findWaitingByWaId: async () => run, setState: async () => {} },
    getGraph: async () => graph,
    applyTag: async () => {},
    setField: async () => {},
    removeTag: async () => {},
    clearField: async () => {},
    sendTemplate: async () => (opts.envoiRate === true ? 'template refusé par Meta' : undefined),
    sendQuickMessage: async () => (opts.envoiRate === true ? 'message refusé' : undefined),
    sendFlow: async () => {},
    escalateToHuman: async () => {},
  };
  if (opts.sansDep !== true) {
    deps.recordNodeEvent = async (e: Record<string, unknown>): Promise<void> => { mesures.push(e); };
  }
  return { ex: new WorkflowExecutor(deps as never), mesures };
}

/** Un bloc qui attend une réponse, suivi d'un second message. */
const graphe = (): WorkflowGraph => ({
  nodes: [
    n('n1', 'quick_message', { body: 'Un conseiller ?', quickReplies: [{ text: 'Oui' }] }),
    n('n2', 'quick_message', { body: 'Très bien' }),
  ],
  edges: [{ id: 'e0', source: 'n1', target: 'n2', sourceHandle: 'Oui' }],
});

describe('mesure des RÉPONSES, rattachée au bloc qui attendait', () => {
  it('🔴 un clic sur un choix -> `reply_button` avec le handle du bouton', async () => {
    const { ex, mesures } = executeur(graphe());
    await ex.advance('t1', '33600000001', 'msg1', 'Oui');
    expect(mesures[0]).toMatchObject({ workflowId: 'wf1', nodeId: 'n1', waId: '33600000001', kind: 'reply_button', handle: 'Oui' });
  });

  it('🔴 une réponse ÉCRITE (sans bouton) -> `reply_text`', async () => {
    // C'est la mesure « a répondu sans utiliser les choix proposés », d'autant plus parlante quand le bloc
    // n'offre aucun choix.
    const { ex, mesures } = executeur(graphe());
    await ex.advance('t1', '33600000001', 'msg1', null);
    expect(mesures[0]).toMatchObject({ nodeId: 'n1', kind: 'reply_text' });
    expect(mesures[0]).not.toHaveProperty('handle');
  });

  it('🔴 un clic sur un bouton NON CÂBLÉ se compte quand même', async () => {
    // Ce que le contact a fait ne depend pas de ce que le graphe en fait ensuite. Ne compter que les clics
    // routes masquerait exactement les boutons qu'on a oublie de brancher.
    const { ex, mesures } = executeur(graphe());
    await ex.advance('t1', '33600000001', 'msg1', 'Non');
    expect(mesures.find((m) => m.kind === 'reply_button')).toMatchObject({ nodeId: 'n1', handle: 'Non' });
  });

  it('un choix de CAROUSEL se distingue par son handle carte/bouton', async () => {
    const { ex, mesures } = executeur(graphe());
    await ex.advance('t1', '33600000001', 'msg1', 'card:1:btn:0');
    expect(mesures[0]).toMatchObject({ kind: 'reply_button', handle: 'card:1:btn:0' });
  });
});

describe('mesure des ENVOIS, sur leur issue réelle', () => {
  it('🔴 un envoi réussi compte `sent`, sur le bloc qui l’a émis', async () => {
    const { ex, mesures } = executeur(graphe());
    await ex.advance('t1', '33600000001', 'msg1', 'Oui');
    expect(mesures.find((m) => m.kind === 'sent')).toMatchObject({ nodeId: 'n2' });
  });

  it('🔴 un envoi REFUSÉ compte `failed`, pas `sent`', async () => {
    // Compter avant l'envoi gonflerait les « envoyés » de tout ce que Meta a refusé, et un tableau qui ment
    // dans ce sens est pire que pas de tableau : il fait chercher un problème de contenu là où il y a un refus.
    const { ex, mesures } = executeur(graphe(), { envoiRate: true });
    await ex.advance('t1', '33600000001', 'msg1', 'Oui');
    expect(mesures.find((m) => m.kind === 'failed')).toMatchObject({ nodeId: 'n2' });
    expect(mesures.find((m) => m.kind === 'sent')).toBeUndefined();
  });
});

describe('garde-fous', () => {
  it('🔴 câblage SANS la dépendance -> aucune mesure, et le parcours se déroule normalement', async () => {
    const { ex, mesures } = executeur(graphe(), { sansDep: true });
    await expect(ex.advance('t1', '33600000001', 'msg1', 'Oui')).resolves.not.toThrow();
    expect(mesures).toEqual([]);
  });

  it('🔴 une mesure qui ÉCHOUE n’interrompt pas le parcours', async () => {
    // Un tableau de bord incomplet est un désagrément ; un message qui ne part pas parce qu'un compteur a
    // trébuché est un incident. L'échec reste visible en console.
    const etats: Array<Record<string, unknown>> = [];
    const run = { id: 'r1', workflowId: 'wf1', tenantId: 't1', waId: '33600000001', currentNode: 'n1', lastMessageId: null };
    const envoyes: string[] = [];
    const ex = new WorkflowExecutor({
      runs: { findWaitingByWaId: async () => run, setState: async (_id: string, st: Record<string, unknown>) => { etats.push(st); } },
      getGraph: async () => graphe(),
      applyTag: async () => {}, setField: async () => {}, removeTag: async () => {}, clearField: async () => {},
      sendTemplate: async () => {}, sendFlow: async () => {}, escalateToHuman: async () => {},
      sendQuickMessage: async (_t: string, _w: string, body: string): Promise<void> => { envoyes.push(body); },
      recordNodeEvent: async (): Promise<void> => { throw new Error('base indisponible'); },
    } as never);

    await ex.advance('t1', '33600000001', 'msg1', 'Oui');
    expect(envoyes).toEqual(['Très bien']); // le message est bien parti malgré la panne de mesure
    expect(etats.length).toBeGreaterThan(0);
  });
});
