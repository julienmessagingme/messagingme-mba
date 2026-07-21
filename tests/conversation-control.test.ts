import { describe, it, expect } from 'vitest';
import { WorkflowExecutor } from '../src/workflow/executor';
import type { WorkflowExecutorDeps } from '../src/workflow/executor';
import type { WorkflowGraph } from '../src/workflow/graph';
import type { RunState, WorkflowRunRow } from '../src/workflow/run-store.pg';

/**
 * L'état de contrôle d'une conversation : qui détient le fil, et donc qui a le droit d'écrire au client.
 *
 * Ce que ces tests protègent, et qui n'est visible nulle part à la lecture :
 *
 *  1. Un opérateur engagé GÈLE le scénario. C'est la raison d'être du bloc : aujourd'hui, sans ce garde,
 *     un humain qui répond dans l'inbox et un parcours qui continue écrivent au client en parallèle.
 *  2. Le gel vaut pour l'AVANCE (le contact répond) ET pour le DÉMARRAGE (une campagne lance un parcours).
 *     Le second chemin est passé inaperçu dans une première version du plan : `start` et `startFromNode`
 *     passent par `runFrom`, qui envoie sans consulter personne.
 *  3. Le gel est TRANSITOIRE. Le run reste en attente, il repart tout seul quand le contrôle revient. Le
 *     clore ferait qu'un simple aller-retour avec un opérateur tuerait définitivement le parcours.
 *  4. Le blocage vaut aussi pour `mba` : quand l'agent de Meta tient le fil, notre scénario se tait.
 */

const GRAPH: WorkflowGraph = {
  nodes: [
    { id: 'n1', type: 'template', position: { x: 0, y: 0 }, data: { templateName: 'bonjour', language: 'fr' } },
    { id: 'n2', type: 'template', position: { x: 0, y: 1 }, data: { templateName: 'suite', language: 'fr' } },
  ],
  edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
};

interface Trace { sent: string[]; states: RunState[] }

/** Executor avec un run EN ATTENTE sur n1, et un `mayAct` pilotable. */
function executor(mayAct: boolean | undefined, trace: Trace) {
  const run: WorkflowRunRow = {
    id: 'r1', tenantId: 't1', workflowId: 'w1', waId: '33611', contactId: 'c1',
    currentNode: 'n1', status: 'waiting', lastMessageId: null,
  } as WorkflowRunRow;
  const deps: WorkflowExecutorDeps = {
    runs: {
      start: async () => ({ id: 'r1' }),
      findWaitingByWaId: async () => run,
      setState: async (_id, state) => { trace.states.push(state); },
    },
    getGraph: async () => GRAPH,
    applyTag: async () => {},
    setField: async () => {},
    sendTemplate: async (_t, _w, name) => { trace.sent.push(name); },
    sendQuickMessage: async () => {},
    sendFlow: async () => {},
    ...(mayAct === undefined ? {} : { mayAct: async () => mayAct }),
  };
  return new WorkflowExecutor(deps);
}

describe('gel du scénario quand le fil ne nous appartient pas', () => {
  it('fil libre -> le scénario avance et envoie', async () => {
    const trace: Trace = { sent: [], states: [] };
    await executor(true, trace).advance('t1', '33611', 'm1');
    expect(trace.sent).toEqual(['suite']);
  });

  it('fil détenu -> AUCUN envoi, et le run reste en attente (gel transitoire)', async () => {
    const trace: Trace = { sent: [], states: [] };
    await executor(false, trace).advance('t1', '33611', 'm1');
    expect(trace.sent).toEqual([]);
    // Le run n'est ni avancé ni clos : il repartira quand le contrôle reviendra. C'est ce qui distingue
    // un gel d'un abandon.
    expect(trace.states).toEqual([]);
  });

  it('DÉMARRAGE bloqué aussi : une campagne ne lance pas un parcours dans un fil détenu', async () => {
    // Le trou de la première version du plan : le garde n'était que dans `advance`, alors que `start` et
    // `startFromNode` envoient par `runFrom` sans passer par là.
    const trace: Trace = { sent: [], states: [] };
    await executor(false, trace).start('t1', 'w1', GRAPH, { waId: '33611', contactId: 'c1' });
    expect(trace.sent).toEqual([]);
  });

  it('démarrage à un bloc précis bloqué aussi (cible node de /v1/sends)', async () => {
    const trace: Trace = { sent: [], states: [] };
    await executor(false, trace).startFromNode('t1', 'w1', GRAPH, { waId: '33611', contactId: 'c1' }, 'n2');
    expect(trace.sent).toEqual([]);
  });

  it('dep ABSENT -> rien n’est bloqué (rétro-compatibilité des suites existantes)', async () => {
    const trace: Trace = { sent: [], states: [] };
    await executor(undefined, trace).advance('t1', '33611', 'm1');
    expect(trace.sent).toEqual(['suite']);
  });
});

// --- Garde-fou d'inactivité ---

import { runControlSweep } from '../src/inbox/control-sweep';
import type { ControlSweepDeps } from '../src/inbox/control-sweep';

const T0 = new Date('2026-07-21T12:00:00.000Z').getTime();
const ago = (ms: number) => new Date(T0 - ms);

function sweepDeps(
  stale: Array<{ tenantId: string; waId: string; owner: 'app_workflow' | 'app_human' | 'mba'; changedAt: Date | null }>,
  timeouts: Partial<Record<'app_workflow' | 'app_human' | 'mba', number>>,
): { deps: ControlSweepDeps; rendues: string[]; lu: Date[] } {
  const rendues: string[] = [];
  const lu: Date[] = [];
  return {
    rendues,
    lu,
    deps: {
      listHeldControl: async () => { lu.push(new Date(T0)); return stale; },
      setControlOwner: async (_t, waId) => { rendues.push(waId); return true; },
      timeouts,
      now: () => T0,
    },
  };
}

const H = 60 * 60 * 1000;

describe('garde-fou d’inactivité', () => {
  it('rend la main sur un fil humain inactif, PAS sur un fil humain actif', async () => {
    const { deps, rendues } = sweepDeps(
      [
        { tenantId: 't1', waId: 'vieux', owner: 'app_human', changedAt: ago(3 * H) },
        { tenantId: 't1', waId: 'recent', owner: 'app_human', changedAt: ago(10 * 60 * 1000) },
      ],
      { app_human: 2 * H, mba: 24 * H },
    );
    expect(await runControlSweep(deps)).toBe(1);
    expect(rendues).toEqual(['vieux']);
  });

  it('applique un délai PROPRE à chaque détenteur', async () => {
    // La requête ramène large (délai le plus court), le refiltrage en mémoire doit protéger `mba`, qui a
    // un délai bien plus long : 3 h d'inactivité libèrent un humain, pas MBA.
    const { deps, rendues } = sweepDeps(
      [
        { tenantId: 't1', waId: 'humain', owner: 'app_human', changedAt: ago(3 * H) },
        { tenantId: 't1', waId: 'agent', owner: 'mba', changedAt: ago(3 * H) },
      ],
      { app_human: 2 * H, mba: 24 * H },
    );
    expect(await runControlSweep(deps)).toBe(1);
    expect(rendues).toEqual(['humain']);
  });

  it('un délai à 0 désactive la reprise pour CET état seulement', async () => {
    const { deps, rendues } = sweepDeps(
      [
        { tenantId: 't1', waId: 'humain', owner: 'app_human', changedAt: ago(100 * H) },
        { tenantId: 't1', waId: 'agent', owner: 'mba', changedAt: ago(100 * H) },
      ],
      { app_human: 0, mba: 24 * H },
    );
    expect(await runControlSweep(deps)).toBe(1);
    expect(rendues).toEqual(['agent']);
  });

  it('tous les délais à 0 -> aucune conversation rendue', async () => {
    const { deps, rendues } = sweepDeps([{ tenantId: 't1', waId: 'x', owner: 'app_human', changedAt: null }], { app_human: 0, mba: 0 });
    expect(await runControlSweep(deps)).toBe(0);
    expect(rendues).toEqual([]);
  });

  it('une bascule sans date (antérieure à la migration) est éligible, jamais bloquée à vie', async () => {
    const { deps, rendues } = sweepDeps([{ tenantId: 't1', waId: 'legacy', owner: 'app_human', changedAt: null }], { app_human: 2 * H });
    expect(await runControlSweep(deps)).toBe(1);
    expect(rendues).toEqual(['legacy']);
  });

  it('ne compte que les bascules réellement effectuées (garde `only` refusée -> non comptée)', async () => {
    // Un opérateur qui reprend la main entre la lecture et l'écriture : le store refuse, et le compteur
    // ne doit pas prétendre avoir rendu la conversation.
    const deps: ControlSweepDeps = {
      listHeldControl: async () => [{ tenantId: 't1', waId: 'x', owner: 'app_human', changedAt: ago(5 * H) }],
      setControlOwner: async () => false,
      timeouts: { app_human: 2 * H },
      now: () => T0,
    };
    expect(await runControlSweep(deps)).toBe(0);
  });
});

describe('durée du gel réglable PAR CLIENT', () => {
  /** Sweep avec un réglage client, sur un lot de conversations de plusieurs clients. */
  function withReglages(
    stale: Array<{ tenantId: string; waId: string; owner: 'app_workflow' | 'app_human' | 'mba'; changedAt: Date | null }>,
    reglages: Record<string, number>,
    defauts: Partial<Record<'app_workflow' | 'app_human' | 'mba', number>> = { app_human: 2 * H, mba: 24 * H },
  ): { deps: ControlSweepDeps; rendues: string[]; demandes: string[][] } {
    const rendues: string[] = [];
    const demandes: string[][] = [];
    return {
      rendues,
      demandes,
      deps: {
        listHeldControl: async () => stale,
        setControlOwner: async (_t, waId) => { rendues.push(waId); return true; },
        handbackMsByTenant: async (ids) => { demandes.push([...ids]); return new Map(Object.entries(reglages)); },
        timeouts: defauts,
        now: () => T0,
      },
    };
  }

  it('le réglage du client PRIME sur le défaut du serveur, dans les deux sens', async () => {
    // t1 veut 30 min (plus court que le défaut 2 h) : sa conversation d'1 h est rendue.
    // t2 veut 8 h (plus long) : la sienne, également d'1 h, ne l'est pas.
    const { deps, rendues } = withReglages(
      [
        { tenantId: 't1', waId: 'presse', owner: 'app_human', changedAt: ago(1 * H) },
        { tenantId: 't2', waId: 'patient', owner: 'app_human', changedAt: ago(1 * H) },
      ],
      { t1: 30 * 60 * 1000, t2: 8 * H },
    );
    expect(await runControlSweep(deps)).toBe(1);
    expect(rendues).toEqual(['presse']);
  });

  it('un client qui n’a rien réglé garde le défaut du serveur', async () => {
    const { deps, rendues } = withReglages(
      [
        { tenantId: 'sansReglage', waId: 'vieux', owner: 'app_human', changedAt: ago(3 * H) },
        { tenantId: 'sansReglage', waId: 'recent', owner: 'app_human', changedAt: ago(1 * H) },
      ],
      {},
    );
    expect(await runControlSweep(deps)).toBe(1);
    expect(rendues).toEqual(['vieux']);
  });

  it('un réglage à 0 = la conversation reste à l’humain, même très ancienne', async () => {
    // Choix légitime : certains veulent que l'opérateur garde la main jusqu'à ce qu'il la rende lui-même.
    const { deps, rendues } = withReglages(
      [{ tenantId: 't1', waId: 'jamais', owner: 'app_human', changedAt: ago(500 * H) }],
      { t1: 0 },
    );
    expect(await runControlSweep(deps)).toBe(0);
    expect(rendues).toEqual([]);
  });

  it('le réglage client ne s’applique QU’au gel humain, pas au garde-fou MBA', async () => {
    // Le délai MBA est un garde-fou technique, pas un arbitrage métier : un client ne doit pas pouvoir
    // s'en servir pour préempter l'agent de Meta au bout de 30 minutes.
    const { deps, rendues } = withReglages(
      [{ tenantId: 't1', waId: 'agent', owner: 'mba', changedAt: ago(2 * H) }],
      { t1: 30 * 60 * 1000 },
    );
    expect(await runControlSweep(deps)).toBe(0);
    expect(rendues).toEqual([]);
  });

  it('ne demande les réglages qu’UNE fois par client, pas une fois par conversation', async () => {
    const { deps, demandes } = withReglages(
      [
        { tenantId: 't1', waId: 'a', owner: 'app_human', changedAt: ago(3 * H) },
        { tenantId: 't1', waId: 'b', owner: 'app_human', changedAt: ago(3 * H) },
        { tenantId: 't2', waId: 'c', owner: 'app_human', changedAt: ago(3 * H) },
      ],
      {},
    );
    await runControlSweep(deps);
    expect(demandes).toEqual([['t1', 't2']]);
  });

  it('aucune conversation détenue -> aucune requête de réglages', async () => {
    const { deps, demandes } = withReglages([], {});
    expect(await runControlSweep(deps)).toBe(0);
    expect(demandes).toEqual([]);
  });
});
