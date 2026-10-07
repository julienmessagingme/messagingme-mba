import { describe, it, expect } from 'vitest';
import { jamaisDesabonne } from './consentement';
import { avecGardesDEtatInertes, depsInertes } from './executeur-inerte';
import { bancDuFil, ESPACE } from './banc-du-fil';
import { CONTACT_DESABONNE, SCENARIO_INCONNU, creerGestesEnvoiAgent, type DepsGestesEnvoiAgent } from '../src/agent/gestes-envoi';
import { WorkflowExecutor, type WorkflowExecutorDeps } from '../src/workflow/executor';
import { creerLancements } from '../src/workflow/lancements';
import type { WorkflowGraph, WorkflowNodeType } from '../src/workflow/graph';
import type { WorkflowRunRow } from '../src/workflow/run-store.pg';
import type { AgentSessionStore } from '../src/agent/session-store';
import { grapheDuRepondeur } from '../src/repondeur/graphe';
import { offresToutOuvert } from './gardes';

/**
 * LES DEUX OUTILS D'UN AGENT IA QUI ENVOIENT SUR UNE CIBLE FIXÉE (RC4) : « Envoyer un bloc » et « Lancer un scénario ».
 *
 * 🔴 CE QUI COMPTE ICI est la fin du parcours de l'agent quand il lance un scénario : le parcours qui le portait (un bloc
 * Agent IA d'un scénario, ou le répondeur) est CLOS, jamais AVANCÉ. Une sortie du bloc agent qui repartirait derrière
 * enverrait la suite du scénario A pendant que B parle ; une fin de parcours rendrait la main à l'agent de Meta pendant
 * que B attend une réponse. Prouvé sur le VRAI exécuteur et la VRAIE entrée de lancement.
 */

const n = (id: string, type: WorkflowNodeType, data: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, data });
const WA = '33611223344';
const WF_B = '0b7e2c1a-4d5e-4f60-8a9b-1c2d3e4f5a6b';
const CODE = 'nod_t1_01HZX5Y6Z7A8B9C0D1E2F3G4H5';

/** Les dépendances de la composition, toutes observées. */
function composition(over: Partial<DepsGestesEnvoiAgent> = {}) {
  const journal: string[] = [];
  const deps: DepsGestesEnvoiAgent = {
    graphePublie: async (_t, id) => (id === WF_B ? {
      nodes: [
        n('q', 'quick_message', { body: 'voici', code: CODE }),
        n('qb', 'quick_message', { body: 'un choix ?', quickReplies: ['Oui'], code: 'nod_t1_01HZX5Y6Z7A8B9C0D1E2F3G4H6' }),
      ],
      edges: [{ id: 'e1', source: 'q', target: 'qb' }],
    } : null),
    envoyerDepuisAgent: async (_t, _w, i) => { journal.push(`bloc:${i.runId}:${i.workflowId}:${i.noeudId}:${i.graphe.nodes.map((x) => x.id).join(',')}`); return { ok: true }; },
    lancer: async (d) => { journal.push(`lancer:${d.type}:${d.workflowId}:${d.waId}:${d.fenetreOuverte}`); return true; },
    fenetreOuverte: async () => true,
    estDesabonne: jamaisDesabonne,
    sessions: { clore: async (_t, id, statut, sortie) => { journal.push(`session:${id}:${statut}:${sortie ?? ''}`); } },
    parcours: { clore: async (_t, runId) => { journal.push(`parcours:${runId}`); return false; } },
    ...over,
  };
  return { gestes: creerGestesEnvoiAgent(deps), journal };
}

const LANCER = { tenantId: ESPACE, waId: WA, runId: 'r-agent', sessionId: 's-agent', workflowId: WF_B };

describe('envoyer le bloc fixé', () => {
  it('🔴 le bloc part SEUL, pris dans le graphe PUBLIÉ de son scénario : ce qui le suit ne part pas', async () => {
    const { gestes, journal } = composition();
    expect(await gestes.envoyerBloc({ tenantId: ESPACE, waId: WA, runId: 'r-agent', workflowId: WF_B, code: CODE })).toEqual({ ok: true });
    // Le graphe transmis est réduit au bloc (`blocSeul`) : la question qui le suit dans le scénario n'y est pas.
    expect(journal).toEqual([`bloc:r-agent:${WF_B}:q:q`]);
  });

  it('un scénario disparu, ou un bloc qui attend une réponse, est refusé AVANT tout envoi, avec sa raison', async () => {
    const { gestes, journal } = composition();
    expect(await gestes.envoyerBloc({ tenantId: ESPACE, waId: WA, runId: 'r', workflowId: 'wf-supprime', code: CODE }))
      .toEqual({ ok: false, raison: 'le scénario de ce bloc n’existe plus' });
    const attend = await gestes.envoyerBloc({ tenantId: ESPACE, waId: WA, runId: 'r', workflowId: WF_B, code: 'nod_t1_01HZX5Y6Z7A8B9C0D1E2F3G4H6' });
    expect(attend.ok).toBe(false);
    expect(attend.raison).toContain('attend une réponse');
    expect(journal).toEqual([]);
  });
});

describe('lancer le scénario fixé : la composition', () => {
  it('🔴 lancé : type `agent_ia_scenario`, fenêtre prouvée par la conversation, puis session ET parcours de l’agent clos', async () => {
    const { gestes, journal } = composition();
    expect(await gestes.lancerScenario(LANCER)).toEqual({ ok: true });
    expect(journal).toEqual([
      `lancer:agent_ia_scenario:${WF_B}:${WA}:true`,
      // Close en RETRAIT, sans sortie due : rien ne fera avancer le bloc agent.
      'session:s-agent:sortie:scenario_lance',
      'parcours:r-agent',
    ]);
  });

  it('🔴 refusé (scénario non publié, supprimé) : rien n’est clos, la session continue et le modèle lit la raison', async () => {
    const vide = composition({ lancer: async () => 'le scénario est vide' });
    expect(await vide.gestes.lancerScenario(LANCER)).toEqual({ ok: false, raison: 'le scénario est vide' });
    expect(vide.journal).toEqual([]);
    const supprime = composition({ lancer: async () => null });
    expect(await supprime.gestes.lancerScenario(LANCER)).toEqual({ ok: false, raison: SCENARIO_INCONNU });
    expect(supprime.journal).toEqual([]);
  });

  it('🔴 un contact désabonné : rien n’est lancé, rien n’est clos', async () => {
    const { gestes, journal } = composition({ estDesabonne: async () => true });
    expect(await gestes.lancerScenario(LANCER)).toEqual({ ok: false, raison: CONTACT_DESABONNE });
    expect(journal).toEqual([]);
  });
});

/**
 * Le VRAI exécuteur et la VRAIE entrée de lancement, sur le VRAI contrôle du fil. Le parcours de l'agent attend sur son
 * bloc ; sa sortie `fini` mène à un message que seul un parcours AVANCÉ enverrait. L'agent de Meta est allumé : une fin
 * de parcours lui rendrait la main, et c'est ce qu'on guette.
 */
function monde(parcoursAgent: { workflowId: string; graphe: WorkflowGraph; fige: boolean }) {
  const b = bancDuFil({ surLaListe: [WA], conversations: { [WA]: { owner: 'app_workflow' } } });
  const envois: string[] = [];
  const rendus: string[] = [];
  const sessionsCloses: Array<[string, string, string | undefined]> = [];
  const runs = new Map<string, WorkflowRunRow>();
  runs.set('r-agent', {
    id: 'r-agent', workflowId: parcoursAgent.workflowId, tenantId: ESPACE, waId: WA, currentNode: 'a', status: 'waiting',
    lastMessageId: null, grapheFige: parcoursAgent.fige ? parcoursAgent.graphe : null,
  });
  const scenarioB: WorkflowGraph = {
    nodes: [n('qm', 'quick_message', { body: 'Quel jour vous arrange ?', quickReplies: ['Lundi', 'Mardi'] })],
    edges: [],
  };
  const sessionVivante = { status: 'en_cours' as string };
  const agentSessions: AgentSessionStore = {
    byRun: async (_t, runId) => (runId === 'r-agent' && sessionVivante.status === 'en_cours'
      ? { id: 's-agent', tenantId: ESPACE, runId, agentId: 'ag1', nodeId: 'a', waId: WA, tours: 1, appelsOutils: 0, coutMicroEur: 0, status: 'en_cours', ouvertLe: '2026-10-06T08:00:00.000Z' }
      : null),
    // Comme le vrai dépôt : seule une session `en_cours` se clôt, un rejeu n'y change rien.
    clore: async (_t, id, statut, sortie) => {
      if (sessionVivante.status !== 'en_cours') return;
      sessionVivante.status = statut;
      sessionsCloses.push([id, statut, sortie]);
    },
    open: async () => { throw new Error('aucune session à ouvrir ici'); },
    prendreLeTour: async () => null,
    ajouterAuTranscript: async () => {},
    compterAppel: async () => {},
    ajouterCout: async () => {},
  };
  const deps: WorkflowExecutorDeps = {
    ...depsInertes,
    estDesabonne: jamaisDesabonne,
    runs: avecGardesDEtatInertes({
      start: async (_t: string, workflowId: string, waId: string, contactId: string | null, state: { currentNode: string | null; status: string }) => {
        runs.set('r-b', { id: 'r-b', workflowId, tenantId: ESPACE, waId, currentNode: state.currentNode, status: state.status as WorkflowRunRow['status'], lastMessageId: null, grapheFige: null });
        return { id: 'r-b' };
      },
      findWaitingByWaId: async () => [...runs.values()].filter((r) => r.status === 'waiting').at(-1) ?? null,
      setState: async (id: string, s: { currentNode: string | null; status: string }) => {
        const r = runs.get(id);
        if (r) runs.set(id, { ...r, currentNode: s.currentNode, status: s.status as WorkflowRunRow['status'] });
      },
      setStateSiVivant: async (_t: string, id: string, s: { currentNode: string | null; status: string }) => {
        const r = runs.get(id);
        if (!r || (r.status !== 'waiting' && r.status !== 'sleeping')) return false;
        runs.set(id, { ...r, currentNode: s.currentNode, status: s.status as WorkflowRunRow['status'] });
        return true;
      },
      closeActiveByWaId: async (_t: string, waId: string) => {
        const clos: string[] = [];
        for (const r of runs.values()) {
          if (r.waId === waId && (r.status === 'waiting' || r.status === 'sleeping')) {
            runs.set(r.id, { ...r, status: 'done', currentNode: null });
            clos.push(r.id);
          }
        }
        return clos;
      },
    }),
    getGraph: async (id) => (id === parcoursAgent.workflowId ? parcoursAgent.graphe : id === WF_B ? scenarioB : null),
    applyTag: async () => true,
    setField: async () => {},
    removeTag: async () => {},
    clearField: async () => {},
    sendTemplate: async (_t, _w, nom) => { envois.push(`tpl:${nom}`); },
    sendQuickMessage: async (_t, _w, texte) => { envois.push(`qm:${texte}`); },
    sendFlow: async () => {},
    sendQuestion: async () => {},
    agentSessions,
    mayAct: b.fil.peutAgir,
    reclaimControl: b.fil.reprendrePourLApp,
    mbaActifPour: async () => true,
    releaseToMba: async (_t, w) => { rendus.push(w); },
  };
  const executor = new WorkflowExecutor(deps);
  const lancements = creerLancements({
    executor,
    scenarios: { getById: async (id) => (id === WF_B ? { graph: scenarioB, draftGraph: null } : null) },
    contacts: { findIdByWaId: async () => 'c1' },
    offres: offresToutOuvert,
  });
  const gestes = creerGestesEnvoiAgent({
    graphePublie: async () => null,
    envoyerDepuisAgent: (t, w, i) => executor.envoyerBlocDepuisAgent(t, w, i),
    lancer: (d) => lancements.lancer(d),
    fenetreOuverte: async () => true,
    estDesabonne: jamaisDesabonne,
    sessions: agentSessions,
    parcours: { clore: (t, runId) => deps.runs.setStateSiVivant(t, runId, { currentNode: null, status: 'done' }) },
  });
  return { b, gestes, executor, envois, rendus, sessionsCloses, runs };
}

/** Un scénario A dont le bloc Agent IA sort par `fini` vers un message : il ne part que si A est AVANCÉ. */
const SCENARIO_A: WorkflowGraph = {
  nodes: [n('a', 'agent', { agentId: 'ag1' }), n('suite', 'quick_message', { body: 'La suite du scénario A' })],
  edges: [{ id: 'e1', source: 'a', target: 'suite', sourceHandle: 'sortie:fini' }, { id: 'e2', source: 'a', target: 'suite', sourceHandle: 'sortie:scenario_lance' }],
};

describe('lancer le scénario fixé, sur le vrai exécuteur', () => {
  for (const [cas, parcours] of [
    ['depuis le bloc Agent IA d’un scénario', { workflowId: 'wf-a', graphe: SCENARIO_A, fige: false }],
    ['depuis le répondeur', { workflowId: 'wf-repondeur', graphe: grapheDuRepondeur({ id: 'ag1', sorties: [{ code: 'fini', label: 'Fini' }] }), fige: true }],
  ] as const) {
    it(`🔴 ${cas} : B part, le parcours de l’agent est CLOS sans suivre aucune sortie, et rien n’est rendu à l’agent de Meta`, async () => {
      const m = monde(parcours);
      expect(await m.gestes.lancerScenario({ ...LANCER, workflowId: WF_B })).toEqual({ ok: true });
      // B a parlé, et lui seul : la suite de A (ou la fin du répondeur) n'a rien envoyé.
      expect(m.envois).toEqual(['qm:Quel jour vous arrange ?']);
      expect(m.runs.get('r-agent')).toMatchObject({ status: 'done', currentNode: null });
      expect(m.runs.get('r-b')).toMatchObject({ workflowId: WF_B, status: 'waiting', currentNode: 'qm' });
      // La session de l'agent est close UNE fois, en retrait, par le démarrage lui-même.
      expect(m.sessionsCloses).toEqual([['s-agent', 'sortie', 'scenario_lance']]);
      // Ni avant ni après le démarrage, la main n'est rendue à l'agent de Meta : B tient le fil.
      expect(m.rendus).toEqual([]);
      expect(m.b.etat(WA)?.owner).toBe('app_workflow');
      // Et une sortie tardive du bloc agent (un rejeu, un tour mort) ne trouve plus le parcours de l'agent : B, qui
      // attend sur une question, n'est pas un bloc agent et ne bouge pas.
      expect(await m.executor.sortirDuBlocAgent(ESPACE, WA, 's-agent', 'fini')).toBe(false);
      expect(m.envois).toEqual(['qm:Quel jour vous arrange ?']);
    });
  }

  it('un scénario qui ne remplace rien (fini aussitôt, sans message) : le parcours de l’agent est clos quand même', async () => {
    // B n'envoie rien et finit : `runFrom` ne clôt aucun parcours. La composition le fait, sans sortie du bloc.
    const m = monde({ workflowId: 'wf-a', graphe: SCENARIO_A, fige: false });
    const muet: WorkflowGraph = { nodes: [n('t', 'tag', { tag: 'vip' })], edges: [] };
    const lancements = creerLancements({
      executor: m.executor,
      scenarios: { getById: async () => ({ graph: muet, draftGraph: null }) },
      contacts: { findIdByWaId: async () => 'c1' },
      offres: offresToutOuvert,
    });
    const sessions: string[] = [];
    const gestes = creerGestesEnvoiAgent({
      graphePublie: async () => null,
      envoyerDepuisAgent: async () => ({ ok: true }),
      lancer: (d) => lancements.lancer(d),
      fenetreOuverte: async () => true,
      estDesabonne: jamaisDesabonne,
      sessions: { clore: async (_t, id, statut, sortie) => { sessions.push(`${id}:${statut}:${sortie ?? ''}`); } },
      parcours: {
        clore: async (_t, runId) => {
          const r = m.runs.get(runId);
          if (!r || r.status !== 'waiting') return false;
          m.runs.set(runId, { ...r, status: 'done', currentNode: null });
          return true;
        },
      },
    });
    expect(await gestes.lancerScenario(LANCER)).toEqual({ ok: true });
    expect(m.envois).toEqual([]);
    expect(m.runs.get('r-agent')).toMatchObject({ status: 'done', currentNode: null });
    expect(sessions).toEqual(['s-agent:sortie:scenario_lance']);
  });
});
