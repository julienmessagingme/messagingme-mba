import { jamaisDesabonne } from './consentement';
import { describe, it, expect, vi } from 'vitest';
import { MEMOIRE_JOURS, runTurn } from '../src/agent/run-turn';
import { creerCerveauGateway } from '../src/agent/brain.gateway';
import type { ReponseChat } from '../src/agent/llm/chat-client';
import type { OutilDefini, ToolCatalog } from '../src/agent/catalog';
import type { EntreeResolveur } from '../src/agent/executor';
import { ficheVide } from '../src/agent/fiche';
import type { RunTurnDeps, EtatRun } from '../src/agent/run-turn';
import type { FicheAgent } from '../src/agent/agent-store';
import { FakeAgentBrain } from './fake-agent-brain';
import type { DecisionAgent } from '../src/agent/brain';
import { TourInterrompu } from '../src/agent/brain';
import { PlafondModeleAtteint } from '../src/llm/errors';
import type { AgentSession } from '../src/agent/session-store';
import type { AgentTurnJob } from '../src/agent/turn-job';
import { outilMaison, paramsInitiaux } from '../src/agent/outils-maison';
import { creerResolveurMba } from '../src/agent/resolvers/mba';
import { SANS_MCP } from './outils-mcp';
import { AUCUN_GESTE, GESTE_MUET } from './gestes';

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
  plafonds: { maxTours: 8, maxAppelsOutils: 12, budgetMicroEur: 30000 },
  inactiviteMinutes: 30, contactInconnu: 'lecture_seule',
};
const RUN_VIVANT: EtatRun = { status: 'waiting', currentNode: 'a' };

/** Le store de sessions nominal. Extrait pour que les tests qui ne veulent surcharger QU'UNE méthode
 *  n'aient pas à recopier les trois autres, et surtout n'oublient pas `ajouterCout`. */
function sessionsOk(): RunTurnDeps['sessions'] {
  return {
    prendreLeTour: async () => SESSION,
    clore: async () => {},
    ajouterAuTranscript: async () => {},
    ajouterCout: async () => {},
  } as unknown as RunTurnDeps['sessions'];
}

/** Deps par défaut : tout est nominal, chaque test ne surcharge que ce qu'il veut casser. */
function make(over: Partial<RunTurnDeps> = {}, decision?: DecisionAgent) {
  const envois: string[] = [];
  const clotures: Array<{ status: string; sortie?: string }> = [];
  const sorties: string[] = [];
  const mesures: string[] = [];
  const transcript: unknown[] = [];
  const brain = new FakeAgentBrain(decision ?? { texte: 'Bonjour', sortie: null });
  const deps: RunTurnDeps = {
    estDesabonne: jamaisDesabonne,
    estRepondeur: async () => false,
    numeroBloque: async () => false,
    sessions: {
      ...sessionsOk(),
      clore: async (_t: string, _id: string, status: string, sortie?: string) => { clotures.push({ status, ...(sortie ? { sortie } : {}) }); },
      ajouterAuTranscript: async (_t: string, _id: string, e: unknown) => { transcript.push(e); },
    } as unknown as RunTurnDeps['sessions'],
    brain,
    lireRun: async () => RUN_VIVANT,
    agents: { byId: async () => FICHE },
    envoyer: async (_t, _w, texte) => { envois.push(texte); },
    mesures: { record: async (i) => { mesures.push(i.kind); } },
    sortir: async (i) => { sorties.push(i.sortie); },
    ...over,
  };
  return { deps, brain, envois, clotures, sorties, mesures, transcript };
}

describe('runTurn : le numéro bloqué (lot 4)', () => {
  it('🔴 numéro suspendu ou délié : ni modèle, ni débit, ni envoi ; le tour se finit et le parcours attend', async () => {
    const debits: number[] = [];
    const { deps, brain, envois, clotures } = make({ numeroBloque: async () => true, debiterTenant: async (_t, m) => { debits.push(m); } });
    const r = await runTurn(JOB, deps);
    expect(r.fait).toBe('numero_bloque');
    expect(r.repos?.status).toBe('waiting');
    expect(brain.appels).toEqual([]);
    expect(debits).toEqual([]);
    expect(envois).toEqual([]);
    // La session n'est pas close : au paiement, le prochain message du contact relance l'agent.
    expect(clotures).toEqual([]);
  });

  it('numéro libre : le tour suit son cours', async () => {
    const { deps, envois } = make({ numeroBloque: async () => false });
    expect((await runTurn(JOB, deps)).fait).toBe('repondu');
    expect(envois).toEqual(['Bonjour']);
  });
});

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
    const { deps, brain, envois, sorties, clotures } = make({ agents: { byId: async () => null } });
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

  it('🔴 elle est bornée à TRENTE JOURS (lot 5), et le cerveau reçoit l’ouverture de la session pour l’annonce d’IA', async () => {
    // Un contact qui écrit depuis des mois ferait sinon payer tout son historique à chaque tour (le câblage borne
    // aussi le NOMBRE, trente messages). La borne n'est plus l'ouverture de la session : voir le cas suivant.
    const bornes: Array<{ waId: string; depuis: string }> = [];
    const vus: Array<string | undefined> = [];
    const { deps } = make({
      now: () => Date.parse('2026-10-05T12:00:00.000Z'),
      lireConversation: async (_t, waId, depuis) => { bornes.push({ waId, depuis }); return []; },
      brain: { penser: async (i) => { vus.push(i.tour?.sessionOuverteLe); return { texte: 'ok', sortie: null }; } },
    });
    await runTurn(JOB, deps);
    expect(MEMOIRE_JOURS).toBe(30);
    expect(bornes[0]).toEqual({ waId: JOB.waId, depuis: '2026-09-05T12:00:00.000Z' });
    expect(vus).toEqual([SESSION.ouvertLe]);
  });

  it('🔴 le cerveau sait si le parcours est le RÉPONDEUR, lu sur le scénario du job (essai réel du 2026-10-05)', async () => {
    // Dans le répondeur, aucune branche ne parle après une escalade : le cerveau y garde la phrase de l'agent.
    const lus: string[] = [];
    const vus: Array<boolean | undefined> = [];
    for (const estLe of [true, false]) {
      const { deps } = make({
        estRepondeur: async (t, wf) => { lus.push(`${t}/${wf}`); return estLe; },
        brain: { penser: async (i) => { vus.push(i.tour?.repondeur); return { texte: 'ok', sortie: null }; } },
      });
      await runTurn(JOB, deps);
    }
    expect(lus).toEqual([`${JOB.tenantId}/${JOB.workflowId}`, `${JOB.tenantId}/${JOB.workflowId}`]);
    expect(vus).toEqual([true, false]);
  });

  it('🔴 cette lecture en échec fait REJOUER le job : ni cerveau, ni clôture, ni sortie par l’échec', async () => {
    // Comme la fiche et le solde : un raté de la base n'est pas un échec de la conversation. Lue dans le `try` du
    // cerveau, elle clôturait la session et sortait par `echec`, donc chez l'équipe dans le répondeur.
    const { deps, brain, clotures, sorties } = make({ estRepondeur: async () => { throw new Error('pooler injoignable'); } });
    await expect(runTurn(JOB, deps)).rejects.toThrow('pooler injoignable');
    expect(brain.appels).toEqual([]);
    expect(clotures).toEqual([]);
    expect(sorties).toEqual([]);
  });

  it('🔴 le PREMIER tour lit le message qui l’a déclenché, enregistré AVANT l’ouverture de la session', async () => {
    // Le défaut que le lot 5 répare, pour tous les agents : `recordInbound` écrit le message, PUIS le parcours
    // démarre et ouvre la session. Bornée à l'ouverture, la lecture l'excluait et l'agent parlait à froid, sans le
    // message auquel il répondait. Le faux filtre comme le SQL (`created_at >= depuis`).
    const fil = [
      { role: 'agent', texte: 'Modèle d’il y a quarante jours', at: '2026-08-26T10:00:00.000Z' },
      { role: 'contact', texte: 'Vous livrez à Lyon ?', at: '2026-10-05T11:59:59.000Z' },
    ];
    const vus: unknown[][] = [];
    const { deps } = make({
      now: () => Date.parse('2026-10-05T12:00:00.000Z'),
      sessions: { ...sessionsOk(), prendreLeTour: async () => ({ ...SESSION, ouvertLe: '2026-10-05T12:00:00.000Z' }) },
      lireConversation: async (_t, _w, depuis) => fil.filter((m) => m.at >= depuis),
      brain: { penser: async (i) => { vus.push(i.transcript); return { texte: 'Oui', sortie: null }; } },
    });
    await runTurn(JOB, deps);
    expect(vus[0]).toEqual([{ role: 'contact', texte: 'Vous livrez à Lyon ?', at: '2026-10-05T11:59:59.000Z' }]);
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
  const OUTIL: OutilDefini = { ...SANS_MCP, ...AUCUN_GESTE(),
    id: 'o1', tenantId: 't1', origin: 'mba', name: 'mba_poser_tag',
    description: 'Tague.', params: [{ name: 'tag', type: 'string', source: 'modele', required: true }],
    binding: { handler: 'poser_tag' }, sourceId: null, requestId: null, nePasUtiliser: '', nature: 'integre' as const, outputPaths: [], risk: 'write',
    timeoutMs: 8000, maxBytes: 16384, autonome: false,
  };

  function cerveauReel(reponses: ReponseChat[]) {
    const cap = { tours: [] as unknown[], appels: [] as string[] };
    const brain = creerCerveauGateway({
      client: {
        completer: async () => reponses.shift() ?? reponses[0]!,
      },
      contexte: async () => ({
        modele: 'm', mentionIa: 'Je suis une IA.', mentionIaFrequence: 'session' as const, sorties: [{ code: 'fini', label: 'Fini' }],
        contenu: { ...ficheVide(), objectif: 'Aider.' }, outilsActifs: [OUTIL],
        plafonds: { maxAppelsOutils: 12, budgetMicroEur: 30_000 }, contactInconnu: 'tous',
      }),
      commissionPct: 0,
      outils: {
        catalogue: { byName: async (_t: string, _a: string, n: string) => (n === OUTIL.name ? OUTIL : null), listActifs: async () => [OUTIL] } satisfies ToolCatalog,
        journal: { ouvrir: async () => 'j1', clore: async () => {} },
        resolveurs: { mba: async ({ ctx }: EntreeResolveur) => { cap.tours.push({ sessionId: ctx.sessionId, runId: ctx.runId, waId: ctx.waId }); return { contenu: { ok: true } }; } },
        sessions: {
          compterAppel: async () => { cap.appels.push('x'); },
        },
        executerGeste: GESTE_MUET,
      },
    });
    return { cap, brain };
  }

  const reponseTexte = (t: string): ReponseChat => ({
    texte: t, appelsOutils: [], finish: 'stop',
    usage: { tokensIn: 1, tokensOut: 1, tokensCaches: 0, coutDollars: 0 }, generationId: null,
  });

  it('🔴 le tour lui passe son CONTEXTE : sans lui, le cerveau réel lève à chaque appel', async () => {
    const { brain } = cerveauReel([reponseTexte('Bonjour !')]);
    const { deps, envois } = make({ brain });
    const res = await runTurn(JOB, deps);
    expect(res.fait).toBe('repondu');
    // Premier tour d'une session neuve, régime « session » : la phrase d'annonce part devant (2026-10-05).
    expect(envois).toEqual(['Je suis une IA.\n\nBonjour !']);
  });

  it('🔴 la réponse qui SUIT un appel d’outil part avec la phrase devant : le cas qui partait sans elle (2026-10-05)', async () => {
    // Le défaut mesuré en production : le modèle cherchait dans sa base, puis répondait sans la phrase que la consigne
    // lui demandait. Ici, le vrai tour et le vrai cerveau : c'est ce texte-là que `envoyer` remet à WhatsApp.
    const { brain } = cerveauReel([
      { texte: null, appelsOutils: [{ id: 'c1', nom: 'mba_poser_tag', argumentsJson: '{"tag":"vip"}' }], finish: 'tool_calls', usage: { tokensIn: 1, tokensOut: 1, tokensCaches: 0, coutDollars: 0 }, generationId: null },
      reponseTexte('Votre **contrat** couvre ce litige.'),
    ]);
    const { deps, envois } = make({ brain });
    expect((await runTurn(JOB, deps)).fait).toBe('repondu');
    expect(envois).toEqual(['Je suis une IA.\n\nVotre *contrat* couvre ce litige.']);
  });

  it('🔴 et ce contexte désigne la BONNE conversation, jusque dans les outils', async () => {
    // Un contexte figé au câblage ferait exécuter les outils du contact A dans la conversation de B : c'est
    // le défaut de conception que le passage à l'appel a fermé, et il se vérifie ici, bout en bout.
    const { cap, brain } = cerveauReel([
      { texte: null, appelsOutils: [{ id: 'c1', nom: 'mba_poser_tag', argumentsJson: '{"tag":"vip"}' }], finish: 'tool_calls', usage: { tokensIn: 1, tokensOut: 1, tokensCaches: 0, coutDollars: 0 }, generationId: null },
      reponseTexte('C est note.'),
    ]);
    const { deps } = make({ brain });
    await runTurn(JOB, deps);
    expect(cap.tours[0]).toEqual({ sessionId: SESSION.id, runId: JOB.runId, waId: JOB.waId });
    expect(cap.appels).toHaveLength(1);
  });
});

/**
 * LE BUDGET, VRAIMENT RELIÉ À LA CONSOMMATION.
 *
 * 🔴 CE QUE CES TESTS FERMENT. Le coût d'un tour n'était écrit NULLE PART : `agent_sessions.cout_micro_eur`
 * existait, la console affichait un plafond par conversation, `runTurn` le comparait, et la colonne restait
 * à zéro pour toujours. La comparaison était donc toujours fausse, et le réglage montré au client était
 * DÉCORATIF. Le budget restant s'appliquait bien à l'intérieur d'UN tour, mais d'un message à l'autre rien
 * ne s'accumulait.
 */
describe('le budget, relié à la consommation', () => {
  const USAGE = { tokensIn: 100, tokensOut: 20, coutMicroEur: 4200 };

  it('🔴 le coût du tour est écrit SUR LA SESSION et DÉBITÉ du solde du workspace', async () => {
    const couts: number[] = [];
    const debits: Array<{ montant: number; sessionId: string }> = [];
    const { deps } = make({
      sessions: { ...sessionsOk(), ajouterCout: async (_t, _s, m) => { couts.push(m); } },
      credits: {
        solde: async () => 30_000,
      },
      debiterTenant: async (_t, montant, sessionId) => { debits.push({ montant, sessionId }); },
    }, { texte: 'ok', sortie: null, usage: USAGE });
    await runTurn(JOB, deps);
    expect(couts).toEqual([4200]);
    expect(debits).toEqual([{ montant: 4200, sessionId: SESSION.id }]);
  });

  it('🔴 un solde ÉPUISÉ refuse le tour AVANT d’appeler le modèle', async () => {
    // Lire le solde après coup reviendrait à payer un appel qu'on savait ne pas pouvoir facturer.
    let pense = 0;
    const { deps, envois } = make({
      credits: {
        solde: async () => 0,
      },
      brain: { penser: async () => { pense += 1; return { texte: 'jamais', sortie: null }; } },
    });
    const res = await runTurn(JOB, deps);
    expect(res).toMatchObject({ fait: 'plafond', sortie: 'plafond' });
    expect(pense).toBe(0);
    expect(envois).toEqual([]);
  });

  it('et un solde NÉGATIF aussi : on ne laisse pas la dette creuser', async () => {
    const { deps } = make({ credits: { solde: async () => -1200 } });
    expect((await runTurn(JOB, deps)).fait).toBe('plafond');
  });

  it('un solde suffisant laisse passer', async () => {
    const { deps, envois } = make({ credits: { solde: async () => 1 } });
    expect((await runTurn(JOB, deps)).fait).toBe('repondu');
    expect(envois).toHaveLength(1);
  });

  /**
   * 🔴 L'ALERTE DE CRÉDIT (lot 5, A8) : un tour qui sort faute de CRÉDIT prévient les admins (une fois par jour, tenu
   * par l'alerte elle-même). Faute de crédit seulement : un plafond de la conversation ne dit rien du crédit, et
   * l'alerte enverrait un e-mail faux.
   */
  it('🔴 solde épuisé ou plafond de la clé chez le Gateway : l’alerte part ; un plafond de tours : rien', async () => {
    const alertes: string[] = [];
    const alerterCreditEpuise = async (t: string) => { alertes.push(t); };
    const { deps } = make({ credits: { solde: async () => 0 }, alerterCreditEpuise });
    expect((await runTurn(JOB, deps)).fait).toBe('plafond');
    expect(alertes).toEqual(['t1']);

    const { deps: gateway } = make({
      credits: { solde: async () => 30_000 }, alerterCreditEpuise,
      brain: { penser: async () => { throw new PlafondModeleAtteint(429, 'quota'); } },
    });
    expect((await runTurn(JOB, gateway)).fait).toBe('plafond');
    expect(alertes).toEqual(['t1', 't1']);

    const { deps: tours } = make({
      credits: { solde: async () => 30_000 }, alerterCreditEpuise,
      sessions: { ...sessionsOk(), prendreLeTour: async () => ({ ...SESSION, tours: 99 }) },
    });
    expect((await runTurn(JOB, tours)).fait).toBe('plafond');
    expect(alertes, 'un plafond de tours n’est pas un crédit épuisé').toEqual(['t1', 't1']);
  });

  it('🔴 une écriture de comptage EN ÉCHEC ne fait pas échouer le tour', async () => {
    // Le modèle a déjà répondu et le fournisseur a déjà facturé : renvoyer le job en file paierait l'appel
    // une seconde fois. On perd une ligne de comptabilité, jamais une conversation.
    const { deps, envois } = make({
      sessions: { ...sessionsOk(), ajouterCout: async () => { throw new Error('pooler injoignable'); } },
      credits: {
        solde: async () => 30_000,
      },
    }, { texte: 'ok', sortie: null, usage: USAGE });
    const res = await runTurn(JOB, deps);
    expect(res.fait).toBe('repondu');
    expect(envois).toHaveLength(1);
  });

  it('🔴 un tour qui ÉCHOUE APRÈS avoir déjà payé débite quand même', async () => {
    // LE cas que le diff a failli laisser passer. Un tour fait plusieurs allers-retours de modèle, facturés
    // séparément : le modèle appelle un outil, on paie ce premier appel, puis le second casse (panne, 4xx
    // terminal, échéance). L'exception emportait avec elle ce qui avait déjà été dépensé, donc le fournisseur
    // facturait et le workspace ne payait rien.
    const couts: number[] = [];
    const debits: number[] = [];
    const { deps } = make({
      sessions: { ...sessionsOk(), ajouterCout: async (_t: string, _s: string, m: number) => { couts.push(m); } } as unknown as RunTurnDeps['sessions'],
      credits: {
        solde: async () => 30_000,
      },
      debiterTenant: async (_t, m) => { debits.push(m); },
      brain: { penser: async () => { throw new TourInterrompu(new Error('502 du fournisseur'), USAGE); } },
    });
    expect((await runTurn(JOB, deps)).fait).toBe('erreur');
    expect(debits).toEqual([4200]);
    expect(couts).toEqual([4200]);
  });

  it('une panne SÈCHE, elle, ne débite rien', async () => {
    // La distinction EST le sujet : une erreur survenue avant tout appel facturé (clé refusée, agent
    // introuvable) ne doit rien prélever, sinon on facture au client des tours qui n'ont rien coûté.
    const debits: number[] = [];
    const { deps } = make({
      credits: {
        solde: async () => 30_000,
      },
      debiterTenant: async (_t, m) => { debits.push(m); },
      brain: { penser: async () => { throw new Error('clé refusée'); } },
    });
    expect((await runTurn(JOB, deps)).fait).toBe('erreur');
    expect(debits).toEqual([]);
  });

  it('🔴 un débit de solde EN ÉCHEC n’empêche pas d’écrire le compteur de la session', async () => {
    // Deux tables, deux écritures, donc deux gardes : elles ne peuvent pas être atomiques entre elles, et les
    // enchaîner dans un seul `try` faisait sauter la seconde au premier raté de la première.
    const couts: number[] = [];
    const { deps, envois } = make({
      sessions: { ...sessionsOk(), ajouterCout: async (_t: string, _s: string, m: number) => { couts.push(m); } } as unknown as RunTurnDeps['sessions'],
      credits: {
        solde: async () => 30_000,
      },
      debiterTenant: async () => { throw new Error('contention sur la ligne de solde'); },
    }, { texte: 'ok', sortie: null, usage: USAGE });
    expect((await runTurn(JOB, deps)).fait).toBe('repondu');
    expect(couts).toEqual([4200]);
    expect(envois).toHaveLength(1);
  });

  it('un tour sans usage ne débite rien', async () => {
    const debits: number[] = [];
    const { deps } = make({ credits: { solde: async () => 30_000 }, debiterTenant: async (_t, m) => { debits.push(m); } });
    await runTurn(JOB, deps);
    expect(debits).toEqual([]);
  });

  it('sans dep de solde, le tour marche comme avant', async () => {
    // Comportement d'avant la tâche 21 : les suites à deps minimales n'ont pas à câbler un prépayé.
    const { deps } = make({});
    expect((await runTurn(JOB, deps)).fait).toBe('repondu');
  });
});

/**
 * 🔴 LA DERNIÈRE PHRASE APRÈS UNE ESCALADE (revue finale du chantier des moments, 2026-09-18).
 *
 * Ces deux cas existent parce que le lot des horaires était INTÉGRALEMENT INERTE en production et qu'aucun
 * test ne le voyait. Ceux du lot lisaient ce que le cerveau REND (`penserTrace`), jamais ce qui PART. Or
 * entre les deux il y a `mayAct`, que l'escalade venait elle-même de rendre faux en basculant le fil vers
 * `app_human` : la phrase était calculée, gardée, puis jetée sans une trace. Le bac à sable, qui ne passe
 * pas par ce chemin, l'affichait, donc l'essai montrait une fonctionnalité que le contact n'a jamais reçue.
 *
 * ⚠️ ILS ASSERTENT SUR `envois`, ET C'EST LA SEULE CHOSE QUI COMPTE. Une assertion sur la décision rendue
 * passait déjà avant le correctif.
 */
describe('runTurn : la main rendue PAR CE TOUR', () => {
  it('🔴 escalade + équipe fermée : la phrase PART, alors que le fil n est plus à nous', async () => {
    // `mayAct` est FAUX : l'escalade vient de faire passer le fil en `app_human`, et c'est exactement la
    // situation que le correctif traite. La marque dit que ce basculement est le NÔTRE.
    const { deps, envois, transcript } = make(
      { mayAct: async () => false },
      { texte: 'Nous sommes fermés, l’équipe vous répond lundi à 9 h.', sortie: null, mainPriseParCeTour: true },
    );
    expect(await runTurn(JOB, deps)).toMatchObject({ fait: 'repondu' });
    expect(envois).toEqual(['Nous sommes fermés, l’équipe vous répond lundi à 9 h.']);
    // La phrase entre AUSSI au transcript : sans ça, la session garderait la trace d'un silence.
    expect(transcript).toEqual([{ role: 'agent', texte: 'Nous sommes fermés, l’équipe vous répond lundi à 9 h.' }]);
  });

  it('⚠️ la main était DÉJÀ prise par un opérateur : rien ne part, la garde tient', async () => {
    // La preuve inverse, sans laquelle le correctif ci-dessus serait un trou. `setControlOwner` rend `false`
    // quand le fil n'était pas `app_workflow`, donc la décision ne porte PAS la marque, et le tour se tait.
    const { deps, envois } = make(
      { mayAct: async () => false },
      { texte: 'Je vous passe un conseiller.', sortie: null },
    );
    expect(await runTurn(JOB, deps)).toMatchObject({ fait: 'main_perdue' });
    expect(envois).toEqual([]);
  });
});

/**
 * 🔴 LA SORTIE PART AVEC SON DERNIER MESSAGE, de bout en bout : le tour, le vrai cerveau, le vrai exécuteur et le
 * vrai résolveur de production. Le modèle appelle `terminer` sans rien écrire à côté (ce que fait GPT-5 mini à
 * chaque sortie) ; le message qu'il a mis dans l'outil doit partir AVANT que le scénario ne reprenne, comme tout
 * texte de décision. L'outil porte la copie de paramètres d'un outil déjà posé : `sortie` seule.
 */
describe('runTurn : la sortie et son dernier message', () => {
  const TERMINER: OutilDefini = { ...SANS_MCP, ...AUCUN_GESTE(),
    id: 'o2', tenantId: 't1', origin: 'mba', name: 'mba_terminer',
    description: 'Termine.', params: paramsInitiaux(outilMaison('terminer')!),
    binding: { handler: 'terminer' }, sourceId: null, requestId: null, nePasUtiliser: '', nature: 'integre' as const, outputPaths: [], risk: 'read',
    timeoutMs: 8000, maxBytes: 16384, autonome: false,
  };
  const RESOLVEUR_MBA = creerResolveurMba({
    envoyerBloc: async () => ({ ok: true }), lancerScenario: async () => ({ ok: true }), escaladerVersHumain: async () => true, marquerUrgente: async () => true, poserTag: async () => {},
    ecrireChamp: async () => {}, lireAnalyse: async () => null, connaissance: { chercher: async () => [] },
  });

  function tour(argumentsJson: string) {
    const journal: string[] = [];
    const brain = creerCerveauGateway({
      client: {
        completer: async () => ({
          texte: null, appelsOutils: [{ id: 'c1', nom: 'mba_terminer', argumentsJson }], finish: 'tool_calls',
          usage: { tokensIn: 1, tokensOut: 1, tokensCaches: 0, coutDollars: 0 }, generationId: null,
        }),
      },
      contexte: async () => ({
        modele: 'm', mentionIa: 'Je suis une IA.', mentionIaFrequence: 'session' as const, sorties: [{ code: 'fini', label: 'Fini' }],
        contenu: { ...ficheVide(), objectif: 'Aider.' }, outilsActifs: [TERMINER],
        plafonds: { maxAppelsOutils: 12, budgetMicroEur: 30_000 }, contactInconnu: 'tous',
      }),
      commissionPct: 0,
      outils: {
        catalogue: { byName: async (_t: string, _a: string, n: string) => (n === TERMINER.name ? TERMINER : null), listActifs: async () => [TERMINER] } satisfies ToolCatalog,
        journal: { ouvrir: async () => 'j1', clore: async () => {} },
        resolveurs: { mba: RESOLVEUR_MBA },
        sessions: { compterAppel: async () => {} },
        executerGeste: GESTE_MUET,
      },
    });
    const { deps } = make({
      brain,
      envoyer: async (_t, _w, texte) => { journal.push(`envoi:${texte}`); },
      sortir: async (i) => { journal.push(`sortie:${i.sortie}`); },
    });
    return { deps, journal };
  }

  it('🔴 le message de « terminer » PART, puis le scénario reprend par la sortie', async () => {
    const { deps, journal } = tour('{"sortie":"fini","message":"Merci, un conseiller vous rappelle demain."}');
    expect(await runTurn(JOB, deps)).toEqual({ fait: 'sorti', sortie: 'fini' });
    // Premier tour de la session, régime « session » : l'annonce d'IA est due, et le code la pose DEVANT le message
    // de l'outil, que la consigne ne couvre pas (lot 5, A7).
    expect(journal).toEqual(['envoi:Je suis une IA.\n\nMerci, un conseiller vous rappelle demain.', 'sortie:fini']);
  });

  it('un « terminer » sans message sort quand même, sans rien envoyer', async () => {
    const { deps, journal } = tour('{"sortie":"fini","message":""}');
    expect(await runTurn(JOB, deps)).toEqual({ fait: 'sorti', sortie: 'fini' });
    expect(journal).toEqual(['sortie:fini']);
  });
});

/**
 * 🔴 MARQUER LA CONVERSATION URGENTE N'EST PAS UN TRANSFERT (RC2, décision de Julien du 2026-10-06), de bout en bout :
 * le tour, le vrai cerveau, le vrai exécuteur et le vrai résolveur de production. Le modèle marque, puis répond au
 * contact dans le même tour : rien ne sort du bloc, la session n'est pas close, et l'urgence vise le contact du TOUR.
 */
describe('runTurn : marquer la conversation urgente, puis continuer', () => {
  const URGENT: OutilDefini = { ...SANS_MCP, ...AUCUN_GESTE(),
    id: 'o3', tenantId: 't1', origin: 'mba', name: 'mba_marquer_urgent',
    description: 'Urgent.', params: paramsInitiaux(outilMaison('marquer_urgent')!),
    binding: { handler: 'marquer_urgent' }, sourceId: null, requestId: null, nePasUtiliser: '', nature: 'integre' as const, outputPaths: [], risk: 'write',
    timeoutMs: 8000, maxBytes: 16384, autonome: false,
  };
  const usage = { tokensIn: 1, tokensOut: 1, tokensCaches: 0, coutDollars: 0 };

  it('🔴 l’agent marque, puis répond : ni sortie, ni clôture de session, et le bon contact', async () => {
    const journal: string[] = [];
    const resolveur = creerResolveurMba({
      envoyerBloc: async () => ({ ok: true }), lancerScenario: async () => ({ ok: true }), escaladerVersHumain: async () => true, poserTag: async () => {},
      marquerUrgente: async (i) => { journal.push(`urgent:${i.tenantId}:${i.waId}:${i.agentId}`); return true; },
      ecrireChamp: async () => {}, lireAnalyse: async () => null, connaissance: { chercher: async () => [] },
    });
    let n = 0;
    const brain = creerCerveauGateway({
      client: {
        completer: async () => {
          n += 1;
          return n === 1
            ? { texte: null, appelsOutils: [{ id: 'c1', nom: URGENT.name, argumentsJson: '{}' }], finish: 'tool_calls', usage, generationId: null }
            : { texte: 'Je transmets en priorité à l’équipe.', appelsOutils: [], finish: 'stop', usage, generationId: null };
        },
      },
      contexte: async () => ({
        modele: 'm', mentionIa: 'Je suis une IA.', mentionIaFrequence: 'session' as const, sorties: [{ code: 'fini', label: 'Fini' }],
        contenu: { ...ficheVide(), objectif: 'Aider.' }, outilsActifs: [URGENT],
        plafonds: { maxAppelsOutils: 12, budgetMicroEur: 30_000 }, contactInconnu: 'tous',
      }),
      commissionPct: 0,
      outils: {
        catalogue: { byName: async (_t: string, _a: string, nom: string) => (nom === URGENT.name ? URGENT : null), listActifs: async () => [URGENT] } satisfies ToolCatalog,
        journal: { ouvrir: async () => 'j1', clore: async () => {} },
        resolveurs: { mba: resolveur },
        sessions: { compterAppel: async () => {} },
        executerGeste: GESTE_MUET,
      },
    });
    const { deps, envois, clotures, sorties } = make({ brain });
    expect(await runTurn(JOB, deps)).toMatchObject({ fait: 'repondu' });
    // Le contact du tour, l'agent de la session : le modèle n'a rien pu désigner d'autre (l'outil n'a aucun paramètre).
    expect(journal).toEqual([`urgent:${JOB.tenantId}:${JOB.waId}:${SESSION.agentId}`]);
    expect(envois).toEqual(['Je suis une IA.\n\nJe transmets en priorité à l’équipe.']);
    expect(sorties).toEqual([]);
    expect(clotures).toEqual([]);
  });
});

/**
 * 🔴 LANCER UN SCÉNARIO EST TERMINAL (RC4, décision de Julien du 2026-10-06), de bout en bout : le tour, le vrai cerveau,
 * le vrai exécuteur et le vrai résolveur de production. Le scénario fixé prend la conversation, l'agent se retire : le
 * modèle n'est PAS rappelé, rien n'est envoyé par-dessus le scénario, aucune échéance n'est reposée sur le parcours de
 * l'agent et AUCUNE sortie du bloc agent n'est empruntée. La clôture de la session et du parcours est la dépendance de
 * l'outil (`creerGestesEnvoiAgent`, `tests/agent-gestes-envoi.test.ts`).
 */
describe('runTurn : lancer un scénario, puis se taire', () => {
  const WF_CIBLE = '0b7e2c1a-4d5e-4f60-8a9b-1c2d3e4f5a6b';
  const LANCER: OutilDefini = { ...SANS_MCP, ...AUCUN_GESTE(),
    id: 'o4', tenantId: 't1', origin: 'mba', name: 'mba_lancer_scenario',
    description: 'Lance.', params: paramsInitiaux(outilMaison('lancer_scenario')!),
    binding: { handler: 'lancer_scenario', workflowId: WF_CIBLE }, sourceId: null, requestId: null, nePasUtiliser: '', nature: 'integre' as const, outputPaths: [], risk: 'irreversible',
    // Irréversible : le client a coché l'autonomie, sinon le tronc commun refuse l'appel.
    timeoutMs: 8000, maxBytes: 16384, autonome: true,
  };
  const usage = { tokensIn: 1, tokensOut: 1, tokensCaches: 0, coutDollars: 0 };

  function tour(lancement: { ok: boolean; raison?: string }) {
    const journal: string[] = [];
    const resolveur = creerResolveurMba({
      envoyerBloc: async () => ({ ok: true }), escaladerVersHumain: async () => true, marquerUrgente: async () => true,
      poserTag: async () => {}, ecrireChamp: async () => {}, lireAnalyse: async () => null, connaissance: { chercher: async () => [] },
      lancerScenario: async (i) => { journal.push(`lance:${i.workflowId}:${i.runId}:${i.sessionId}:${i.waId}`); return lancement; },
    });
    let appelsModele = 0;
    const brain = creerCerveauGateway({
      client: {
        completer: async () => {
          appelsModele += 1;
          // Le modèle écrit À CÔTÉ de l'appel : ce texte ne doit pas partir, le scénario parle déjà.
          return appelsModele === 1
            ? { texte: 'Je vous lance la prise de rendez-vous.', appelsOutils: [{ id: 'c1', nom: LANCER.name, argumentsJson: '{"workflowId":"autre"}' }], finish: 'tool_calls', usage, generationId: null }
            : { texte: 'Je ne peux pas lancer ce parcours, je reste avec vous.', appelsOutils: [], finish: 'stop', usage, generationId: null };
        },
      },
      contexte: async () => ({
        modele: 'm', mentionIa: 'Je suis une IA.', mentionIaFrequence: 'session' as const, sorties: [{ code: 'fini', label: 'Fini' }],
        contenu: { ...ficheVide(), objectif: 'Aider.' }, outilsActifs: [LANCER],
        plafonds: { maxAppelsOutils: 12, budgetMicroEur: 30_000 }, contactInconnu: 'tous',
      }),
      commissionPct: 0,
      outils: {
        catalogue: { byName: async (_t: string, _a: string, nom: string) => (nom === LANCER.name ? LANCER : null), listActifs: async () => [LANCER] } satisfies ToolCatalog,
        journal: { ouvrir: async () => 'j1', clore: async () => {} },
        resolveurs: { mba: resolveur },
        sessions: { compterAppel: async () => {} },
        executerGeste: GESTE_MUET,
      },
    });
    const ecritures: string[] = [];
    const fin: string[] = [];
    const m = make({
      brain,
      majRun: async (_t, runId) => { ecritures.push(runId); },
      sessions: {
        ...sessionsOk(),
        finirLeTour: async () => { fin.push('finirLeTour'); },
      } as unknown as RunTurnDeps['sessions'],
    });
    return { ...m, journal, ecritures, fin, appelsModele: () => appelsModele };
  }

  it('🔴 lancé : la session ne rappelle PAS le modèle, rien n’est envoyé, aucune sortie du bloc ne repart', async () => {
    const t = tour({ ok: true });
    expect(await runTurn(JOB, t.deps)).toEqual({ fait: 'scenario_lance' });
    // Le scénario FIXÉ, pas celui que le modèle a glissé dans ses arguments ; le parcours et la session du tour.
    expect(t.journal).toEqual([`lance:${WF_CIBLE}:${JOB.runId}:${JOB.sessionId}:${JOB.waId}`]);
    expect(t.appelsModele()).toBe(1);
    expect(t.envois).toEqual([]);
    expect(t.sorties).toEqual([]);
    expect(t.ecritures, 'aucune échéance reposée sur le parcours de l’agent').toEqual([]);
    expect(t.fin, 'la marque de tour n’est pas touchée : la session est déjà close').toEqual([]);
  });

  it('🔴 refusé (scénario dépublié) : la session CONTINUE, le modèle lit la raison et répond', async () => {
    const t = tour({ ok: false, raison: 'le scénario est vide' });
    expect(await runTurn(JOB, t.deps)).toMatchObject({ fait: 'repondu' });
    expect(t.appelsModele()).toBe(2);
    expect(t.envois).toEqual(['Je suis une IA.\n\nJe ne peux pas lancer ce parcours, je reste avec vous.']);
    expect(t.sorties).toEqual([]);
    expect(t.clotures).toEqual([]);
    // Le parcours attend toujours l'agent : son échéance d'inactivité est reposée, comme après toute réponse.
    expect(t.ecritures).toEqual([JOB.runId]);
  });
});
