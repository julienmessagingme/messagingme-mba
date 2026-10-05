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
import { processWorkflowAdvance } from '../src/webhooks/workflow-advance';
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
const entree = (o: { rouverte?: boolean; redelivre?: boolean; reactionsSeules?: boolean } = {}) => ({
  rouverte: o.rouverte ?? false, messageDeclencheur: 'wamid.1', redelivre: o.redelivre ?? false, reactionsSeules: o.reactionsSeules ?? false,
});

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
    // Relecture du lot 5, J1 : un pouce levé (ou son retrait) n'appelle pas de réponse, comme chez l'agent de Meta.
    { nom: 'rien que des réactions', o: {}, e: { reactionsSeules: true } },
    // 🔴 JB2 (RS1) : la garde passe AVANT la bascule `app_human -> app_workflow`. Après, un pouce posé une fois le délai
    // de l'équipe écoulé sortirait la conversation d'« À traiter » sans que personne ne réponde.
    { nom: 'rien que des réactions, sur un fil de l’équipe au délai écoulé', o: { conversations: { w: { owner: 'app_human', changedAt: null } } }, e: { reactionsSeules: true } },
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

/**
 * Un message du contact tel que Meta l'envoie : un texte, ou une RÉACTION (un emoji posé sur un de nos messages,
 * `vise`). `reaction: ''` est un retrait de réaction ; `vise: null`, une réaction sans identifiant du message visé.
 */
type MessageDuLot = { id: string; body: string } | { id: string; reaction: string; vise?: string | null } | { id: string; sansTexte: keyof typeof SANS_TEXTE };
const POUCE = String.fromCodePoint(0x1f44d);
/**
 * Des messages SANS TEXTE qui ne sont pas des réactions : `contentOf` rend `body: null` pour une fiche de contact, une
 * commande du catalogue ou un type que Meta ne sait pas transmettre. Le client a écrit quelque chose, on lui doit une
 * réponse : c'est ce qui interdit de reconnaître une réaction à son texte vide.
 */
const SANS_TEXTE = {
  contacts: { contacts: [{ name: { formatted_name: 'Léa Martin' }, phones: [{ phone: '+33 6 00 00 00 00' }] }] },
  order: { order: { catalog_id: 'cat-1', product_items: [{ product_retailer_id: 'sku-1', quantity: 1, item_price: 12, currency: 'EUR' }] } },
  unsupported: { errors: [{ code: 131051, title: 'Message type unknown' }] },
} as const;
const messageMeta = (m: MessageDuLot): Record<string, unknown> => {
  const base = { from: WA, id: m.id, timestamp: '1789465356' };
  if ('reaction' in m) return { ...base, type: 'reaction', reaction: { ...(m.vise === null ? {} : { message_id: m.vise ?? 'wamid.out' }), emoji: m.reaction } };
  if ('sansTexte' in m) return { ...base, type: m.sansTexte, ...SANS_TEXTE[m.sansTexte] };
  return { ...base, type: 'text', text: { body: m.body } };
};
const LOT = (messages: MessageDuLot[]): unknown => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'waba1', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { display_phone_number: '33525680250', phone_number_id: 'pn1' },
    messages: messages.map(messageMeta),
  } }] }],
});

describe('ce que la remise dit au répondeur : le dernier message, la redélivrance, les réactions', () => {
  const remises = () => {
    const vues: Array<{ waId: string; contenu: string; entree: unknown }> = [];
    return { vues, deps: { remettre: async (_t: string, waId: string, contenu: string, e: unknown) => { vues.push({ waId, contenu, entree: e }); } } };
  };

  it('🔴 deux messages du même contact dans un lot : UNE remise, le DERNIER message nommé', async () => {
    const r = remises();
    await processRemiseMbaEntrant(await entrantsDe(LOT([{ id: 'wamid.1', body: 'Bonjour' }, { id: 'wamid.2', body: 'Vous livrez ?' }])), r.deps);
    expect(r.vues).toEqual([{
      waId: WA, contenu: 'Bonjour\nVous livrez ?', entree: { rouverte: false, messageDeclencheur: 'wamid.2', redelivre: false, reactionsSeules: false },
    }]);
  });

  /**
   * 🔴 RELECTURE DU LOT 5, J1 : UNE RÉACTION SE RECONNAÎT À SON TYPE. Un pouce levé, ou son retrait (emoji vide), n'a
   * pas de texte ; mais la réponse « à côté » d'un parcours qui finit n'en a pas non plus quand elle arrive à la remise.
   * Seul le type sépare les deux.
   */
  it('🔴 rien que des réactions (un pouce, puis son retrait) : `reactionsSeules`', async () => {
    const r = remises();
    await processRemiseMbaEntrant(await entrantsDe(LOT([{ id: 'wamid.r1', reaction: POUCE }, { id: 'wamid.r2', reaction: '' }])), r.deps);
    expect(r.vues).toEqual([{ waId: WA, contenu: '', entree: { rouverte: false, messageDeclencheur: 'wamid.r2', redelivre: false, reactionsSeules: true } }]);
  });

  it('🔴 JB2 (RS3) : un message SANS TEXTE qui n’est pas une réaction (contact, commande, type inconnu) n’est pas `reactionsSeules`', async () => {
    for (const sansTexte of Object.keys(SANS_TEXTE) as Array<keyof typeof SANS_TEXTE>) {
      const r = remises();
      await processRemiseMbaEntrant(await entrantsDe(LOT([{ id: 'wamid.v', sansTexte }])), r.deps);
      expect(r.vues, sansTexte).toEqual([{ waId: WA, contenu: '', entree: { rouverte: false, messageDeclencheur: 'wamid.v', redelivre: false, reactionsSeules: false } }]);
    }
  });

  it('🔴 un texte et une réaction : on lui doit une réponse, et le déclencheur est le TEXTE, même suivi d’une réaction', async () => {
    const r = remises();
    await processRemiseMbaEntrant(await entrantsDe(LOT([{ id: 'wamid.1', body: 'Merci' }, { id: 'wamid.r', reaction: POUCE }])), r.deps);
    expect(r.vues).toEqual([{ waId: WA, contenu: 'Merci', entree: { rouverte: false, messageDeclencheur: 'wamid.1', redelivre: false, reactionsSeules: false } }]);
  });

  it('🔴 redélivré : seulement si TOUS ses messages étaient déjà connus ; un seul neuf suffit à ce qu’on lui réponde', async () => {
    const r = remises();
    const lot = await entrantsDe(LOT([{ id: 'wamid.1', body: 'a' }, { id: 'wamid.2', body: 'b' }]));
    await processRemiseMbaEntrant(lot, r.deps, undefined, undefined, new Set(['wamid.1', 'wamid.2']));
    await processRemiseMbaEntrant(lot, r.deps, undefined, undefined, new Set(['wamid.1']));
    expect(r.vues.map((v) => (v.entree as { redelivre: boolean }).redelivre)).toEqual([true, false]);
  });
});

/**
 * Les parcours et les sessions en mémoire, pour le bout en bout. `resumeAt` est gardé comme la base le garde : écrit
 * à chaque `setState`, SANS coalesce (`resume_at = $7`), donc un état écrit sans échéance l'efface.
 */
function moteur() {
  const lignes: (WorkflowRunRow & { resumeAt: Date | null })[] = [];
  const runs = avecGardesDEtatInertes({
    start: async (t: string, w: string, waId: string, _c: string | null, s: RunState, fige: WorkflowGraph | null) => {
      const id = `r${lignes.length + 1}`;
      lignes.push({ id, workflowId: w, tenantId: t, waId, currentNode: s.currentNode, status: s.status, lastMessageId: s.lastMessageId ?? null, grapheFige: fige, resumeAt: s.resumeAt ?? null });
      return { id };
    },
    findWaitingByWaId: async (t: string, waId: string) => [...lignes].reverse().find((l) => l.tenantId === t && l.waId === waId && l.status === 'waiting') ?? null,
    setState: async (id: string, s: RunState) => {
      const l = lignes.find((x) => x.id === id);
      if (!l) return;
      l.currentNode = s.currentNode;
      l.status = s.status;
      if (s.lastMessageId !== undefined) l.lastMessageId = s.lastMessageId;
      l.resumeAt = s.resumeAt ?? null;
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

/** La même campagne, dont toute réponse libre pose une étiquette puis finit, sans rien envoyer. */
const CAMPAGNE_SUITE: WorkflowGraph = {
  nodes: [...CAMPAGNE.nodes, { id: 'vu', type: 'tag', position: { x: 0, y: 0 }, data: { tag: 'a-repondu' } }],
  edges: [{ id: 'e1', source: 'tpl', target: 'vu' }],
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
    getGraph: async (id) => (id === 'wf-campagne' ? CAMPAGNE : id === 'wf-suite' ? CAMPAGNE_SUITE : null),
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
   * (`src/webhooks/handler.ts`). `dejaVus` : ce que Meta avait déjà livré. L'avance passe par la vraie porte
   * (`processWorkflowAdvance`, qui lit le TYPE du message) et par le câblage du worker, recopié ici parce que
   * `src/worker.ts` ne se monte pas : sa source est relue plus bas.
   */
  const job = async (messages: MessageDuLot[], dejaVus: ReadonlySet<string> = new Set()) => {
    const entrants = await entrantsDe(LOT(messages));
    const pris = await processWorkflowAdvance(entrants, {
      advance: async (t, w, id, bp, entrant) => {
        const enAttente = await mo.runs.findWaitingByWaId(t, w);
        await executor.advance(t, w, id, bp, 'whatsapp', entrant);
        return enAttente !== null;
      },
    });
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
      estRepondeur: async () => true,
      envoyer: async (_t, _w, texte) => { envois.push(texte); },
    };
    expect(await runTurn(m.jobs[0]!, tour)).toMatchObject({ fait: 'main_perdue' });
    expect(envois).toEqual([]);
    expect(await m.b.fil.rendreLaMain(ESPACE, WA, { collaborateur: null })).toBe('app_workflow');
    await m.job([{ id: 'wamid.2', body: 'Toujours là ?' }]);
    expect(m.jobs.map((j) => j.raison)).toEqual(['demarrage', 'message']);
    expect(m.mo.lignes, 'le même parcours, aucun second démarrage').toHaveLength(1);
  });

  /**
   * 🔴 RELECTURE DU LOT 5, J1 : UNE RÉACTION NE FAIT PAS PARLER L'AGENT IA. L'agent de Meta se tait sur un pouce levé ;
   * le répondeur aussi, en pleine conversation (l'avance du bloc agent) comme après sa conclusion (la remise). Sans
   * ça, un client qui met un pouce sur « votre rendez-vous est confirmé » recevait un nouveau message de l'IA, débité
   * du crédit, et chaque retrait de réaction aussi.
   */
  it('🔴 J1 : une réaction en pleine conversation, ou son retrait, n’enfile aucun tour ; le texte suivant, si', async () => {
    const m = bout();
    await m.job([{ id: 'wamid.1', body: 'Bonjour' }]);
    // Le premier tour a répondu et pose l'échéance d'inactivité, comme `majRun` (`src/worker.ts`) : une écriture
    // gardée sans jeton, que `restToState` remplit pour un agent qui attend.
    const echeance = new Date('2026-10-05T10:30:00.000Z');
    const run = m.mo.lignes[0]!;
    await m.mo.runs.setStateSiEncoreSur(ESPACE, run.id, run.currentNode, { currentNode: run.currentNode, status: 'waiting', resumeAt: echeance });
    await m.job([{ id: 'wamid.r1', reaction: POUCE, vise: 'wamid.out1' }]);
    await m.job([{ id: 'wamid.r2', reaction: '', vise: 'wamid.out1' }]);
    expect(m.jobs.map((j) => j.raison), 'ni le pouce ni son retrait ne réveillent l’agent').toEqual(['demarrage']);
    // 🔴 JB1 : aucun tour ne repose l'échéance après une réaction, donc elle doit SURVIVRE. Effacée, la sortie `timeout`
    // ne partait jamais : run et session vivants pour toujours après un pouce.
    expect(run.resumeAt, 'l’échéance d’inactivité survit à la réaction').toEqual(echeance);
    // Rien n'est écrit (la remise du même job les laisse au parcours, qui attend toujours) : le dernier message
    // consommé reste le texte, dont la redélivrance reste dédupliquée.
    expect(m.mo.lignes.map((l) => [l.status, l.lastMessageId])).toEqual([['waiting', 'wamid.1']]);
    await m.job([{ id: 'wamid.2', body: 'Et pour samedi ?' }]);
    expect(m.jobs.map((j) => j.raison)).toEqual(['demarrage', 'message']);
  });

  it('🔴 JB2 (RS3) : une fiche de contact, une commande ou un type inconnu, sans texte, démarre bien le répondeur', async () => {
    for (const sansTexte of Object.keys(SANS_TEXTE) as Array<keyof typeof SANS_TEXTE>) {
      const m = bout();
      await m.job([{ id: 'wamid.v', sansTexte }]);
      expect(m.mo.lignes.map((l) => [l.workflowId, l.status, l.lastMessageId]), sansTexte).toEqual([['w-sys', 'waiting', 'wamid.v']]);
      expect(m.jobs.map((j) => j.raison), sansTexte).toEqual(['demarrage']);
    }
  });

  it('🔴 J1 : une réaction après que l’agent a conclu ne relance rien ; le texte suivant, si', async () => {
    const m = bout();
    await m.job([{ id: 'wamid.1', body: 'Bonjour' }]);
    await m.executor.sortirDuBlocAgent(ESPACE, WA, 's1', 'rdv_pris');
    await m.job([{ id: 'wamid.r1', reaction: POUCE }]);
    await m.job([{ id: 'wamid.r2', reaction: '' }]);
    expect(m.mo.lignes, 'aucun second parcours').toHaveLength(1);
    expect(m.mo.sessions, 'aucune seconde session').toHaveLength(1);
    await m.job([{ id: 'wamid.2', body: 'Merci, et demain ?' }]);
    expect(m.mo.lignes).toHaveLength(2);
    expect(m.jobs.map((j) => j.raison)).toEqual(['demarrage', 'demarrage']);
  });

  it('🔴 J1 : une réaction « à côté » d’un modèle de campagne finit le parcours, sans être confiée au répondeur', async () => {
    // `vise: null` : sans identifiant du message visé, la réaction n'a pas de `buttonPayload`, exactement comme un
    // texte. Seul son type la distingue de la réponse « à côté » qu'on confie au répondeur.
    const m = bout();
    expect(await m.executor.demarrer('campagne_scenario', ESPACE, 'wf-campagne', CAMPAGNE, { waId: WA, contactId: 'c-1' })).toBe(true);
    await m.job([{ id: 'wamid.r', reaction: POUCE, vise: null }]);
    expect(m.mo.lignes.map((l) => [l.workflowId, l.status])).toEqual([['wf-campagne', 'done']]);
    expect(m.jobs).toEqual([]);
  });

  it('🔴 J1 : une réaction qui fait finir une chaîne sans réponse n’est pas confiée non plus', async () => {
    // L'autre sortie de l'avance : la chaîne suit son arête libre, ne répond rien, et finit. Un texte serait confié au
    // répondeur (la chaîne ne lui a rien répondu) ; une réaction, non.
    const m = bout();
    expect(await m.executor.demarrer('campagne_scenario', ESPACE, 'wf-suite', CAMPAGNE_SUITE, { waId: WA, contactId: 'c-1' })).toBe(true);
    await m.job([{ id: 'wamid.r', reaction: POUCE, vise: null }]);
    expect(m.mo.lignes.map((l) => [l.workflowId, l.status])).toEqual([['wf-suite', 'done']]);
    expect(m.jobs).toEqual([]);
    // Et le texte, lui, l'est : la garde porte sur le type, pas sur l'absence de réponse.
    const t = bout();
    await t.executor.demarrer('campagne_scenario', ESPACE, 'wf-suite', CAMPAGNE_SUITE, { waId: WA, contactId: 'c-1' });
    await t.job([{ id: 'wamid.t', body: 'Ok' }]);
    expect(t.mo.lignes.map((l) => [l.workflowId, l.status])).toEqual([['wf-suite', 'done'], ['w-sys', 'waiting']]);
  });
});

/**
 * 🔴 RELECTURE DU LOT 5, J4 : DES TROUS DE TESTS SUR DES CHEMINS JUSTES, dont chacun protège d'une double réponse.
 */
describe('J4 : ce que rien ne tenait', () => {
  it('🔴 agent de Meta allumé, la réponse « à côté » lui est transmise, et JAMAIS confiée au répondeur IA', async () => {
    // Les deux voix ne coexistent pas (CHECK de 0209), mais l'exécuteur ne doit pas compter sur le réglage pour se taire :
    // confier aussi le message au répondeur le ferait démarrer un agent IA, ou passer la main à l'équipe, par-dessus
    // l'agent de Meta qui vient de le recevoir.
    const mo = moteur();
    const transmis: string[] = [];
    const confies: string[] = [];
    const ex = new WorkflowExecutor({
      ...depsInertes,
      estDesabonne: jamaisDesabonne,
      runs: mo.runs,
      getGraph: async () => CAMPAGNE,
      applyTag: async () => true, setField: async () => {}, removeTag: async () => {}, clearField: async () => {},
      sendTemplate: async () => {}, sendQuickMessage: async () => {}, sendFlow: async () => {}, sendQuestion: async () => {},
      mbaActifPour: async () => true,
      transmettreHorsParcours: async (_t, _w, id) => { transmis.push(id); },
      confierAuRepondeur: async (_t, _w, id) => { confies.push(id); },
    });
    expect(await ex.demarrer('campagne_scenario', ESPACE, 'wf-campagne', CAMPAGNE, { waId: WA, contactId: 'c-1' })).toBe(true);
    await ex.advance(ESPACE, WA, 'wamid.c', null);
    expect(mo.lignes.map((l) => l.status)).toEqual(['done']);
    expect(transmis).toEqual(['wamid.c']);
    expect(confies).toEqual([]);
  });

  it('🔴 le worker nomme le message déclencheur quand il rend un fil pris pour rien, et passe le TYPE à l’avance', () => {
    // `src/worker.ts` démarre un processus quand on l'importe : son câblage se lit dans sa source. Sans le dernier lead,
    // le parcours du répondeur ne naît pas en l'ayant reçu, et l'avance du même job (qui suit le routage) enfile un
    // second tour. Sans `entrant`, l'exécuteur ne sait plus qu'un message est une réaction (J1).
    const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
    expect(worker).toContain('rendreLeFil: (t, waId, contenu, dernierLead) => fil.remettreSiPersonneNeSuit(t, waId, contenu, { rouverte: false, messageDeclencheur: dernierLead }),');
    expect(worker).toContain('advance: async (t, w, m, bp, entrant) => {');
    expect(worker).toContain("await workflowExecutor.advance(t, w, m, bp, 'whatsapp', entrant);");
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
