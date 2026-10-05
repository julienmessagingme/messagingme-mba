import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { jamaisDesabonne } from './consentement';
import { avecGardesDEtatInertes, depsInertes } from './executeur-inerte';
import { bancDuFil, ESPACE, type OptionsBanc } from './banc-du-fil';
import { entrantsDe } from './webhook-fixtures';
import { creerDemarreurRepondeur, type DepsDemarreurRepondeur, type DemarreurRepondeur } from '../src/repondeur/demarrer';
import { grapheDuRepondeur } from '../src/repondeur/graphe';
import { WorkflowExecutor, type WorkflowExecutorDeps } from '../src/workflow/executor';
import { creerLancements, type DemandeDeLancement } from '../src/workflow/lancements';
import type { RunState, WorkflowRunRow } from '../src/workflow/run-store.pg';
import type { WorkflowGraph } from '../src/workflow/graph';
import type { AgentComplet, FicheAgent } from '../src/agent/agent-store';
import { ficheVide } from '../src/agent/fiche';
import type { AgentSession, AgentSessionStatus, AgentSessionStore } from '../src/agent/session-store';
import type { AgentTurnJob } from '../src/agent/turn-job';
import { runTurn, type RunTurnDeps } from '../src/agent/run-turn';
import { processRemiseMbaEntrant } from '../src/webhooks/remise-mba-entrant';
import { requalifierLesStandby } from '../src/webhooks/standby-hors-liste';
import { runControlSweep } from '../src/inbox/control-sweep';
import { unRepondeurRepond } from '../src/inbox/fil';

/**
 * LE RÉPONDEUR DÉMARRE SUR LE MESSAGE QUE PERSONNE NE TIENT (lot 5, A5, spec
 * `docs/superpowers/specs/2026-10-04-repondeur-par-defaut-design.md`, § 5).
 *
 * Le démarreur (`src/repondeur/demarrer.ts`) décide si l'agent PEUT répondre, puis le lance ; la remise « personne ne
 * suit » (`src/inbox/fil.ts`) l'appelle après LES MÊMES gardes, dans le même ordre, que vers l'agent de Meta. Les cas
 * tournent sur le vrai module du fil (`bancDuFil`) et, de bout en bout, sur le vrai exécuteur et les vrais lancements.
 */

afterEach(() => { vi.restoreAllMocks(); });

const WA = '33611223344';
const AGENT = 'ag-1';

const agentActif = (o: Partial<AgentComplet> = {}): AgentComplet => ({
  id: AGENT, label: 'Léa', status: 'active', mentionIa: 'IA.', modele: 'm', maxTours: 8, maxAppelsOutils: 12,
  budgetMicroEur: 30_000, inactiviteMinutes: 30, contactInconnu: 'tous',
  contenu: { ...ficheVide(), sorties: [{ code: 'rdv_pris', label: 'Rendez-vous pris' }] }, ficheVersion: 1, ...o,
});

/** Le démarreur, sur des dépendances qui notent ce qu'on leur demande. */
function demarreur(o: { gateway?: boolean; agent?: AgentComplet | null; solde?: number; lancement?: true | string } = {}) {
  const journal: string[] = [];
  const demandes: DemandeDeLancement[] = [];
  const deps: DepsDemarreurRepondeur = {
    agents: { complet: async (_t, id) => { journal.push(`agent:${id}`); return o.agent === undefined ? agentActif() : o.agent; } },
    credits: { solde: async () => { journal.push('solde'); return o.solde ?? 1_000_000; } },
    scenarios: { assurerScenarioSysteme: async (_t, s) => { journal.push(`ancre:${s}`); return 'w-sys'; } },
    lancements: { lancer: (async (d: DemandeDeLancement) => { journal.push(`lancer:${d.type}`); demandes.push(d); return o.lancement ?? true; }) as DepsDemarreurRepondeur['lancements']['lancer'] },
    gatewayDisponible: o.gateway ?? true,
    alerteCredit: { alerter: async (t) => { journal.push(`alerte:${t}`); } },
  };
  return { d: creerDemarreurRepondeur(deps), journal, demandes };
}

describe('le démarreur : l’agent peut-il répondre ?', () => {
  it('🔴 oui : l’ancre du scénario système, puis UN lancement `repondeur` sur le graphe de l’agent, fenêtre prouvée', async () => {
    const m = demarreur();
    expect(await m.d.demarrer(ESPACE, WA, { agentId: AGENT, messageDeclencheur: 'wamid.1' })).toBe('parti');
    expect(m.journal).toEqual([`agent:${AGENT}`, 'solde', 'ancre:repondeur', 'lancer:repondeur']);
    expect(m.demandes).toEqual([{
      type: 'repondeur', tenantId: ESPACE, workflowId: 'w-sys', waId: WA, fenetreOuverte: true, messageDeclencheur: 'wamid.1',
      graphe: grapheDuRepondeur({ id: AGENT, sorties: [{ code: 'rdv_pris', label: 'Rendez-vous pris' }] }),
    }]);
  });

  it('🔴 crédit épuisé (nul ou négatif) : RIEN ne démarre, ni parcours ni session, et l’alerte part', async () => {
    for (const solde of [0, -500]) {
      const m = demarreur({ solde });
      expect(await m.d.demarrer(ESPACE, WA, { agentId: AGENT, messageDeclencheur: null })).toBe('credit_epuise');
      expect(m.journal).toEqual([`agent:${AGENT}`, 'solde', `alerte:${ESPACE}`]);
    }
  });

  it('modèle absent sur l’instance : indisponible, sans rien lire', async () => {
    const m = demarreur({ gateway: false });
    expect(await m.d.demarrer(ESPACE, WA, { agentId: AGENT, messageDeclencheur: null })).toBe('indisponible');
    expect(m.journal).toEqual([]);
  });

  it('agent supprimé, en brouillon ou désactivé entre le réglage et ce message : indisponible', async () => {
    for (const agent of [null, agentActif({ status: 'draft' }), agentActif({ status: 'disabled' })]) {
      const m = demarreur({ agent });
      expect(await m.d.demarrer(ESPACE, WA, { agentId: AGENT, messageDeclencheur: null })).toBe('indisponible');
      expect(m.journal).toEqual([`agent:${AGENT}`]);
    }
  });

  it('un lancement refusé (fil d’un opérateur, numéro délié) : refuse', async () => {
    const m = demarreur({ lancement: 'la conversation est tenue par un opérateur' });
    expect(await m.d.demarrer(ESPACE, WA, { agentId: AGENT, messageDeclencheur: null })).toBe('refuse');
  });
});

/** Un espace dont l'agent IA est le répondeur : l'agent de Meta éteint, comme le CHECK d'une seule voix l'impose. */
const repondeur = (o: OptionsBanc = {}) => bancDuFil({ mbaEnabled: false, repondeurAgentId: AGENT, ...o });
const MSG = 'Bonjour, vous livrez à Lyon ?';
const entree = (o: { rouverte?: boolean; redelivre?: boolean } = {}) => ({ rouverte: o.rouverte ?? false, messageDeclencheur: 'wamid.1', redelivre: o.redelivre ?? false });

describe('la remise « personne ne suit » démarre le répondeur IA, après les mêmes gardes que l’agent de Meta', () => {
  it('🔴 sans répondeur, rien ne change : l’agent de Meta reçoit le message, le démarreur n’est jamais appelé', async () => {
    const b = bancDuFil({ conversations: { w: { owner: 'app_workflow' } } });
    await b.fil.remettreSiPersonneNeSuit(ESPACE, 'w', MSG, entree());
    expect(b.appels).toEqual(['ajout:w', 'release:w', 'evenement:w']);
    expect(b.demarrages).toEqual([]);
  });

  it('🔴 un entrant non pris démarre l’agent IA UNE fois, avec le dernier message ; Meta n’est jamais appelé', async () => {
    const b = repondeur({ conversations: { w: { owner: 'app_workflow' } } });
    await b.fil.remettreSiPersonneNeSuit(ESPACE, 'w', MSG, entree());
    expect(b.demarrages).toEqual([{ waId: 'w', agentId: AGENT, messageDeclencheur: 'wamid.1' }]);
    expect(b.appels).toEqual([]);
  });

  /** Les gardes, une par une : chacune laisse le contact sans démarrer l'agent. */
  const GARDES: Array<{ nom: string; o: OptionsBanc; e?: Parameters<typeof entree>[0] }> = [
    { nom: 'un parcours attend la réponse du contact', o: { enAttente: true } },
    { nom: 'un opérateur tient le fil, dans son délai de reprise', o: { conversations: { w: { owner: 'app_human' } } } },
    { nom: 'le contact a dit STOP', o: { desabonnes: ['w'] } },
    { nom: 'le contact est bloqué', o: { bloques: ['w'] } },
    { nom: 'une conversation de test, sur ce chemin automatique', o: { conversations: { w: { owner: 'app_workflow', test: true } } } },
    { nom: 'aucun numéro connecté', o: { numero: null } },
    { nom: 'un message redélivré par Meta', o: {}, e: { redelivre: true } },
  ];
  for (const g of GARDES) {
    it(`🔴 ${g.nom} : l’agent IA ne démarre pas, le fil ne bouge pas`, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const b = repondeur({ conversations: { w: { owner: 'app_workflow' } }, ...g.o });
      const avant = b.etat('w')?.owner;
      await b.fil.remettreSiPersonneNeSuit(ESPACE, 'w', MSG, entree(g.e));
      expect(b.demarrages).toEqual([]);
      expect(b.etat('w')?.owner).toBe(avant);
      expect(b.appels).toEqual([]);
    });
  }

  it('🔴 un fil de l’équipe dont le délai est ÉCOULÉ revient aux robots, PUIS l’agent IA démarre', async () => {
    // `changedAt: null` : une bascule non datée, donc délai échu (la règle du balayage).
    const b = repondeur({ conversations: { w: { owner: 'app_human', changedAt: null } } });
    await b.fil.remettreSiPersonneNeSuit(ESPACE, 'w', MSG, entree());
    expect(b.ecritures.map((e) => e.owner)).toEqual(['app_workflow']);
    expect(b.demarrages).toHaveLength(1);
  });

  it('un fil de l’équipe ESCALADÉ (le client attend un humain) ne lui est jamais repris, même délai écoulé', async () => {
    const b = repondeur({ conversations: { w: { owner: 'app_human', changedAt: null, escaladeeLe: new Date() } } });
    await b.fil.remettreSiPersonneNeSuit(ESPACE, 'w', MSG, entree());
    expect(b.demarrages).toEqual([]);
    expect(b.etat('w')?.owner).toBe('app_human');
  });

  it('🔴 crédit épuisé : la conversation passe à l’équipe avec une demande, cause « crédit IA épuisé »', async () => {
    const b = repondeur({ conversations: { w: { owner: 'app_workflow' } }, demarrage: 'credit_epuise' });
    await b.fil.remettreSiPersonneNeSuit(ESPACE, 'w', MSG, entree());
    expect(b.etat('w')?.owner).toBe('app_human');
    expect(b.ecritures.at(-1)?.opts).toMatchObject({ par: { cause: 'automatique : crédit IA épuisé, le répondeur automatique ne peut pas répondre' }, ouvreUneDemande: true });
  });

  it('indisponible, refusé, ou un démarreur qui LÈVE : à l’équipe aussi (le client n’attend pas un robot qui ne viendra pas)', async () => {
    for (const demarrage of ['indisponible', 'refuse'] as const) {
      const b = repondeur({ conversations: { w: { owner: 'app_workflow' } }, demarrage });
      await b.fil.remettreSiPersonneNeSuit(ESPACE, 'w', MSG, entree());
      expect(b.etat('w')?.owner, demarrage).toBe('app_human');
    }
    const b = repondeur({ conversations: { w: { owner: 'app_workflow' } }, demarrage: new Error('base indisponible') });
    await expect(b.fil.remettreSiPersonneNeSuit(ESPACE, 'w', MSG, entree())).rejects.toThrow('base indisponible');
    expect(b.etat('w')?.owner).toBe('app_human');
  });

  it('une réouverture d’un fil que l’équipe tient encore ouvre une demande, sans démarrer l’agent (comme avant)', async () => {
    const b = repondeur({ conversations: { w: { owner: 'app_human' } } });
    await b.fil.remettreSiPersonneNeSuit(ESPACE, 'w', MSG, entree({ rouverte: true }));
    expect(b.demandes).toHaveLength(1);
    expect(b.demarrages).toEqual([]);
  });
});

describe('ce que la remise dit au répondeur : le dernier message, et la redélivrance', () => {
  const LOT = (messages: Array<{ id: string; body: string }>): unknown => ({
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba1', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp', metadata: { display_phone_number: '33525680250', phone_number_id: 'pn1' },
      messages: messages.map((m) => ({ from: WA, id: m.id, timestamp: '1789465356', type: 'text', text: { body: m.body } })),
    } }] }],
  });
  const remises = () => {
    const vues: Array<{ waId: string; contenu: string; entree: unknown }> = [];
    return { vues, deps: { remettre: async (_t: string, waId: string, contenu: string, e: unknown) => { vues.push({ waId, contenu, entree: e }); } } };
  };

  it('🔴 deux messages du même contact dans un lot : UNE remise, le DERNIER message nommé', async () => {
    const r = remises();
    await processRemiseMbaEntrant(await entrantsDe(LOT([{ id: 'wamid.1', body: 'Bonjour' }, { id: 'wamid.2', body: 'Vous livrez ?' }])), r.deps);
    expect(r.vues).toEqual([{ waId: WA, contenu: 'Bonjour\nVous livrez ?', entree: { rouverte: false, messageDeclencheur: 'wamid.2', redelivre: false } }]);
  });

  it('🔴 redélivré : seulement si TOUS ses messages étaient déjà connus ; un seul neuf suffit à ce qu’on lui réponde', async () => {
    const r = remises();
    const lot = await entrantsDe(LOT([{ id: 'wamid.1', body: 'a' }, { id: 'wamid.2', body: 'b' }]));
    await processRemiseMbaEntrant(lot, r.deps, undefined, undefined, new Set(['wamid.1', 'wamid.2']));
    await processRemiseMbaEntrant(lot, r.deps, undefined, undefined, new Set(['wamid.1']));
    expect(r.vues.map((v) => (v.entree as { redelivre: boolean }).redelivre)).toEqual([true, false]);
  });
});

/** Les parcours et les sessions en mémoire, pour le bout en bout. */
function moteur() {
  const lignes: WorkflowRunRow[] = [];
  const runs = avecGardesDEtatInertes({
    start: async (t: string, w: string, waId: string, _c: string | null, s: RunState, fige: WorkflowGraph | null) => {
      const id = `r${lignes.length + 1}`;
      lignes.push({ id, workflowId: w, tenantId: t, waId, currentNode: s.currentNode, status: s.status, lastMessageId: s.lastMessageId ?? null, grapheFige: fige });
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
    closeActiveByWaId: async (t: string, waId: string) => {
      const ids: string[] = [];
      for (const l of lignes) if (l.tenantId === t && l.waId === waId && (l.status === 'waiting' || l.status === 'sleeping')) { l.status = 'done'; ids.push(l.id); }
      return ids;
    },
  });
  const sessions: AgentSession[] = [];
  const agentSessions = {
    byRun: async (_t: string, runId: string) => sessions.find((s) => s.runId === runId && s.status === 'en_cours') ?? null,
    open: async (i: { tenantId: string; runId: string; agentId: string; nodeId: string; waId: string }) => {
      const s: AgentSession = { id: `s${sessions.length + 1}`, ...i, tours: 0, appelsOutils: 0, coutMicroEur: 0, status: 'en_cours', ouvertLe: '2026-10-05T10:00:00.000Z' };
      sessions.push(s);
      return s;
    },
    clore: async (_t: string, id: string, status: AgentSessionStatus) => { const s = sessions.find((x) => x.id === id); if (s) s.status = status; },
  } as unknown as AgentSessionStore;
  return { lignes, runs, sessions, agentSessions };
}

/** Une campagne à scénario : un modèle à boutons, qui attend un choix. */
const CAMPAGNE: WorkflowGraph = {
  nodes: [{ id: 'tpl', type: 'template', position: { x: 0, y: 0 }, data: { templateName: 'rentree', language: 'fr', templateButtons: [{ type: 'QUICK_REPLY', text: 'Oui' }] } }],
  edges: [],
};

/**
 * Le fil, l'exécuteur, les lancements et le VRAI démarreur, branchés comme le socle le fait (liaison tardive : le fil
 * est construit avant l'exécuteur). Le contact écrit dans un espace sans scénario, l'agent IA répond.
 */
function bout() {
  const mo = moteur();
  const jobs: AgentTurnJob[] = [];
  let branche: DemarreurRepondeur | null = null;
  const b = repondeur({
    conversations: { [WA]: { owner: 'app_workflow' } },
    parcours: { findWaitingByWaId: (t, w) => mo.runs.findWaitingByWaId(t, w) },
    repondeur: { demarrer: (t, w, o) => { if (!branche) throw new Error('non branché'); return branche.demarrer(t, w, o); } },
  });
  const deps: WorkflowExecutorDeps = {
    ...depsInertes,
    estDesabonne: jamaisDesabonne,
    runs: mo.runs,
    // Le scénario d'une campagne se relit ; celui du répondeur, jamais (son parcours porte son graphe figé).
    getGraph: async (id) => (id === 'wf-campagne' ? CAMPAGNE : null),
    applyTag: async () => true, setField: async () => {}, removeTag: async () => {}, clearField: async () => {},
    sendTemplate: async () => {}, sendQuickMessage: async () => {}, sendFlow: async () => {}, sendQuestion: async () => {},
    agentSessions: mo.agentSessions,
    enqueueAgentTurn: async (j) => { jobs.push(j); },
    mayAct: b.fil.peutAgir,
    reclaimControl: b.fil.reprendrePourLApp,
    // Le câblage réel (`src/workflow/wiring.ts`).
    confierAuRepondeur: (t, w, id) => b.fil.remettreSiPersonneNeSuit(t, w, '', { rouverte: false, messageDeclencheur: id }),
  };
  const executor = new WorkflowExecutor(deps);
  const lancements = creerLancements({ executor, scenarios: { getById: async () => null }, contacts: { findIdByWaId: async () => 'c-1' } });
  branche = creerDemarreurRepondeur({
    agents: { complet: async () => agentActif() },
    credits: { solde: async () => 1_000_000 },
    scenarios: { assurerScenarioSysteme: async () => 'w-sys' },
    lancements,
    gatewayDisponible: true,
    alerteCredit: { alerter: async () => {} },
  });
  /**
   * Un job de webhook, dans l'ordre du handler : l'avance des parcours, puis la remise de ce qu'aucun n'a pris
   * (`src/webhooks/handler.ts`). `dejaVus` : ce que Meta avait déjà livré.
   */
  const job = async (messages: Array<{ id: string; body: string }>, dejaVus: ReadonlySet<string> = new Set()) => {
    const entrants = await entrantsDe({
      object: 'whatsapp_business_account',
      entry: [{ id: 'waba1', changes: [{ field: 'messages', value: {
        messaging_product: 'whatsapp', metadata: { display_phone_number: '33525680250', phone_number_id: 'pn1' },
        messages: messages.map((m) => ({ from: WA, id: m.id, timestamp: '1789465356', type: 'text', text: { body: m.body } })),
      } }] }],
    });
    const pris = new Set<string>();
    for (const { message: m } of entrants) {
      if (await mo.runs.findWaitingByWaId(ESPACE, WA)) { await executor.advance(ESPACE, WA, m.messageId, null); pris.add(m.messageId); }
    }
    await processRemiseMbaEntrant(entrants, { remettre: b.fil.remettreSiPersonneNeSuit }, pris, new Set(), dejaVus);
  };
  return { b, mo, jobs, executor, job };
}

describe('🔴 de bout en bout : un espace sans scénario, l’agent IA répond', () => {
  it('le premier message démarre le répondeur : un parcours, une session, UN tour, le fil aux robots', async () => {
    const m = bout();
    await m.job([{ id: 'wamid.1', body: 'Bonjour' }]);
    expect(m.mo.lignes).toHaveLength(1);
    expect(m.mo.sessions).toHaveLength(1);
    expect(m.jobs.map((j) => j.raison)).toEqual(['demarrage']);
    expect(m.b.etat(WA)?.owner).toBe('app_workflow');
  });

  it('🔴 cas 1 de la revue : deux messages coup sur coup, dans un même lot ou deux jobs : UN parcours, UN démarrage', async () => {
    const lot = bout();
    await lot.job([{ id: 'wamid.1', body: 'Bonjour' }, { id: 'wamid.2', body: 'Vous livrez ?' }]);
    expect(lot.mo.lignes).toHaveLength(1);
    expect(lot.jobs.map((j) => j.raison)).toEqual(['demarrage']);

    const deux = bout();
    await deux.job([{ id: 'wamid.1', body: 'Bonjour' }]);
    await deux.job([{ id: 'wamid.2', body: 'Vous livrez ?' }]);
    expect(deux.mo.lignes, 'le second ne démarre rien : un parcours attend déjà').toHaveLength(1);
    // Le second message est pour le parcours en cours : un tour de plus, que le verrou optimiste des tours (même
    // compteur `tours`) fond avec le premier s'il n'a pas encore tourné.
    expect(deux.jobs.map((j) => [j.raison, j.tours])).toEqual([['demarrage', 0], ['message', 0]]);
  });

  it('🔴 un message REDÉLIVRÉ par Meta ne démarre rien et n’enfile aucun tour', async () => {
    const m = bout();
    await m.job([{ id: 'wamid.1', body: 'Bonjour' }]);
    await m.job([{ id: 'wamid.1', body: 'Bonjour' }], new Set(['wamid.1']));
    expect(m.mo.lignes).toHaveLength(1);
    expect(m.jobs.map((j) => j.raison)).toEqual(['demarrage']);
  });

  it('🔴 un message redélivré APRÈS la fin du parcours (l’agent a conclu) ne relance pas l’agent', async () => {
    const m = bout();
    await m.job([{ id: 'wamid.1', body: 'Bonjour' }]);
    await m.executor.sortirDuBlocAgent(ESPACE, WA, 's1', 'rdv_pris');
    expect(m.mo.lignes[0]?.status).toBe('done');
    await m.job([{ id: 'wamid.1', body: 'Bonjour' }], new Set(['wamid.1']));
    expect(m.mo.lignes, 'aucun second parcours').toHaveLength(1);
    // Le message suivant, neuf, relance l'agent : « le prochain message relance l'agent ».
    await m.job([{ id: 'wamid.2', body: 'Et demain ?' }]);
    expect(m.mo.lignes).toHaveLength(2);
    expect(m.jobs.map((j) => j.raison)).toEqual(['demarrage', 'demarrage']);
  });

  /**
   * 🔴 « L'AGENT DE META PREND LA MAIN » DES CAMPAGNES MÈNE AU RÉPONDEUR, QUEL QU'IL SOIT (spec, § 5). Le contact répond
   * « à côté » d'un modèle de campagne : le parcours finit, et l'avance a reçu son message, donc la remise du même job
   * le lui laisse. Avec l'agent de Meta, la fin du parcours le lui transmet ; agent de Meta éteint, c'est le répondeur
   * IA qui doit le recevoir, sinon personne ne répond.
   */
  it('🔴 une réponse « à côté » d’un modèle de campagne : le parcours finit, et le répondeur IA démarre sur ce message', async () => {
    const m = bout();
    expect(await m.executor.demarrer('campagne_scenario', ESPACE, 'wf-campagne', CAMPAGNE, { waId: WA, contactId: 'c-1' })).toBe(true);
    await m.job([{ id: 'wamid.c', body: 'Je ne comprends pas, c’est pour quoi ?' }]);
    expect(m.mo.lignes.map((l) => [l.workflowId, l.status])).toEqual([['wf-campagne', 'done'], ['w-sys', 'waiting']]);
    expect(m.mo.lignes[1]?.lastMessageId).toBe('wamid.c');
    expect(m.jobs.map((j) => j.raison)).toEqual(['demarrage']);
  });

  /**
   * 🔴 CAS 4 DE LA REVUE. Un opérateur écrit pendant un tour : le tour finit en `main_perdue` sans rien envoyer, la
   * session reste vivante. L'opérateur rend la main (agent de Meta éteint : `app_workflow`), et le message suivant du
   * contact relance l'agent, par l'avance du parcours resté en attente.
   */
  it('🔴 cas 4 : un opérateur écrit pendant un tour, puis rend la main ; le message suivant relance l’agent', async () => {
    const m = bout();
    await m.job([{ id: 'wamid.1', body: 'Bonjour' }]);
    await m.b.fil.prisEnEcrivant(ESPACE, WA, { collaborateur: null });
    const envois: string[] = [];
    const session = (): AgentSession => ({ ...m.mo.sessions[0]!, tours: 1 });
    const fiche: FicheAgent = {
      id: AGENT, tenantId: ESPACE, mentionIa: 'IA.', mentionIaFrequence: 'jamais', modele: 'm', status: 'active',
      plafonds: { maxTours: 8, maxAppelsOutils: 12, budgetMicroEur: 30_000 }, inactiviteMinutes: 30, contactInconnu: 'tous',
    };
    const tour: RunTurnDeps = {
      sessions: {
        prendreLeTour: async () => session(), clore: async () => {}, ajouterAuTranscript: async () => {},
        ajouterCout: async () => {}, finirLeTour: async () => {}, sortieAppliquee: async () => {},
      },
      brain: { penser: async () => ({ texte: 'Bonjour, que puis-je pour vous ?', sortie: null }) },
      lireRun: async (_t, id) => { const l = m.mo.lignes.find((x) => x.id === id); return l ? { status: l.status, currentNode: l.currentNode } : null; },
      agents: { byId: async () => fiche },
      mayAct: m.b.fil.peutAgir,
      estDesabonne: jamaisDesabonne,
      envoyer: async (_t, _w, texte) => { envois.push(texte); },
    };
    expect(await runTurn(m.jobs[0]!, tour)).toMatchObject({ fait: 'main_perdue' });
    expect(envois).toEqual([]);
    expect(await m.b.fil.rendreLaMain(ESPACE, WA, { collaborateur: null })).toBe('app_workflow');
    await m.job([{ id: 'wamid.2', body: 'Toujours là ?' }]);
    expect(m.jobs.map((j) => j.raison)).toEqual(['demarrage', 'message']);
    expect(m.mo.lignes, 'le même parcours, aucun second démarrage').toHaveLength(1);
  });
});

describe('les autres gestes, agent de Meta éteint par le CHECK : le fil reste aux robots, le prochain message relance', () => {
  it('« Rendre la main » écrit `app_workflow`, sans aucun appel à Meta', async () => {
    const b = repondeur({ conversations: { w: { owner: 'app_human' } } });
    expect(await b.fil.rendreLaMain(ESPACE, 'w', { collaborateur: null })).toBe('app_workflow');
    expect(b.appels).toEqual([]);
  });

  it('la fin d’un parcours ne rend rien à Meta (l’exécuteur ne l’appelle pas, agent de Meta éteint)', async () => {
    const rendus: string[] = [];
    const ex = new WorkflowExecutor({
      ...depsInertes, estDesabonne: jamaisDesabonne,
      runs: avecGardesDEtatInertes({ start: async () => ({ id: 'r1' }), findWaitingByWaId: async () => null, setState: async () => {}, closeActiveByWaId: async () => [] }),
      getGraph: async () => null, applyTag: async () => true, setField: async () => {}, removeTag: async () => {}, clearField: async () => {},
      sendTemplate: async () => {}, sendQuickMessage: async () => {}, sendFlow: async () => {}, sendQuestion: async () => {},
      releaseToMba: async (_t, w) => { rendus.push(w); },
    });
    const g: WorkflowGraph = { nodes: [{ id: 't', type: 'tag', position: { x: 0, y: 0 }, data: { tag: 'vu' } }], edges: [] };
    expect(await ex.demarrer('repondeur', ESPACE, 'w-sys', g, { waId: 'w', contactId: null }, { depuis: 'entree', fenetreOuverte: true })).toBe(true);
    expect(rendus).toEqual([]);
  });

  it('le balayage laisse tel quel un fil `app_workflow` ancien : il n’y a pas d’agent de Meta à qui le rendre', async () => {
    const b = repondeur({ conversations: { w: { owner: 'app_workflow', changedAt: null } } });
    const rendues = await runControlSweep({
      inbox: { listHeldControl: async () => [{ tenantId: ESPACE, waId: 'w', owner: 'app_workflow', changedAt: null, escaladee: false, lastMessageAt: new Date() }] },
      fil: b.fil,
      reglages: { mbaActifParTenant: async () => new Set<string>() },
      timeouts: { app_human: 7_200_000, mba: 86_400_000, app_workflow: 86_400_000 },
    });
    expect(rendues).toBe(0);
    expect(b.ecritures).toEqual([]);
    expect(b.appels).toEqual([]);
  });
});

/**
 * 🔴 CAS 2 DE LA REVUE, la moitié de la réception. Après la désignation, Meta peut croire encore tenir le fil d'un
 * contact qu'il servait : son message arrive en `standby`, que toutes nos étapes ignorent. Retiré de la liste par la
 * bascule, il est requalifié en `messages`, et le répondeur IA lui répond. Sans répondeur, un `standby` reste ce qu'il
 * est : une autre application tient le fil.
 */
describe('un `standby` arrivé après la bascule n’est pas perdu', () => {
  const STANDBY = {
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba1', changes: [{ field: 'standby', value: {
      messaging_product: 'whatsapp', metadata: { display_phone_number: '33525680250', phone_number_id: 'pn1' },
      messages: [{ from: WA, id: 'wamid.S', timestamp: '1789465356', type: 'text', text: { body: 'Allô ?' } }],
    } }] }],
  };

  it('🔴 répondeur IA désigné, contact absent de la liste : le `standby` devient un `messages`', async () => {
    const liste = { agentAllume: async () => unRepondeurRepond({ mbaEnabled: false, repondeurAgentId: AGENT }), presents: async () => new Set<string>() };
    const [e] = await requalifierLesStandby(await entrantsDe(STANDBY), liste);
    expect(e?.message.field).toBe('messages');
  });

  it('aucun répondeur : le `standby` reste un `standby`', async () => {
    const liste = { agentAllume: async () => unRepondeurRepond({ mbaEnabled: false, repondeurAgentId: null }), presents: async () => new Set<string>() };
    const [e] = await requalifierLesStandby(await entrantsDe(STANDBY), liste);
    expect(e?.message.field).toBe('standby');
  });

  it('🔴 et le worker câble la requalification sur cette question, pas sur le seul agent de Meta', () => {
    // `src/worker.ts` démarre un processus quand on l'importe : son câblage se lit dans sa source.
    const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
    expect(worker).toContain('agentAllume: async (t) => unRepondeurRepond(await settingsStore.get(t)),');
  });
});
