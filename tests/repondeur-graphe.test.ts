import { describe, it, expect, vi } from 'vitest';
import { jamaisDesabonne } from './consentement';
import { avecGardesDEtatInertes, depsInertes } from './executeur-inerte';
import { bancDuFil, ESPACE } from './banc-du-fil';
import { WorkflowExecutor, type WorkflowExecutorDeps } from '../src/workflow/executor';
import { creerLancements } from '../src/workflow/lancements';
import { entryNode } from '../src/workflow/engine';
import { parseGraph, type WorkflowGraph } from '../src/workflow/graph';
import type { RunState, WorkflowRunRow } from '../src/workflow/run-store.pg';
import type { AgentSession, AgentSessionStatus, AgentSessionStore } from '../src/agent/session-store';
import type { AgentTurnJob } from '../src/agent/turn-job';
import { creerEscaladeVersHumain } from '../src/agent/escalade';
import { BLOC_AGENT_REPONDEUR, grapheDuRepondeur } from '../src/repondeur/graphe';

/**
 * LE GRAPHE DU RÉPONDEUR ET SON PARCOURS (lot 5, A4), sur le VRAI exécuteur, les VRAIS lancements et le VRAI contrôle
 * du fil (`bancDuFil`). Le graphe est construit au démarrage et figé dans le parcours : la ligne du scénario système
 * est cachée par le magasin (`getGraph` rend `null`, comme `getById` en production), et le parcours ne doit jamais
 * en avoir besoin.
 */

const WA = '33611223344';
const AGENT = 'ag-1';
const SORTIES = [{ code: 'rdv_pris', label: 'Rendez-vous pris' }];

/** Les parcours en mémoire : un démarrage note son état et son graphe figé, `findWaitingByWaId` les relit. */
function runsEnMemoire() {
  const lignes: WorkflowRunRow[] = [];
  const crees: Array<{ state: RunState; fige: WorkflowGraph | null }> = [];
  const runs = avecGardesDEtatInertes({
    start: async (t: string, w: string, waId: string, _c: string | null, state: RunState, fige: WorkflowGraph | null) => {
      const id = `r${lignes.length + 1}`;
      lignes.push({ id, workflowId: w, tenantId: t, waId, currentNode: state.currentNode, status: state.status, lastMessageId: state.lastMessageId ?? null, grapheFige: fige });
      crees.push({ state, fige });
      return { id };
    },
    findWaitingByWaId: async (t: string, waId: string) => [...lignes].reverse().find((l) => l.tenantId === t && l.waId === waId && l.status === 'waiting') ?? null,
    setState: async (id: string, s: RunState) => {
      const l = lignes.find((x) => x.id === id);
      if (!l) return;
      l.currentNode = s.currentNode;
      l.status = s.status;
      if (s.lastMessageId !== undefined) l.lastMessageId = s.lastMessageId;
    },
    closeActiveByWaId: async () => [],
  });
  return { runs, lignes, crees };
}

/** Les sessions en mémoire : une vivante par parcours, close par `clore`. */
function sessionsEnMemoire() {
  const sessions: AgentSession[] = [];
  const store = {
    byRun: async (_t: string, runId: string) => sessions.find((s) => s.runId === runId && s.status === 'en_cours') ?? null,
    open: async (i: { tenantId: string; runId: string; agentId: string; nodeId: string; waId: string }) => {
      const s: AgentSession = { id: `s${sessions.length + 1}`, ...i, tours: 0, appelsOutils: 0, coutMicroEur: 0, status: 'en_cours', ouvertLe: '2026-10-05T10:00:00.000Z' };
      sessions.push(s);
      return s;
    },
    clore: async (_t: string, id: string, status: AgentSessionStatus) => {
      const s = sessions.find((x) => x.id === id);
      if (s) s.status = status;
    },
  } as unknown as AgentSessionStore;
  return { store, sessions };
}

/** Un espace dont l'agent IA est le répondeur (l'agent de Meta éteint, comme le CHECK l'impose). */
function banc() {
  const b = bancDuFil({ mbaEnabled: false, repondeurAgentId: AGENT, conversations: { [WA]: { owner: 'app_workflow' } } });
  const { runs, lignes, crees } = runsEnMemoire();
  const { store: agentSessions, sessions } = sessionsEnMemoire();
  const jobs: AgentTurnJob[] = [];
  const notees: string[] = [];
  const deps: WorkflowExecutorDeps = {
    ...depsInertes,
    estDesabonne: jamaisDesabonne,
    runs,
    // La ligne du scénario système est cachée par le magasin : le parcours ne doit jamais la relire.
    getGraph: async () => null,
    applyTag: async () => true,
    setField: async () => {},
    removeTag: async () => {},
    clearField: async () => {},
    sendTemplate: async () => {},
    sendQuickMessage: async () => {},
    sendFlow: async () => {},
    sendQuestion: async () => {},
    agentSessions,
    enqueueAgentTurn: async (j) => { jobs.push(j); },
    mayAct: b.fil.peutAgir,
    reclaimControl: b.fil.reprendrePourLApp,
    // Le câblage réel (`src/workflow/wiring.ts`) : la bascule gardée `only: ['app_workflow']`, drapeau relayé.
    escalateToHuman: async (t, w, _a, escalade) => { await b.fil.passerAUnHumain(t, w, { escalade, cause: 'automatique : Répondeur automatique' }); },
    noterSortieAgent: async (_t, _w, sortie) => { notees.push(sortie); },
  };
  const executor = new WorkflowExecutor(deps);
  const lancements = creerLancements({
    executor,
    scenarios: { getById: async () => { throw new Error('le répondeur ne lit jamais sa ligne de scénario'); } },
    contacts: { findIdByWaId: async () => 'c-1' },
  });
  const demarrer = (messageDeclencheur: string | null = 'wamid.1') => lancements.lancer({
    type: 'repondeur', tenantId: ESPACE, workflowId: 'w-sys', waId: WA,
    graphe: grapheDuRepondeur({ id: AGENT, sorties: SORTIES }), fenetreOuverte: true, messageDeclencheur,
  });
  return { b, executor, lancements, demarrer, lignes, crees, sessions, jobs, notees, agentSessions };
}

describe('grapheDuRepondeur : un bloc Agent IA, et ce qui mène à la fin', () => {
  it('un graphe valide, qui entre par le bloc de l’agent désigné', () => {
    const g = grapheDuRepondeur({ id: AGENT, sorties: SORTIES });
    expect(parseGraph(g), 'relu par `parseGraph` à chaque reprise : il doit en sortir intact').toEqual(g);
    expect(entryNode(g)).toBe(BLOC_AGENT_REPONDEUR);
    expect(g.nodes.find((n) => n.id === BLOC_AGENT_REPONDEUR)?.data.agentId).toBe(AGENT);
  });

  it('🔴 chaque règle d’arrêt, `humain` et `timeout` ont une arête ; `echec`, `plafond` et `sans_source` n’en ont AUCUNE', () => {
    const handles = grapheDuRepondeur({ id: AGENT, sorties: SORTIES }).edges.map((e) => e.sourceHandle).sort();
    expect(handles).toEqual(['sortie:humain', 'sortie:rdv_pris', 'timeout']);
  });

  it('une règle d’arrêt que l’agent déclare lui-même sous un code réservé est la sienne ; un doublon ne fait qu’une arête', () => {
    const g = grapheDuRepondeur({ id: AGENT, sorties: [{ code: 'echec', label: 'x' }, { code: 'humain', label: 'y' }] });
    expect(g.edges.map((e) => e.sourceHandle).sort()).toEqual(['sortie:echec', 'sortie:humain', 'timeout']);
    expect(new Set(g.edges.map((e) => e.id)).size).toBe(g.edges.length);
  });
});

describe('le parcours du répondeur, sur le vrai exécuteur', () => {
  it('🔴 démarre : graphe FIGÉ dans le parcours, message déclencheur déjà reçu, une session, UN premier tour', async () => {
    const m = banc();
    expect(await m.demarrer()).toBe(true);
    expect(m.crees).toHaveLength(1);
    expect(m.crees[0]!.fige).toEqual(grapheDuRepondeur({ id: AGENT, sorties: SORTIES }));
    expect(m.crees[0]!.state).toMatchObject({ currentNode: BLOC_AGENT_REPONDEUR, status: 'waiting', lastMessageId: 'wamid.1' });
    expect(m.sessions).toHaveLength(1);
    expect(m.jobs.map((j) => j.raison)).toEqual(['demarrage']);
  });

  it('🔴 le même message, redélivré par Meta, n’enfile PAS un second tour ; le message suivant, si', async () => {
    const m = banc();
    await m.demarrer();
    await m.executor.advance(ESPACE, WA, 'wamid.1', null);
    expect(m.jobs.map((j) => j.raison), 'la redélivrance est reconnue (`lastMessageId`)').toEqual(['demarrage']);
    await m.executor.advance(ESPACE, WA, 'wamid.2', null);
    expect(m.jobs.map((j) => j.raison)).toEqual(['demarrage', 'message']);
  });

  it('🔴 une règle d’arrêt : le parcours sort par le graphe FIGÉ (sa ligne est illisible), finit, et la frise la note', async () => {
    const m = banc();
    await m.demarrer();
    expect(await m.executor.sortirDuBlocAgent(ESPACE, WA, 's1', 'rdv_pris')).toBe(true);
    expect(m.notees).toEqual(['rdv_pris']);
    expect(m.lignes[0]).toMatchObject({ status: 'done', currentNode: null });
    // Fin silencieuse : le fil reste aux robots, le prochain message relancera l'agent.
    expect(m.b.etat(WA)?.owner).toBe('app_workflow');
  });

  it('🔴 `echec` (non câblée) : la conversation passe à l’équipe, et la frise note quand même la sortie', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = banc();
    await m.demarrer();
    await m.executor.sortirDuBlocAgent(ESPACE, WA, 's1', 'echec');
    expect(m.notees).toEqual(['echec']);
    expect(m.b.etat(WA)?.owner).toBe('app_human');
    vi.restoreAllMocks();
  });

  it('`timeout` (inactivité) : la session close, le parcours finit par sa fin silencieuse, le fil reste aux robots', async () => {
    const m = banc();
    await m.demarrer();
    const run = m.lignes[0]!;
    expect(await m.executor.resume({ ...run, status: 'waiting' })).toBe(true);
    expect(m.sessions[0]!.status).toBe('inactivite');
    expect(m.lignes[0]).toMatchObject({ status: 'done' });
    expect(m.b.etat(WA)?.owner).toBe('app_workflow');
  });

  /**
   * 🔴 LE PIÈGE DE L'ESCALADE (exploration du 2026-10-04). Si `humain` n'était pas câblée, le moteur passerait la main
   * à l'équipe PENDANT la sortie (`boutonSansSuite`) ; la bascule de l'escalade, gardée `only: ['app_workflow']`,
   * rendrait alors `false`, le tour croirait qu'un opérateur a pris la main, et la dernière phrase de l'agent (« un
   * conseiller vous répond ») serait jetée. Câblée, l'escalade trouve le fil aux robots et le passe elle-même.
   */
  it('🔴 l’escalade depuis le répondeur : la bascule est À ELLE (la dernière phrase part), le fil à l’équipe, escalade marquée', async () => {
    const m = banc();
    await m.demarrer();
    const escalader = creerEscaladeVersHumain({
      sessions: m.agentSessions,
      parcours: m.executor,
      escalateToHuman: (t, w) => m.b.fil.passerAUnHumain(t, w, { escalade: true, cause: 'automatique : agent IA Léa' }),
    });
    expect(await escalader({ tenantId: ESPACE, waId: WA, runId: 'r1', sessionId: 's1', agentId: AGENT })).toBe(true);
    expect(m.b.etat(WA)?.owner).toBe('app_human');
    expect(m.b.etat(WA)?.escaladeeLe).not.toBeNull();
    expect(m.notees).toEqual(['humain']);
  });
});
