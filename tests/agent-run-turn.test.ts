import { describe, it, expect, vi } from 'vitest';
import { runTurn } from '../src/agent/run-turn';
import { creerCerveauGateway } from '../src/agent/brain.gateway';
import type { ReponseChat } from '../src/agent/llm/chat-client';
import type { OutilDefini, ToolCatalog } from '../src/agent/catalog';
import type { EntreeResolveur } from '../src/agent/executor';
import { ficheVide } from '../src/agent/fiche';
import type { RunTurnDeps, EtatRun } from '../src/agent/run-turn';
import type { FicheAgent } from '../src/agent/agent-store';
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
  tours: 1, appelsOutils: 0, coutMicroEur: 0, status: 'en_cours', ouvertLe: '2026-08-28T10:00:00.000Z',
};

const FICHE: FicheAgent = {
  id: 'ag1', tenantId: 't1', mentionIa: 'Je suis une IA.', modele: 'm', status: 'active',
  plafonds: { maxTours: 8, maxAppelsOutils: 12, budgetMicroEur: 30000 },
  inactiviteMinutes: 30, contactInconnu: 'lecture_seule',
};
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
    lireFiche: async () => FICHE,
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
    const { deps, brain, envois, sorties, clotures } = make({ lireFiche: async () => null });
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
    // Le repos est rendu et l'échéance posée quand même (tâche 17) : sans elle, un fil repris par un
    // humain qui ne revient jamais laisserait ce run et sa session en plan pour toujours.
    expect(await runTurn(JOB, deps)).toMatchObject({ fait: 'main_perdue' });
    expect(brain.appels).toHaveLength(1); // le cerveau a bien été appelé AVANT la garde
    expect(envois).toEqual([]);
    expect(clotures).toEqual([]); // le gel est transitoire : on ne clôt PAS la session
  });

  it('cas nominal : le texte part, la mesure « sent » est posée, le parcours reste en attente', async () => {
    const { deps, envois, mesures, sorties, transcript } = make();
    // Le repos porte l'échéance d'inactivité de la fiche (tâche 17).
    expect(await runTurn(JOB, deps)).toEqual({ fait: 'repondu', repos: { status: 'waiting', nodeId: 'a', timeoutInMs: 30 * 60_000 } });
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

describe('la MÉMOIRE du tour', () => {
  it('🔴 la conversation est LUE et passée au cerveau', async () => {
    // Sans elle, `runTurn` passait un transcript VIDE en dur : l'agent redemandait son nom au contact à
    // chaque message. Elle est lue et non reçue, parce qu'`advance` ne porte pas le texte du message entrant
    // et que changer sa signature toucherait le chemin le plus chaud du produit et ses trois appelants.
    const vus: unknown[][] = [];
    const { deps } = make({
      lireConversation: async () => [{ role: 'contact', texte: 'Bonjour' }, { role: 'agent', texte: 'Bonjour !' }],
      brain: { penser: async (i) => { vus.push(i.transcript); return { texte: 'ok', sortie: null }; } },
    });
    await runTurn(JOB, deps);
    expect(vus[0]).toEqual([{ role: 'contact', texte: 'Bonjour' }, { role: 'agent', texte: 'Bonjour !' }]);
  });

  it('🔴 elle est bornée par l’OUVERTURE de la session, pas par tout l’historique du contact', async () => {
    // Un contact qui écrit depuis des mois ferait sinon payer tout son historique à chaque tour, et l'agent
    // répondrait à des questions déjà traitées par un humain.
    const bornes: Array<{ waId: string; depuis: string }> = [];
    const { deps } = make({
      lireConversation: async (_t, waId, depuis) => { bornes.push({ waId, depuis }); return []; },
    });
    await runTurn(JOB, deps);
    expect(bornes[0]).toEqual({ waId: JOB.waId, depuis: SESSION.ouvertLe });
  });

  it('🔴 une lecture EN ÉCHEC ne tue pas le tour : l’agent parle sans mémoire', async () => {
    // Un tour mort laisse le contact sans réponse. Un tour sans mémoire est dégradé, mais il répond.
    const { deps, envois } = make({
      lireConversation: async () => { throw new Error('pooler injoignable'); },
    });
    const res = await runTurn(JOB, deps);
    expect(res.fait).toBe('repondu');
    expect(envois).toHaveLength(1);
  });

  it('sans dep de lecture, le tour marche quand même', async () => {
    // C'est le comportement d'avant cette tâche, et il reste atteignable : les suites à deps minimales ne
    // doivent pas avoir à câbler une conversation pour tester autre chose.
    const { deps } = make({});
    expect((await runTurn(JOB, deps)).fait).toBe('repondu');
  });
});

/**
 * 🔴 LE TOUR BRANCHÉ SUR LE VRAI CERVEAU, et pas sur le cerveau bouchonné.
 *
 * Ce test existe parce que son absence a laissé passer un défaut qui aurait cassé CHAQUE tour en production.
 * `AgentBrain.penser` porte un `tour` OPTIONNEL (le cerveau bouchonné n'en a que faire), et `runTurn` avait
 * oublié de le remplir. Le typecheck ne pouvait rien voir, les tests de `runTurn` non plus (leur cerveau
 * ignore le champ), et ceux du cerveau non plus (ils le fournissent à la main). Il fallait un test qui relie
 * les DEUX modules réels, et c'est le seul endroit d'où le défaut était visible.
 *
 * La leçon, générale : deux modules chacun testé ne prouvent rien de leur JOINTURE, surtout quand le contrat
 * qui les lie est optionnel.
 */
describe('le tour, branché sur le VRAI cerveau', () => {
  const OUTIL: OutilDefini = {
    id: 'o1', tenantId: 't1', agentId: 'ag1', origin: 'mba', name: 'mba_poser_tag',
    description: 'Tague.', params: [{ name: 'tag', type: 'string', source: 'modele', required: true }],
    binding: { handler: 'poser_tag' }, outputPaths: [], risk: 'write',
    timeoutMs: 8000, maxBytes: 16384, autonome: false,
  };

  function cerveauReel(reponses: ReponseChat[]) {
    const cap = { tours: [] as unknown[], appels: [] as string[] };
    const brain = creerCerveauGateway({
      completer: async () => reponses.shift() ?? reponses[0]!,
      contexte: async () => ({
        modele: 'm', mentionIa: 'Je suis une IA.', sorties: [{ code: 'fini', label: 'Fini' }],
        contenu: { ...ficheVide(), objectif: 'Aider.' }, outilsActifs: [OUTIL],
        plafonds: { maxAppelsOutils: 12, budgetMicroEur: 30_000 }, contactInconnu: 'tous',
      }),
      outils: {
        catalogue: { byName: async (_t: string, _a: string, n: string) => (n === OUTIL.name ? OUTIL : null), listActifs: async () => [OUTIL] } satisfies ToolCatalog,
        journal: { ouvrir: async () => 'j1', clore: async () => {} },
        resolveurs: { mba: async ({ ctx }: EntreeResolveur) => { cap.tours.push({ sessionId: ctx.sessionId, runId: ctx.runId, waId: ctx.waId }); return { contenu: { ok: true } }; } },
        compterAppel: async () => { cap.appels.push('x'); },
      },
    });
    return { cap, brain };
  }

  const reponseTexte = (t: string): ReponseChat => ({
    texte: t, appelsOutils: [], finish: 'stop',
    usage: { tokensIn: 1, tokensOut: 1, coutDollars: 0 }, generationId: null,
  });

  it('🔴 le tour lui passe son CONTEXTE : sans lui, le cerveau réel lève à chaque appel', async () => {
    const { brain } = cerveauReel([reponseTexte('Bonjour !')]);
    const { deps, envois } = make({ brain });
    const res = await runTurn(JOB, deps);
    expect(res.fait).toBe('repondu');
    expect(envois).toEqual(['Bonjour !']);
  });

  it('🔴 et ce contexte désigne la BONNE conversation, jusque dans les outils', async () => {
    // Un contexte figé au câblage ferait exécuter les outils du contact A dans la conversation de B : c'est
    // le défaut de conception que le passage à l'appel a fermé, et il se vérifie ici, bout en bout.
    const { cap, brain } = cerveauReel([
      { texte: null, appelsOutils: [{ id: 'c1', nom: 'mba_poser_tag', argumentsJson: '{"tag":"vip"}' }], finish: 'tool_calls', usage: { tokensIn: 1, tokensOut: 1, coutDollars: 0 }, generationId: null },
      reponseTexte('C est note.'),
    ]);
    const { deps } = make({ brain });
    await runTurn(JOB, deps);
    expect(cap.tours[0]).toEqual({ sessionId: SESSION.id, runId: JOB.runId, waId: JOB.waId });
    expect(cap.appels).toHaveLength(1);
  });
});
