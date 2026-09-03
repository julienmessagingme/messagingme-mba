import { describe, it, expect } from 'vitest';
import { runTourBloqueSweep, AGE_TOUR_MORT_S, LOT_TOURS_BLOQUES } from '../src/agent/tour-bloque-sweep';
import type { TourBloque } from '../src/agent/session-store';
import { runTurn } from '../src/agent/run-turn';
import type { RunTurnDeps, EtatRun } from '../src/agent/run-turn';
import type { AgentSession } from '../src/agent/session-store';
import type { AgentTurnJob } from '../src/agent/turn-job';
import type { FicheAgent } from '../src/agent/agent-store';
import { FakeAgentBrain } from '../src/agent/brain.fake';
import type { DecisionAgent } from '../src/agent/brain';

/**
 * LE TOUR D'AGENT MORT EN VOL (constat A1 de l'audit externe du 2026-09-02).
 *
 * 🔴 Le défaut fermé ici. `prendreLeTour` incrémente `tours` AVANT le travail, parce que c'est ce qui rend le
 * verrou optimiste atomique. Le worker meurt entre les deux : pg-boss rejoue avec l'ANCIEN numéro de tour, la
 * réservation rend `null`, le rejeu est classé « doublon » et sort sans rien faire. Le tour est perdu POUR
 * TOUJOURS, la session reste `en_cours`, le run reste en attente sans échéance (l'échéance se pose à la FIN
 * du tour, qui n'est jamais arrivée), et le contact n'a jamais de réponse.
 */

const tour = (id: string): TourBloque => ({
  sessionId: id, tenantId: 't1', runId: `r-${id}`, waId: '33600', nodeId: 'a',
});

describe('balayage des tours d’agent morts en vol', () => {
  it('rien à réclamer : aucune sortie, et on ne dit rien', async () => {
    const journal: string[] = [];
    const n = await runTourBloqueSweep({
      reclamer: async () => [],
      sortir: async () => { throw new Error('ne doit pas être appelé'); },
      log: (m) => journal.push(m),
    });
    expect(n).toBe(0);
    // Un balayage qui parle à chaque passage pour ne rien dire noie les lignes qui comptent.
    expect(journal).toEqual([]);
  });

  it('🔴 chaque session réclamée fait SORTIR son parcours par la branche d’échec', async () => {
    // Le point du lot : clore la session ne suffit pas. Sans la sortie, on aurait rangé la table en laissant
    // le run en attente sur le bloc agent, donc le contact toujours sans réponse.
    const sortis: string[] = [];
    const n = await runTourBloqueSweep({
      reclamer: async () => [tour('s1'), tour('s2')],
      sortir: async (t) => { sortis.push(t.sessionId); },
    });
    expect(sortis).toEqual(['s1', 's2']);
    expect(n).toBe(2);
  });

  it('🔴 une sortie qui échoue n’arrête PAS les autres', async () => {
    // Les sessions sont DÉJÀ closes en base quand on arrive ici : s'arrêter au premier échec laisserait les
    // suivantes closes ET bloquées, c'est-à-dire pire que l'état de départ.
    const sortis: string[] = [];
    const journal: string[] = [];
    const n = await runTourBloqueSweep({
      reclamer: async () => [tour('s1'), tour('s2'), tour('s3')],
      sortir: async (t) => {
        if (t.sessionId === 's2') throw new Error('parcours introuvable');
        sortis.push(t.sessionId);
      },
      log: (m) => journal.push(m),
    });
    expect(sortis).toEqual(['s1', 's3']);
    expect(n).toBe(2);
    expect(journal.some((m) => m.includes('s2') && m.includes('parcours introuvable'))).toBe(true);
  });

  it('l’âge et le lot par défaut sont ceux du module, et ils sont passés au store', async () => {
    let vus: [number, number] | null = null;
    await runTourBloqueSweep({
      reclamer: async (age, limite) => { vus = [age, limite]; return []; },
      sortir: async () => {},
    });
    expect(vus).toEqual([AGE_TOUR_MORT_S, LOT_TOURS_BLOQUES]);
    // Dix minutes : un tour vivant est borné par l'échéance du cerveau (30 s) plus ses appels d'outils, il ne
    // s'en approche jamais. C'est un garde-fou d'anomalie, pas une limite de fonctionnement.
    expect(AGE_TOUR_MORT_S).toBeGreaterThanOrEqual(5 * 60);
  });
});

/**
 * 🔴 LA MOITIÉ DANGEREUSE DU LOT : le balayage ne doit JAMAIS ramasser une conversation vivante.
 *
 * Le marqueur `tour_commence_le` est posé par `prendreLeTour` et doit être effacé sur les DEUX sorties qui
 * laissent la session en vie. En oublier une ferait tuer par le balayage, dix minutes après une réponse
 * parfaitement réussie, un parcours parfaitement sain.
 */
describe('runTurn : la marque de tour en vol est retirée sur les sorties VIVANTES', () => {
  const JOB: AgentTurnJob = {
    tenantId: 't1', runId: 'r1', sessionId: 's1', workflowId: 'wf1',
    nodeId: 'a', waId: '33600', raison: 'message', tours: 0,
  };
  const SESSION: AgentSession = {
    id: 's1', tenantId: 't1', runId: 'r1', agentId: 'ag1', nodeId: 'a', waId: '33600',
    tours: 1, appelsOutils: 0, coutMicroEur: 0, status: 'en_cours', ouvertLe: '2026-08-28T10:00:00.000Z',
  };
  const FICHE: FicheAgent = {
    id: 'ag1', tenantId: 't1', mentionIa: 'Je suis une IA.', modele: 'm', status: 'active',
    plafonds: { maxTours: 8, maxAppelsOutils: 12, budgetMicroEur: 30000 },
    inactiviteMinutes: 30, contactInconnu: 'lecture_seule',
  };
  const RUN_VIVANT: EtatRun = { status: 'waiting', currentNode: 'a' };

  function make(over: Partial<RunTurnDeps> = {}, decision?: DecisionAgent) {
    const finis: string[] = [];
    const clotures: string[] = [];
    const deps: RunTurnDeps = {
      sessions: {
        prendreLeTour: async () => SESSION,
        clore: async (_t: string, id: string) => { clotures.push(id); },
        ajouterAuTranscript: async () => {},
        ajouterCout: async () => {},
        finirLeTour: async (_t: string, id: string) => { finis.push(id); },
      } as unknown as RunTurnDeps['sessions'],
      brain: new FakeAgentBrain(decision ?? { texte: 'Bonjour', sortie: null }),
      lireRun: async () => RUN_VIVANT,
      lireFiche: async () => FICHE,
      envoyer: async () => {},
      sortir: async () => {},
      ...over,
    };
    return { deps, finis, clotures };
  }

  it('🔴 l’agent a répondu et attend : la marque est RETIRÉE', async () => {
    const { deps, finis } = make();
    const res = await runTurn(JOB, deps);
    expect(res.fait).toBe('repondu');
    expect(finis).toEqual(['s1']); // sans ça, le balayage tuerait cette conversation dans dix minutes
  });

  it('🔴 un humain a pris la main : la marque est RETIRÉE aussi', async () => {
    // Cette sortie laisse elle aussi la session vivante, volontairement (le gel est transitoire). Elle est
    // donc exposée au même faux positif que la précédente.
    const { deps, finis } = make({ mayAct: async () => false });
    const res = await runTurn(JOB, deps);
    expect(res.fait).toBe('main_perdue');
    expect(finis).toEqual(['s1']);
  });

  it('une sortie qui CLÔT ne passe pas par là : `clore` efface la marque en même temps', async () => {
    // Pas de double écriture : la clôture porte déjà l'effacement en base, l'ajouter ici serait une requête
    // de plus sur le chemin chaud pour rien.
    const { deps, finis, clotures } = make({}, { texte: null, sortie: 'termine' });
    const res = await runTurn(JOB, deps);
    expect(res.fait).toBe('sorti');
    expect(clotures).toEqual(['s1']);
    expect(finis).toEqual([]);
  });

  it('un store SANS `finirLeTour` garde le comportement d’avant', async () => {
    // La méthode est optionnelle : les fixtures et les câblages de test ne doivent pas cesser de tourner.
    const { deps } = make();
    (deps.sessions as unknown as { finirLeTour?: unknown }).finirLeTour = undefined;
    const res = await runTurn(JOB, deps);
    expect(res.fait).toBe('repondu');
  });

  it('une marque qui refuse de s’effacer ne fait PAS échouer le tour', async () => {
    // L'agent a déjà parlé au contact quand on arrive ici : faire échouer le tour renverrait le job en file,
    // donc renverrait le message. Le pire d'un échec ici est une sortie par la branche d'échec au prochain
    // balayage, jamais un doublon chez le contact.
    const { deps } = make();
    (deps.sessions as unknown as { finirLeTour: () => Promise<void> }).finirLeTour = async () => {
      throw new Error('base indisponible');
    };
    const res = await runTurn(JOB, deps);
    expect(res.fait).toBe('repondu');
  });
});
