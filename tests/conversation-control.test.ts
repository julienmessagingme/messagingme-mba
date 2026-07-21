import { describe, it, expect } from 'vitest';
import { WorkflowExecutor } from '../src/workflow/executor';
import type { WorkflowExecutorDeps } from '../src/workflow/executor';
import type { WorkflowGraph } from '../src/workflow/graph';
import type { RunState, WorkflowRunRow } from '../src/workflow/run-store.pg';
import { runCampaign } from '../src/campaign/engine';
import type { EngineDeps } from '../src/campaign/engine';
import type { Campaign, Recipient } from '../src/campaign/types';

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

// --- Campagnes ---

const CAMPAIGN: Campaign = {
  id: 'camp1', tenantId: 't1', phoneNumberId: 'pn1', name: 'Promo', category: 'utility',
  templateName: 'promo', templateLanguage: 'fr', status: 'draft', ratePerMinute: null,
  paramMapping: [], workflowId: null, startNodeId: null,
} as Campaign;

function recipients(): Recipient[] {
  return [
    { id: 'r1', campaignId: 'camp1', contactId: 'c1', toE164: '+33611111111', resolvedParams: [], status: 'pending' } as unknown as Recipient,
    { id: 'r2', campaignId: 'camp1', contactId: 'c2', toE164: '+33622222222', resolvedParams: [], status: 'pending' } as unknown as Recipient,
  ];
}

function engineDeps(over: Partial<EngineDeps> = {}): { deps: EngineDeps; claimed: string[]; sent: string[]; marked: string[] } {
  const claimed: string[] = [];
  const sent: string[] = [];
  const marked: string[] = [];
  const deps: EngineDeps = {
    sender: {
      sendMarketing: async () => ({ messageId: 'm' }),
      sendTemplate: async (to) => { sent.push(to); return { messageId: `m-${to}` }; },
    },
    recipients: {
      listPending: async () => recipients(),
      claim: async (id) => { claimed.push(id); return true; },
      markResult: async () => {},
    },
    campaigns: { setStatus: async () => {} },
    frequency: { lastSentAt: async () => null, record: async () => {} },
    quality: { getRating: async () => 'GREEN' },
    markControl: async (_t, waId) => { marked.push(waId); },
    ...over,
  };
  return { deps, claimed, sent, marked };
}

describe('campagne face à un fil détenu', () => {
  it('saute le destinataire SANS le claimer (il reste pending, réévalué au prochain run)', async () => {
    // Le saut doit précéder le claim : claimer puis renoncer consommerait le destinataire, qui resterait
    // bloqué en `sending` et ne serait jamais renvoyé.
    const { deps, claimed, sent } = engineDeps({ mayAct: async (_t, waId) => waId !== '33611111111' });
    const report = await runCampaign(CAMPAIGN, deps);
    expect(sent).toEqual(['+33622222222']);
    expect(claimed).toEqual(['r2']);
    expect(report.skipped).toBe(1);
    expect(report.sent).toBe(1);
  });

  it('pose le détenteur après un envoi réussi, pour les DEUX destinataires', async () => {
    const { deps, marked } = engineDeps();
    await runCampaign(CAMPAIGN, deps);
    // Numéro en chiffres nus : la même dérivation que le webhook et le store, sinon on créerait une
    // seconde conversation pour le même contact.
    expect(marked).toEqual(['33611111111', '33622222222']);
  });

  it('un échec de pose ne relabellise pas un message livré', async () => {
    const { deps, sent } = engineDeps({ markControl: async () => { throw new Error('base indisponible'); } });
    const report = await runCampaign(CAMPAIGN, deps);
    expect(sent).toHaveLength(2);
    expect(report.sent).toBe(2);
    expect(report.failed).toBe(0);
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
      listStaleControl: async (olderThan) => { lu.push(olderThan); return stale; },
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

  it('lit avec le délai le plus COURT, sinon les fils humains juste échus seraient ratés', async () => {
    const { deps, lu } = sweepDeps([], { app_human: 2 * H, mba: 24 * H });
    await runControlSweep(deps);
    expect(lu[0]!.getTime()).toBe(T0 - 2 * H);
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

  it('tous les délais à 0 -> aucune lecture, aucune écriture', async () => {
    const { deps, lu, rendues } = sweepDeps([{ tenantId: 't1', waId: 'x', owner: 'app_human', changedAt: null }], { app_human: 0, mba: 0 });
    expect(await runControlSweep(deps)).toBe(0);
    expect(lu).toEqual([]);
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
      listStaleControl: async () => [{ tenantId: 't1', waId: 'x', owner: 'app_human', changedAt: ago(5 * H) }],
      setControlOwner: async () => false,
      timeouts: { app_human: 2 * H },
      now: () => T0,
    };
    expect(await runControlSweep(deps)).toBe(0);
  });
});
