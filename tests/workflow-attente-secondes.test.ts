import { jamaisDesabonne } from './consentement';
import { avecGardesDEtatInertes, depsInertes } from './executeur-inerte';
import { describe, it, expect } from 'vitest';
import { WorkflowExecutor } from '../src/workflow/executor';
import type { WorkflowExecutorDeps } from '../src/workflow/executor';
import type { WorkflowGraph, WorkflowNodeType } from '../src/workflow/graph';
import type { WorkflowRunRow, RunState, RunChannel } from '../src/workflow/run-store.pg';

/**
 * La pause en secondes, côté exécuteur (spec `2026-10-16-attente-en-secondes-design.md`). Ce que ce fichier tient :
 *  - le réveil court n'est armé qu'APRÈS une écriture `sleeping` réussie, sur les trois chemins (démarrage, avance,
 *    reprise) : armé sur une écriture refusée, il réveillerait un parcours clos ;
 *  - une pause d'une minute ou plus reste au balayage ;
 *  - « en train d'écrire… » part sur le message entrant WhatsApp (`wamid.`) et seulement lui : ni identifiant
 *    synthétique d'agent, ni RCS, ni sans message, et un refus de Meta n'arrête rien.
 */
const n = (id: string, type: WorkflowNodeType, data: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, data });
const e = (source: string, target: string, sourceHandle?: string) =>
  ({ id: `${source}-${target}`, source, target, ...(sourceHandle ? { sourceHandle } : {}) });

const NOW = 1_000_000;

/** message, Attente 4 s, message, Attente 3 s, message ; et une Question en tête pour le chemin de l'avance. */
const GRAPHE: WorkflowGraph = {
  nodes: [
    n('m1', 'quick_message', { body: 'Bonjour' }),
    n('w', 'wait', { delay: 4, unit: 'seconds' }),
    n('m2', 'quick_message', { body: 'Suite' }),
    n('w2', 'wait', { delay: 3, unit: 'seconds' }),
    n('m3', 'quick_message', { body: 'Fin' }),
    n('q', 'question', { body: 'Prêt ?', rows: [{ title: 'Oui' }] }),
  ],
  edges: [e('m1', 'w'), e('w', 'm2'), e('m2', 'w2'), e('w2', 'm3'), e('q', 'm1', 'row:0')],
};
/** Le même sans la Question : l'entrée est alors le premier message. */
const DEPART: WorkflowGraph = { nodes: GRAPHE.nodes.filter((x) => x.id !== 'q'), edges: GRAPHE.edges.filter((x) => x.source !== 'q') };

interface Capture {
  envois: string[];
  armes: Array<{ tenantId: string; runId: string; echeance: number }>;
  saisies: string[];
  etats: RunState[];
}

function monter(graph: WorkflowGraph, run: WorkflowRunRow | null, cap: Capture, over: Partial<WorkflowExecutorDeps> = {}, runsOver: Record<string, unknown> = {}) {
  const deps: WorkflowExecutorDeps = {
    ...depsInertes,
    estDesabonne: jamaisDesabonne,
    runs: avecGardesDEtatInertes({
      start: async (_t: string, _w: string, _wa: string, _c: string | null, state: RunState) => { cap.etats.push(state); return { id: 'r1' }; },
      findWaitingByWaId: async () => run,
      setState: async (_id: string, state: RunState) => { cap.etats.push(state); },
      closeActiveByWaId: async () => [],
      ...runsOver,
    }),
    getGraph: async () => graph,
    applyTag: async () => {},
    setField: async () => {},
    removeTag: async () => {},
    clearField: async () => {},
    sendTemplate: async () => {},
    sendQuickMessage: async (_t, _w, body) => { cap.envois.push(body); },
    sendFlow: async () => {},
    sendQuestion: async () => {},
    isWindowOpen: async () => true,
    reveilCourt: { armer: (tenantId, runId, resumeAt) => { cap.armes.push({ tenantId, runId, echeance: resumeAt.getTime() }); } },
    signalerSaisie: async (_t, messageId) => { cap.saisies.push(messageId); },
    now: () => NOW,
    ...over,
  };
  return new WorkflowExecutor(deps);
}

const capture = (): Capture => ({ envois: [], armes: [], saisies: [], etats: [] });
const dormant = (currentNode: string, lastMessageId: string | null, channel: RunChannel = 'whatsapp') =>
  ({ id: 'r1', workflowId: 'wf1', tenantId: 't1', waId: '33600', contactId: 'c1', currentNode, status: 'sleeping' as const, lastMessageId, channel, grapheFige: null });

describe('pause en secondes : le démarrage', () => {
  it('le parcours né endormi arme le réveil court à l’échéance exacte, et signale la saisie sur le message déclencheur', async () => {
    const cap = capture();
    await monter(DEPART, null, cap).demarrer('automatisme_ordinaire', 't1', 'wf1', DEPART, { waId: '33600', contactId: 'c1' },
      { depuis: 'entree', fenetreOuverte: true, messageDeclencheur: 'wamid.D' });
    expect(cap.envois).toEqual(['Bonjour']);
    expect(cap.armes).toEqual([{ tenantId: 't1', runId: 'r1', echeance: NOW + 4000 }]);
    expect(cap.saisies).toEqual(['wamid.D']);
  });

  it('sans message entrant (campagne, tag), la pause est armée mais silencieuse', async () => {
    const cap = capture();
    await monter(DEPART, null, cap).demarrer('automatisme_ordinaire', 't1', 'wf1', DEPART, { waId: '33600', contactId: 'c1' },
      { depuis: 'entree', fenetreOuverte: true });
    expect(cap.armes).toHaveLength(1);
    expect(cap.saisies).toEqual([]);
  });

  it('un identifiant qui n’est pas un message WhatsApp ne part jamais chez Meta', async () => {
    const cap = capture();
    await monter(DEPART, null, cap).demarrer('automatisme_ordinaire', 't1', 'wf1', DEPART, { waId: '33600', contactId: 'c1' },
      { depuis: 'entree', fenetreOuverte: true, messageDeclencheur: 'agent:s1:fin' });
    expect(cap.armes).toHaveLength(1);
    expect(cap.saisies).toEqual([]);
  });

  it('une pause d’une minute reste au balayage : ni réveil court, ni saisie', async () => {
    const g: WorkflowGraph = { ...DEPART, nodes: DEPART.nodes.map((x) => (x.id === 'w' ? n('w', 'wait', { delay: 1, unit: 'minutes' }) : x)) };
    const cap = capture();
    await monter(g, null, cap).demarrer('automatisme_ordinaire', 't1', 'wf1', g, { waId: '33600', contactId: 'c1' },
      { depuis: 'entree', fenetreOuverte: true, messageDeclencheur: 'wamid.D' });
    expect(cap.etats.at(-1)?.status).toBe('sleeping');
    expect(cap.armes).toEqual([]);
    expect(cap.saisies).toEqual([]);
  });

  it('une pause courte qui n’est pas en secondes (0,5 minute) est armée, mais ne marque rien comme lu', async () => {
    // Décision de Julien (2026-10-17) : l'indicateur, donc les coches bleues, seulement à l'entrée d'une pause EN SECONDES.
    const g: WorkflowGraph = { ...DEPART, nodes: DEPART.nodes.map((x) => (x.id === 'w' ? n('w', 'wait', { delay: 0.5, unit: 'minutes' }) : x)) };
    const cap = capture();
    await monter(g, null, cap).demarrer('automatisme_ordinaire', 't1', 'wf1', g, { waId: '33600', contactId: 'c1' },
      { depuis: 'entree', fenetreOuverte: true, messageDeclencheur: 'wamid.D' });
    expect(cap.armes).toEqual([{ tenantId: 't1', runId: 'r1', echeance: NOW + 30_000 }]);
    expect(cap.saisies).toEqual([]);
  });

  it('le réveil est armé AVANT l’appel à Meta : sa latence ne rallonge pas la pause', async () => {
    const ordre: string[] = [];
    const cap = capture();
    await monter(DEPART, null, cap, {
      reveilCourt: { armer: () => { ordre.push('armer'); } },
      signalerSaisie: async () => { ordre.push('saisie'); },
    }).demarrer('automatisme_ordinaire', 't1', 'wf1', DEPART, { waId: '33600', contactId: 'c1' },
      { depuis: 'entree', fenetreOuverte: true, messageDeclencheur: 'wamid.D' });
    expect(ordre).toEqual(['armer', 'saisie']);
  });

  it('🔴 l’appel à Meta n’est pas attendu : un Meta lent ne retient pas le traitement du message entrant', async () => {
    // La file des messages entrants n'a que trois places pour tous les espaces : attendre l'indicateur y retenait une
    // place pendant toute la latence de Meta, relances comprises.
    const cap = capture();
    const demarrage = monter(DEPART, null, cap, { signalerSaisie: () => new Promise<void>(() => {}) })
      .demarrer('automatisme_ordinaire', 't1', 'wf1', DEPART, { waId: '33600', contactId: 'c1' },
        { depuis: 'entree', fenetreOuverte: true, messageDeclencheur: 'wamid.D' });
    const issue = await Promise.race([demarrage.then(() => 'fini'), new Promise((r) => setTimeout(() => r('retenu'), 500))]);
    expect(issue).toBe('fini');
    expect(cap.armes).toHaveLength(1);
  });

  it('un refus de Meta sur la saisie n’arrête pas le parcours : le réveil est armé quand même', async () => {
    const cap = capture();
    await monter(DEPART, null, cap, { signalerSaisie: async () => { throw new Error('Meta 400'); } })
      .demarrer('automatisme_ordinaire', 't1', 'wf1', DEPART, { waId: '33600', contactId: 'c1' },
        { depuis: 'entree', fenetreOuverte: true, messageDeclencheur: 'wamid.D' });
    expect(cap.etats.at(-1)?.status).toBe('sleeping');
    expect(cap.armes).toHaveLength(1);
  });
});

describe('pause en secondes : l’avance sur réponse du contact', () => {
  const enAttente = (): WorkflowRunRow => ({
    id: 'r1', workflowId: 'wf1', tenantId: 't1', waId: '33600', contactId: 'c1',
    currentNode: 'q', status: 'waiting', lastMessageId: null, channel: 'whatsapp', grapheFige: null,
  });

  it('la réponse mène à une pause : armée, avec la saisie sur la réponse', async () => {
    const cap = capture();
    await monter(GRAPHE, enAttente(), cap).advance('t1', '33600', 'wamid.A', 'row:0');
    expect(cap.envois).toEqual(['Bonjour']);
    expect(cap.armes).toEqual([{ tenantId: 't1', runId: 'r1', echeance: NOW + 4000 }]);
    expect(cap.saisies).toEqual(['wamid.A']);
  });

  it('🔴 l’écriture perdue (le parcours a bougé pendant les envois) n’arme rien', async () => {
    const cap = capture();
    await monter(GRAPHE, enAttente(), cap, {}, { setStateSiEncoreSur: async () => false }).advance('t1', '33600', 'wamid.A', 'row:0');
    expect(cap.armes).toEqual([]);
    expect(cap.saisies).toEqual([]);
  });

  it('un message du contact PENDANT la pause n’avance pas le parcours (comportement de toute pause)', async () => {
    const cap = capture();
    // Le parcours dort : `findWaitingByWaId` ne voit que `waiting`, donc le magasin ne le rend pas.
    await monter(GRAPHE, null, cap).advance('t1', '33600', 'wamid.ok', null);
    expect(cap.envois).toEqual([]);
    expect(cap.etats).toEqual([]);
    expect(cap.armes).toEqual([]);
  });
});

describe('pause en secondes : la reprise', () => {
  it('la reprise qui se rendort sur une seconde pause ré-arme, avec la saisie sur le dernier message du contact', async () => {
    const cap = capture();
    const repris = await monter(GRAPHE, null, cap).resume(dormant('w', 'wamid.R'));
    expect(repris).toBe(true);
    expect(cap.envois).toEqual(['Suite']);
    expect(cap.armes).toEqual([{ tenantId: 't1', runId: 'r1', echeance: NOW + 3000 }]);
    expect(cap.saisies).toEqual(['wamid.R']);
  });

  it('🔴 un parcours clos pendant la reprise n’arme rien', async () => {
    const cap = capture();
    await monter(GRAPHE, null, cap, {}, { setStateSiVivant: async () => false }).resume(dormant('w', 'wamid.R'));
    expect(cap.armes).toEqual([]);
    expect(cap.saisies).toEqual([]);
  });

  it('sur un parcours RCS, la pause est armée sans saisie (l’indicateur est propre à WhatsApp)', async () => {
    const g: WorkflowGraph = {
      nodes: [n('w', 'wait', { delay: 4, unit: 'seconds' }), n('w2', 'wait', { delay: 3, unit: 'seconds' }), n('m3', 'tag', { tag: 'fin' })],
      edges: [e('w', 'w2'), e('w2', 'm3')],
    };
    const cap = capture();
    await monter(g, null, cap).resume(dormant('w', 'wamid.R', 'rcs'));
    expect(cap.armes).toEqual([{ tenantId: 't1', runId: 'r1', echeance: NOW + 3000 }]);
    expect(cap.saisies).toEqual([]);
  });
});
