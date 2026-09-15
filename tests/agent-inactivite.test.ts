import { jamaisDesabonne } from './consentement';
import { describe, it, expect } from 'vitest';
import { runTurn, reposApresReponse } from '../src/agent/run-turn';
import type { RunTurnDeps, EtatRun } from '../src/agent/run-turn';
import { restToState } from '../src/workflow/executor';
import type { RunState } from '../src/workflow/run-store.pg';
import { FakeAgentBrain } from '../src/agent/brain.fake';
import type { DecisionAgent } from '../src/agent/brain';
import type { FicheAgent } from '../src/agent/agent-store';
import type { AgentSession } from '../src/agent/session-store';
import type { AgentTurnJob } from '../src/agent/turn-job';

/**
 * Tâche 17 : l'inactivité de l'agent.
 *
 * Il n'y a AUCUN mécanisme nouveau, et c'est le sujet. Le bloc Question fait déjà attendre un parcours sur
 * deux choses à la fois, une réponse du contact ET le temps qui passe : le run reste `waiting`, donc
 * `findWaitingByWaId` le voit, et il porte en plus un `resume_at` que le balayeur consomme. Le tour se
 * contente de rendre l'échéance dans son repos, et `restToState` fait le reste, sans être modifiée.
 */

const JOB: AgentTurnJob = {
  tenantId: 't1', runId: 'r1', sessionId: 's1', workflowId: 'wf1',
  nodeId: 'a', waId: '33600', raison: 'message', tours: 0,
};

const SESSION: AgentSession = {
  id: 's1', tenantId: 't1', runId: 'r1', agentId: 'ag1', nodeId: 'a', waId: '33600',
  tours: 1, appelsOutils: 0, coutMicroEur: 0, status: 'en_cours', ouvertLe: '2026-08-28T10:00:00.000Z',
};

const FICHE: FicheAgent = {
  id: 'ag1', tenantId: 't1', mentionIa: 'Je suis une IA.', mentionIaFrequence: 'session' as const, modele: 'm', status: 'active',
  plafonds: { maxTours: 8, maxAppelsOutils: 12, budgetMicroEur: 30_000 },
  inactiviteMinutes: 30, contactInconnu: 'lecture_seule',
};

const RUN_VIVANT: EtatRun = { status: 'waiting', currentNode: 'a' };
const MAINTENANT = 1_700_000_000_000;

function make(fiche: FicheAgent = FICHE, decision?: DecisionAgent, session: AgentSession = SESSION) {
  const etats: Array<{ runId: string; nodeId: string; state: RunState }> = [];
  const deps: RunTurnDeps = {
    estDesabonne: jamaisDesabonne,
    sessions: {
      prendreLeTour: async () => session,
      clore: async () => {},
      ajouterAuTranscript: async () => {},
    } as unknown as RunTurnDeps['sessions'],
    brain: new FakeAgentBrain(decision ?? { texte: 'Bonjour', sortie: null }),
    lireRun: async () => RUN_VIVANT,
    lireFiche: async () => fiche,
    envoyer: async () => {},
    majRun: async (_t, runId, nodeId, state) => { etats.push({ runId, nodeId, state }); },
    sortir: async () => {},
    now: () => MAINTENANT,
  };
  return { deps, etats };
}

describe('inactivité de l agent (tâche 17)', () => {
  it('un tour qui attend pose l échéance de la fiche dans son repos', async () => {
    const { deps } = make();
    const out = await runTurn(JOB, deps);
    expect(out.repos).toEqual({ status: 'waiting', nodeId: 'a', timeoutInMs: 30 * 60_000 });
  });

  it('🔴 l échéance est PERSISTÉE sur le run, qui reste « waiting » SUR le bloc agent', async () => {
    // Le run doit rester `waiting` : c'est ce qui permet à une réponse du contact de le reprendre par
    // `findWaitingByWaId`. Il porte EN PLUS l'échéance. Le seul état du produit qui attend les deux.
    const { deps, etats } = make();
    await runTurn(JOB, deps);
    expect(etats).toHaveLength(1);
    expect(etats[0]).toEqual({
      runId: 'r1',
      // Le bloc attendu est passé À PART : c'est la garde qui empêche de ressusciter un run déplacé.
      nodeId: 'a',
      state: { currentNode: 'a', status: 'waiting', resumeAt: new Date(MAINTENANT + 30 * 60_000) },
    });
  });

  it('🔴 une inactivité NULLE n écrit AUCUNE échéance, l agent attend sans limite', async () => {
    // LE test qui compte. `restToState` n'écrit `resume_at` que si `timeoutInMs` est DÉFINI : transmettre
    // `0` au lieu d'un champ absent poserait une échéance IMMÉDIATE, réveillerait le parcours dans la
    // seconde et sortirait l'agent par `timeout` avant que le contact ait pu lire. Même piège que
    // `startAfter: 0` et `max: 0`, déjà documenté deux fois dans `src/queue/pgboss.ts`.
    const { deps, etats } = make({ ...FICHE, inactiviteMinutes: 0 });
    const out = await runTurn(JOB, deps);
    expect(out.repos).toEqual({ status: 'waiting', nodeId: 'a' });
    expect(out.repos).not.toHaveProperty('timeoutInMs');
    // Et l'état persisté ne porte AUCUNE échéance (la colonne est remise à NULL, pas à maintenant).
    expect(etats[0]?.state).toEqual({ currentNode: 'a', status: 'waiting' });
  });

  it('une inactivité négative ou absurde est traitée comme nulle, jamais comme immédiate', async () => {
    for (const minutes of [-5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(reposApresReponse('a', minutes)).toEqual({ status: 'waiting', nodeId: 'a' });
    }
  });

  it('un tour qui SORT ne pose aucune échéance : c est le scénario qui reprend', async () => {
    const { deps, etats } = make(FICHE, { texte: 'Je vous transfère', sortie: 'humain' });
    const out = await runTurn(JOB, deps);
    expect(out.fait).toBe('sorti');
    expect(out.repos).toBeUndefined();
    expect(etats).toEqual([]);
  });

  it('un tour qui échoue ne pose aucune échéance non plus', async () => {
    // Plafond RÉALISTE : `max_tours` est borné entre 1 et 20 en base (migration 0086), un zéro n'existe pas.
    const { deps, etats } = make({ ...FICHE, plafonds: { ...FICHE.plafonds, maxTours: 1 } }, undefined, { ...SESSION, tours: 2 });
    const out = await runTurn(JOB, deps);
    expect(out.fait).toBe('plafond');
    expect(etats).toEqual([]);
  });

  it('une panne d écriture de l échéance ne fait PAS échouer le tour', async () => {
    // L'agent a DÉJÀ parlé au contact : renvoyer le job en file d'échec ferait renvoyer le message. On
    // dégrade vers « attente sans limite », qui est le comportement d'avant cette tâche.
    const { deps } = make();
    const out = await runTurn(JOB, { ...deps, majRun: async () => { throw new Error('base injoignable'); } });
    expect(out.fait).toBe('repondu');
  });

  it('🔴 main perdue : l échéance est posée QUAND MÊME, sinon le run et la session traînent pour toujours', async () => {
    // `advance` vient d'effacer l'échéance en enfilant ce tour. Si un humain reprend le fil et ne revient
    // jamais, sans échéance rien ne ramasse le parcours en attente ni sa session vivante.
    const { deps, etats } = make();
    const out = await runTurn(JOB, { ...deps, mayAct: async () => false });
    expect(out.fait).toBe('main_perdue');
    expect(etats[0]?.state).toMatchObject({ currentNode: 'a', status: 'waiting', resumeAt: new Date(MAINTENANT + 30 * 60_000) });
  });

  it('sans dep de persistance (suites à deps minimales), le tour reste nominal', async () => {
    const { deps } = make();
    const sansMaj: RunTurnDeps = { ...deps };
    delete sansMaj.majRun;
    expect((await runTurn(JOB, sansMaj)).fait).toBe('repondu');
  });

});
