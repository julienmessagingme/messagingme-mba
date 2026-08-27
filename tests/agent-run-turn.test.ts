import { describe, it, expect, vi } from 'vitest';
import { runTurn } from '../src/agent/run-turn';
import type { RunTurnDeps, PlafondsAgent, EtatRun } from '../src/agent/run-turn';
import { FakeAgentBrain } from '../src/agent/brain.fake';
import type { DecisionAgent } from '../src/agent/brain';
import type { AgentSession } from '../src/agent/session-store';
import type { AgentTurnJob } from '../src/agent/turn-job';

const JOB: AgentTurnJob = {
  tenantId: 't1', runId: 'r1', sessionId: 's1', workflowId: 'wf1',
  nodeId: 'a', waId: '33600', raison: 'message', tours: 0,
};

const SESSION: AgentSession = {
  id: 's1', tenantId: 't1', runId: 'r1', agentId: 'ag1', nodeId: 'a', waId: '33600',
  tours: 1, appelsOutils: 0, coutMicroEur: 0, status: 'en_cours',
};

const PLAFONDS: PlafondsAgent = { maxTours: 8, maxAppelsOutils: 12, budgetMicroEur: 30000 };
const RUN_VIVANT: EtatRun = { status: 'waiting', currentNode: 'a' };

/** Deps par défaut : tout est nominal, chaque test ne surcharge que ce qu'il veut casser. */
function make(over: Partial<RunTurnDeps> = {}, decision?: DecisionAgent) {
  const envois: string[] = [];
  const clotures: Array<{ status: string; sortie?: string }> = [];
  const sorties: string[] = [];
  const mesures: string[] = [];
  const transcript: unknown[] = [];
  const brain = new FakeAgentBrain(decision ?? { texte: 'Bonjour', sortie: null });
  const deps: RunTurnDeps = {
    sessions: {
      prendreLeTour: async () => SESSION,
      clore: async (_t: string, _id: string, status: string, sortie?: string) => { clotures.push({ status, ...(sortie ? { sortie } : {}) }); },
      ajouterAuTranscript: async (_t: string, _id: string, e: unknown) => { transcript.push(e); },
    } as unknown as RunTurnDeps['sessions'],
    brain,
    lireRun: async () => RUN_VIVANT,
    lirePlafonds: async () => PLAFONDS,
    envoyer: async (_t, _w, texte) => { envois.push(texte); },
    mesurer: async (i) => { mesures.push(i.kind); },
    sortir: async (i) => { sorties.push(i.sortie); },
    ...over,
  };
  return { deps, brain, envois, clotures, sorties, mesures, transcript };
}

describe('runTurn : les gardes du tour (tâche 13a)', () => {
  it('🔴 REJEU : le verrou optimiste rend null -> ni cerveau, ni envoi', async () => {
    // pg-boss est at-least-once, et un réveil d'inactivité différé peut arriver après que le contact a
    // répondu. Rejouer enverrait un second message et rappellerait les outils.
    const { deps, brain, envois } = make({
      sessions: { prendreLeTour: async () => null } as unknown as RunTurnDeps['sessions'],
    });
    expect(await runTurn(JOB, deps)).toEqual({ fait: 'rejeu' });
    expect(brain.appels).toEqual([]);
    expect(envois).toEqual([]);
  });

  it('🔴 RUN MORT (statut) : rien n est envoyé, la session est close en erreur', async () => {
    // La garde unique qui rend tout tueur de run, présent ou futur, automatiquement sûr.
    const { deps, brain, envois, clotures } = make({ lireRun: async () => ({ status: 'done', currentNode: null }) });
    expect(await runTurn(JOB, deps)).toEqual({ fait: 'run_mort' });
    expect(brain.appels).toEqual([]);
    expect(envois).toEqual([]);
    expect(clotures).toEqual([{ status: 'erreur' }]);
  });

  it('🔴 RUN PARTI SUR UN AUTRE BLOC : même traitement (le parcours a avancé sans nous)', async () => {
    const { deps, envois, clotures } = make({ lireRun: async () => ({ status: 'waiting', currentNode: 'autre' }) });
    expect(await runTurn(JOB, deps)).toEqual({ fait: 'run_mort' });
    expect(envois).toEqual([]);
    expect(clotures).toEqual([{ status: 'erreur' }]);
  });

  it('run introuvable : traité comme un run mort', async () => {
    const { deps, envois } = make({ lireRun: async () => null });
    expect(await runTurn(JOB, deps)).toEqual({ fait: 'run_mort' });
    expect(envois).toEqual([]);
  });

  it('🔴 PLAFOND DE TOURS atteint : sortie « plafond », et le cerveau n est PAS appelé', async () => {
    // On ne paie pas un appel dont on jettera la réponse.
    const { deps, brain, envois, sorties, clotures } = make({
      sessions: {
        prendreLeTour: async () => ({ ...SESSION, tours: 9 }),
        clore: async () => {}, ajouterAuTranscript: async () => {},
      } as unknown as RunTurnDeps['sessions'],
    });
    const out = await runTurn(JOB, deps);
    expect(out.fait).toBe('plafond');
    expect(out.sortie).toBe('plafond');
    expect(brain.appels).toEqual([]);
    expect(envois).toEqual([]);
    expect(sorties).toEqual(['plafond']);
    expect(clotures).toEqual([]); // la cloture passe par le fake de session surcharge
  });

  it('plafond d appels d outils dépassé : même sortie, sans appeler le cerveau', async () => {
    const { deps, brain, sorties } = make({
      sessions: {
        prendreLeTour: async () => ({ ...SESSION, appelsOutils: 13 }),
        clore: async () => {}, ajouterAuTranscript: async () => {},
      } as unknown as RunTurnDeps['sessions'],
    });
    expect((await runTurn(JOB, deps)).fait).toBe('plafond');
    expect(brain.appels).toEqual([]);
    expect(sorties).toEqual(['plafond']);
  });

  it('budget épuisé : même sortie, sans appeler le cerveau', async () => {
    const { deps, brain, sorties } = make({
      sessions: {
        prendreLeTour: async () => ({ ...SESSION, coutMicroEur: 30000 }),
        clore: async () => {}, ajouterAuTranscript: async () => {},
      } as unknown as RunTurnDeps['sessions'],
    });
    expect((await runTurn(JOB, deps)).fait).toBe('plafond');
    expect(brain.appels).toEqual([]);
    expect(sorties).toEqual(['plafond']);
  });

  it('fiche d agent introuvable : sortie par la branche d échec, sans appeler le cerveau', async () => {
    // Ne pas sortir laisserait le run en attente sur le bloc avec une session close : conversation muette.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { deps, brain, envois, sorties, clotures } = make({ lirePlafonds: async () => null });
    expect(await runTurn(JOB, deps)).toEqual({ fait: 'erreur', sortie: 'echec' });
    expect(brain.appels).toEqual([]);
    expect(envois).toEqual([]);
    expect(clotures).toEqual([{ status: 'erreur', sortie: 'echec' }]);
    expect(sorties).toEqual(['echec']);
    spy.mockRestore();
  });

  it('plafond de tours à la FRONTIÈRE : le dernier tour autorisé passe encore', async () => {
    // `max_tours` peut valoir 1 (CHECK de la migration 0086). Avec `>=`, un tel agent ne pourrait JAMAIS
    // parler. La borne est donc `>`, et ce test l'ancre : tours == maxTours doit encore passer.
    const { deps, brain, envois } = make({
      sessions: {
        prendreLeTour: async () => ({ ...SESSION, tours: 8 }),
        clore: async () => {}, ajouterAuTranscript: async () => {},
      } as unknown as RunTurnDeps['sessions'],
    });
    expect((await runTurn(JOB, deps)).fait).toBe('repondu');
    expect(brain.appels).toHaveLength(1);
    expect(envois).toEqual(['Bonjour']);
  });

  it('🔴 mayAct REFUSE juste avant l envoi : rien ne part', async () => {
    // Entre l'enfilage du job et son exécution, un opérateur a pu prendre la main. Vérifier à l'entrée du
    // tour ne suffit pas : le cerveau a pris plusieurs secondes.
    const { deps, brain, envois, clotures } = make({ mayAct: async () => false });
    expect(await runTurn(JOB, deps)).toEqual({ fait: 'main_perdue' });
    expect(brain.appels).toHaveLength(1); // le cerveau a bien été appelé AVANT la garde
    expect(envois).toEqual([]);
    expect(clotures).toEqual([]); // le gel est transitoire : on ne clôt PAS la session
  });

  it('cas nominal : le texte part, la mesure « sent » est posée, le parcours reste en attente', async () => {
    const { deps, envois, mesures, sorties, transcript } = make();
    expect(await runTurn(JOB, deps)).toEqual({ fait: 'repondu' });
    expect(envois).toEqual(['Bonjour']);
    expect(mesures).toEqual(['sent']);
    expect(sorties).toEqual([]); // pas de sortie : on attend la réponse du contact
    expect(transcript).toEqual([{ role: 'agent', texte: 'Bonjour' }]);
  });

  it('envoi REFUSÉ : mesure « failed », session close, sortie par la branche d échec', async () => {
    const { deps, mesures, sorties, clotures } = make({ envoyer: async () => 'fenêtre fermée' });
    const out = await runTurn(JOB, deps);
    expect(out).toEqual({ fait: 'erreur', sortie: 'echec' });
    expect(mesures).toEqual(['failed']);
    expect(clotures).toEqual([{ status: 'erreur', sortie: 'echec' }]);
    expect(sorties).toEqual(['echec']);
  });

  it('sortie décidée : session close et scénario repris par la branche', async () => {
    const { deps, envois, sorties, clotures } = make({}, { texte: 'Au revoir', sortie: 'fini' });
    expect(await runTurn(JOB, deps)).toEqual({ fait: 'sorti', sortie: 'fini' });
    expect(envois).toEqual(['Au revoir']);
    expect(clotures).toEqual([{ status: 'sortie', sortie: 'fini' }]);
    expect(sorties).toEqual(['fini']);
  });

  it('texte null : aucun envoi, mais la sortie est suivie (c est le bloc AVAL qui parle)', async () => {
    const { deps, envois, mesures, sorties } = make({}, { texte: null, sortie: 'escalade' });
    expect(await runTurn(JOB, deps)).toEqual({ fait: 'sorti', sortie: 'escalade' });
    expect(envois).toEqual([]);
    expect(mesures).toEqual([]); // rien envoyé, rien à mesurer
    expect(sorties).toEqual(['escalade']);
  });

  it('le cerveau lève : session close en erreur, sortie par la branche d échec, rien envoyé', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const brainQuiLeve = { penser: async () => { throw new Error('modèle indisponible'); } };
    const { deps, envois, sorties, clotures } = make({ brain: brainQuiLeve });
    expect(await runTurn(JOB, deps)).toEqual({ fait: 'erreur', sortie: 'echec' });
    expect(envois).toEqual([]);
    expect(clotures).toEqual([{ status: 'erreur', sortie: 'echec' }]);
    expect(sorties).toEqual(['echec']);
    spy.mockRestore();
  });
});
