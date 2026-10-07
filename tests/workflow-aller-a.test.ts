import { describe, it, expect, vi } from 'vitest';
import { jamaisDesabonne } from './consentement';
import { avecGardesDEtatInertes, depsInertes } from './executeur-inerte';
import { WorkflowExecutor } from '../src/workflow/executor';
import type { WorkflowExecutorDeps } from '../src/workflow/executor';
import { walk, scanOpening, waitBeforeSessionMessage, sautsApresAttenteLongue } from '../src/workflow/engine';
import { canalDOuverture } from '../src/workflow/store.pg';
import { ouvertureApi } from '../src/workflow/ouverture-api';
import { MAX_SAUTS_SANS_PAUSE, refusDePublication, type ScenarioDeLEspace } from '../src/workflow/aller-a';
import { blocSeul } from '../src/mba/outils-maison';
import { summarize } from '../src/workflow/node-list';
import { buildWorkflowRuntime } from '../src/workflow/wiring';
import type { WorkflowGraph, WorkflowNodeType } from '../src/workflow/graph';
import type { RunState, WorkflowRunRow } from '../src/workflow/run-store.pg';
import type { EvalContext } from '../src/workflow/conditions';

/**
 * LE BLOC « ALLER À » (RC5, livraison B, plan `docs/superpowers/plans/2026-10-06-rc5-blocs-condition-aller-a.md`).
 *
 * Ce que ces cas tiennent : le saut DANS le même scénario se joue dans `walk` (sa garde `visited` arrête une boucle sans
 * pause, une pause la réarme) ; le saut VERS un autre scénario clôt le parcours et en démarre un sur le bloc visé, par le
 * VRAI exécuteur, avec les champs de la fiche posés avant lui ; la garde anti-boucle entre scénarios arrête le 21e saut
 * et passe la conversation à l'équipe ; une cible absente ou d'un autre espace s'arrête et s'écrit au journal ; la
 * fenêtre de 24 h suit le saut, à l'exécution comme à la publication.
 */

const n = (id: string, type: WorkflowNodeType, data: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, data });
const e = (source: string, target: string, sourceHandle?: string) => ({ id: `${source}>${target}>${sourceHandle ?? ''}`, source, target, ...(sourceHandle ? { sourceHandle } : {}) });
/** Un code public de bloc bien formé (`nod_<client>_<ULID>`), distinct par numéro. */
const code = (k: number): string => `nod_k7m2p3_01J${String(k).padStart(23, '0')}`;
const WA = '33611223344';
const T = new Date('2026-10-07T10:00:00Z').getTime();

describe('le moteur pur', () => {
  it('🔴 même scénario : le parcours continue sur le bloc visé, dans le même enchaînement', () => {
    const g: WorkflowGraph = {
      nodes: [n('t', 'tag', { tag: 'x', code: code(1) }), n('j', 'aller_a', { cible: code(3) }), n('q', 'quick_message', { body: 'Re', code: code(3) })],
      edges: [e('t', 'j')],
    };
    const r = walk(g, 't');
    expect(r.actions.map((a) => `${a.nodeId}:${a.action.kind}`)).toEqual(['t:tag', 'q:sendQuickMessage']);
    expect(r.rest).toEqual({ status: 'done' });
  });

  it('🔴 même scénario, sans pause : un retour sur un bloc déjà visité arrête le parcours (garde de `walk`)', () => {
    const g: WorkflowGraph = { nodes: [n('t', 'tag', { tag: 'x', code: code(1) }), n('j', 'aller_a', { cible: code(1) })], edges: [e('t', 'j')] };
    const r = walk(g, 't');
    expect(r.actions.map((a) => a.nodeId)).toEqual(['t']);
    expect(r.rest).toEqual({ status: 'done' });
  });

  it('un autre scénario (ou rien) : la main est rendue avec la cible et les actions déjà accumulées', () => {
    const ailleurs: WorkflowGraph = { nodes: [n('t', 'tag', { tag: 'x' }), n('j', 'aller_a', { cible: code(9) })], edges: [e('t', 'j')] };
    const r = walk(ailleurs, 't');
    expect(r.actions.map((a) => a.nodeId)).toEqual(['t']);
    expect(r.rest).toEqual({ status: 'aller_a', nodeId: 'j', cible: code(9) });
    expect(walk({ nodes: [n('j', 'aller_a')], edges: [] }, 'j').rest).toEqual({ status: 'aller_a', nodeId: 'j', cible: '' });
  });

  it('l’ouverture suit un saut interne, et ne se juge pas d’ici quand il mène ailleurs', () => {
    const interne: WorkflowGraph = {
      nodes: [n('j', 'aller_a', { cible: code(2) }), n('tpl', 'template', { templateName: 'promo', code: code(2) })], edges: [],
    };
    // Les deux blocs n'ont pas d'arête entrante : l'entrée est le premier, le saut.
    expect(scanOpening(interne).firstTemplate?.id).toBe('tpl');
    expect(canalDOuverture(interne)).toBe('whatsapp');
    const externe: WorkflowGraph = { nodes: [n('t', 'tag', { tag: 'x' }), n('j', 'aller_a', { cible: code(9) })], edges: [e('t', 'j')] };
    expect(scanOpening(externe).sautsHorsScenario).toEqual([code(9)]);
    expect(canalDOuverture(externe)).toBeNull();
    const api = ouvertureApi(externe);
    expect(api.ouverture).toBeNull();
    expect(api.ouverture === null ? api.raison : '').toContain('« Aller à »');
  });

  it('🔴 la fenêtre de 24 h suit un saut interne, et relève un saut externe après une attente longue', () => {
    const interne: WorkflowGraph = {
      nodes: [n('w', 'wait', { delay: 2, unit: 'days' }), n('j', 'aller_a', { cible: code(3) }), n('q', 'quick_message', { body: 'x', code: code(3) })],
      edges: [e('w', 'j')],
    };
    expect(waitBeforeSessionMessage(interne)).toEqual({ waitNodeId: 'w', messageNodeId: 'q' });
    const externe: WorkflowGraph = { nodes: [n('w', 'wait', { delay: 2, unit: 'days' }), n('j', 'aller_a', { cible: code(9) })], edges: [e('w', 'j')] };
    expect(waitBeforeSessionMessage(externe)).toBeNull();
    expect(sautsApresAttenteLongue(externe)).toEqual([{ waitNodeId: 'w', sautNodeId: 'j', cible: code(9) }]);
    const court: WorkflowGraph = { nodes: [n('w', 'wait', { delay: 1, unit: 'hours' }), n('j', 'aller_a', { cible: code(9) })], edges: [e('w', 'j')] };
    expect(sautsApresAttenteLongue(court)).toEqual([]);
  });

  it('un bloc « Aller à » ne part pas seul depuis un outil d’agent, et se résume par sa cible', () => {
    const g: WorkflowGraph = { nodes: [n('j', 'aller_a', { cible: code(9), code: code(5) })], edges: [] };
    expect(blocSeul(g, code(5))).toEqual({ ok: false, raison: 'ce bloc saute vers un autre bloc : utilisez « Lancer un scénario »' });
    expect(summarize('aller_a', { cible: code(9), cibleLibelle: 'Menu principal, Question 2' })).toBe('-> Menu principal, Question 2');
    expect(summarize('aller_a', { cible: code(9) })).toBe(`-> ${code(9)}`);
  });
});

/** Un dépôt de parcours en mémoire, plusieurs parcours : celui d'origine, puis celui du scénario d'arrivée. */
class FauxRuns {
  runs: Array<WorkflowRunRow & { contactId: string | null }> = [];
  async start(tenantId: string, workflowId: string, waId: string, contactId: string | null, state: RunState, grapheFige: WorkflowGraph | null): Promise<{ id: string }> {
    const id = `r${this.runs.length + 1}`;
    this.runs.push({
      id, workflowId, tenantId, waId, contactId, currentNode: state.currentNode, status: state.status,
      lastMessageId: state.lastMessageId ?? null, grapheFige,
    });
    return { id };
  }
  async findWaitingByWaId(_t: string, waId: string): Promise<WorkflowRunRow | null> {
    return [...this.runs].reverse().find((r) => r.status === 'waiting' && r.waId === waId) ?? null;
  }
  async setState(id: string, state: RunState): Promise<void> {
    const r = this.runs.find((x) => x.id === id);
    if (!r) return;
    r.currentNode = state.currentNode;
    r.status = state.status;
    if (state.lastMessageId !== undefined) r.lastMessageId = state.lastMessageId;
  }
  async closeActiveByWaId(_t: string, waId: string): Promise<string[]> {
    const vivants = this.runs.filter((r) => r.waId === waId && (r.status === 'waiting' || r.status === 'sleeping'));
    for (const r of vivants) r.status = 'done';
    return vivants.map((r) => r.id);
  }
}

/**
 * Le VRAI exécuteur, sur des scénarios en mémoire (publiés, par identifiant) et une fiche dont les champs écrits se
 * relisent : c'est ce qui montre que « les réponses suivent le contact » sans rien transporter.
 */
function monter(scenarios: Record<string, WorkflowGraph>, over: Partial<WorkflowExecutorDeps> = {}, espaceDesScenarios = 't1') {
  const runs = new FauxRuns();
  const calls: string[] = [];
  const journal: Array<{ workflowId: string; runId: string | null; messageId: string | null; erreur: string }> = [];
  const equipe: Array<[string | null, boolean, string]> = [];
  const emis: string[] = [];
  const resolus: string[] = [];
  const fiche: Record<string, unknown> = {};
  const ex = new WorkflowExecutor({
    ...depsInertes,
    estDesabonne: jamaisDesabonne,
    runs: avecGardesDEtatInertes(runs),
    getGraph: async (id) => scenarios[id] ?? null,
    // 🔴 Scopée à l'espace, comme le câblage : un code d'un autre espace n'y est jamais trouvé.
    resoudreBloc: async (tenant, c) => {
      resolus.push(c);
      if (tenant !== espaceDesScenarios) return null;
      for (const [workflowId, graph] of Object.entries(scenarios)) {
        const noeud = graph.nodes.find((x) => x.data.code === c);
        if (noeud) return { workflowId, nodeId: noeud.id, graph };
      }
      return null;
    },
    journaliserEchecSaut: async (j) => { journal.push({ workflowId: j.workflowId, runId: j.runId, messageId: j.messageId, erreur: j.erreur }); },
    escalateToHuman: async (_t, _w, assigneA, escalade, workflowId) => { equipe.push([assigneA, escalade, workflowId]); },
    evalContext: async () => ({
      fields: { ...fiche }, tags: [], optIn: 'unknown', name: null, phone: null, bsuid: null, analyse: null,
      now: new Date(T), timeZone: 'Europe/Paris', businessHours: {},
    } satisfies EvalContext),
    applyTag: async (_t, _w, tag) => { calls.push(`tag:${tag}`); return true; },
    emitTagAdded: async (_t, _w, tag) => { emis.push(tag); },
    setField: async (_t, _w, k, v) => { fiche[k] = v; calls.push(`champ:${k}=${v}`); },
    removeTag: async () => {},
    clearField: async () => {},
    sendTemplate: async (_t, _w, name) => { calls.push(`tpl:${name}`); },
    sendQuickMessage: async (_t, _w, body) => { calls.push(`qm:${body}`); },
    sendFlow: async () => {},
    sendQuestion: async (_t, _w, body) => { calls.push(`question:${body}`); },
    now: () => T,
    ...over,
  });
  return { ex, runs, calls, journal, equipe, emis, resolus, fiche };
}

function silence(): void {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
}

describe('le saut dans le MÊME scénario, sur le vrai exécuteur', () => {
  it('🔴 réponse à une question, puis retour au menu : une pause entre deux passages, donc aucun arrêt', async () => {
    const menu: WorkflowGraph = {
      nodes: [
        n('q', 'question', { body: 'Menu ?', rows: [{ title: 'Infos' }], code: code(10) }),
        n('i', 'quick_message', { body: 'Voici', code: code(11) }),
        n('j', 'aller_a', { cible: code(10) }),
      ],
      edges: [e('q', 'i', 'row:0'), e('i', 'j')],
    };
    const m = monter({ 'wf-a': menu });
    expect(await m.ex.demarrer('inbox', 't1', 'wf-a', menu, { waId: WA, contactId: 'c1' }, { depuis: 'entree', fenetreOuverte: true })).toBe(true);
    await m.ex.advance('t1', WA, 'm1', 'row:0');
    await m.ex.advance('t1', WA, 'm2', 'row:0');
    expect(m.calls).toEqual(['question:Menu ?', 'qm:Voici', 'question:Menu ?', 'qm:Voici', 'question:Menu ?']);
    expect(m.runs.runs.map((r) => `${r.workflowId}:${r.status}:${r.currentNode}`)).toEqual(['wf-a:waiting:q']);
    expect(m.journal).toEqual([]);
    expect(m.resolus, 'un saut interne ne cherche rien ailleurs').toEqual([]);
  });
});

/** A : une question, la réponse pose un champ, puis « Aller à » la condition de B. B commence par une étiquette. */
const A_VERS_B: WorkflowGraph = {
  nodes: [
    n('q', 'question', { body: 'Oui ou non ?', rows: [{ title: 'Oui' }], code: code(20) }),
    n('s', 'action', { actionKind: 'set_field', fieldKey: 'choix', value: 'oui', code: code(21) }),
    n('j', 'aller_a', { name: 'Vers le tri', cible: code(31) }),
  ],
  edges: [e('q', 's', 'row:0'), e('s', 'j')],
};
const B_TRI: WorkflowGraph = {
  nodes: [
    n('eb', 'tag', { tag: 'entree-b', code: code(30) }),
    n('x', 'condition', { match: 'all', clauses: [{ kind: 'field', key: 'choix', op: 'eq', value: 'oui' }], code: code(31) }),
    n('ok', 'quick_message', { body: 'Bien noté', quickReplies: ['Merci'], code: code(32) }),
    n('ko', 'quick_message', { body: 'Dommage', code: code(33) }),
  ],
  edges: [e('eb', 'x'), e('x', 'ok', 'true'), e('x', 'ko', 'false')],
};

describe('le saut vers un AUTRE scénario, sur le vrai exécuteur', () => {
  it('🔴 l’ancien parcours est clos, le nouveau démarre SUR le bloc visé, et la condition y lit le champ posé avant le saut', async () => {
    const m = monter({ 'wf-a': A_VERS_B, 'wf-b': B_TRI });
    await m.ex.demarrer('inbox', 't1', 'wf-a', A_VERS_B, { waId: WA, contactId: 'c1' }, { depuis: 'entree', fenetreOuverte: true });
    const demarrer = vi.spyOn(m.ex, 'demarrer');
    await m.ex.advance('t1', WA, 'm1', 'row:0');
    // Démarré sur la condition de B : son étiquette d'entrée n'est pas posée, et la condition voit `choix = oui`.
    expect(m.calls).toEqual(['question:Oui ou non ?', 'champ:choix=oui', 'qm:Bien noté']);
    expect(m.runs.runs.map((r) => `${r.id}:${r.workflowId}:${r.status}:${r.currentNode}:${r.lastMessageId}`)).toEqual([
      'r1:wf-a:done:null:m1',
      // Le message qui a déclenché le saut naît déjà reçu dans le parcours d'arrivée.
      'r2:wf-b:waiting:ok:m1',
    ]);
    expect(m.runs.runs[1]!.grapheFige, 'le scénario d’arrivée se joue dans sa version publiée, jamais figée').toBeNull();
    expect(m.runs.runs[1]!.contactId, 'la fiche du parcours d’origine suit le saut').toBe('c1');
    expect(demarrer).toHaveBeenCalledTimes(1);
    expect(demarrer.mock.calls[0]![0]).toBe('aller_a');
    expect(demarrer.mock.calls[0]![5]).toEqual({ depuis: 'saut', noeudId: 'x', fenetreOuverte: true, sauts: 1, messageDeclencheur: 'm1' });
    expect(m.journal).toEqual([]);
    expect(m.equipe).toEqual([]);
    // Redélivré par Meta, le même message n'est pas pris pour une réponse dans le parcours d'arrivée.
    await m.ex.advance('t1', WA, 'm1', 'row:0');
    expect(m.calls).toHaveLength(3);
  });

  it('un saut au démarrage, sans pause, hérite de la preuve de fenêtre et ne crée aucun parcours d’origine', async () => {
    const a: WorkflowGraph = { nodes: [n('t', 'tag', { tag: 'a' }), n('j', 'aller_a', { cible: code(32) })], edges: [e('t', 'j')] };
    const m = monter({ 'wf-a': a, 'wf-b': B_TRI });
    expect(await m.ex.demarrer('inbox', 't1', 'wf-a', a, { waId: WA, contactId: 'c1' }, { depuis: 'entree', fenetreOuverte: true })).toBe(true);
    expect(m.calls).toEqual(['tag:a', 'qm:Bien noté']);
    expect(m.runs.runs.map((r) => `${r.workflowId}:${r.status}:${r.currentNode}`)).toEqual(['wf-b:waiting:ok']);
  });
});

describe('🔴 la garde anti-boucle ENTRE scénarios', () => {
  /** A saute vers B, qui saute vers A, sans aucune pause. */
  const A: WorkflowGraph = { nodes: [n('ja', 'aller_a', { name: 'Vers B', cible: code(41), code: code(40) })], edges: [] };
  const B: WorkflowGraph = { nodes: [n('jb', 'aller_a', { name: 'Vers A', cible: code(40), code: code(41) })], edges: [] };

  it(`arrêt au ${MAX_SAUTS_SANS_PAUSE + 1}e saut : la conversation va à l’équipe, et le journal le dit`, async () => {
    silence();
    const m = monter({ 'wf-a': A, 'wf-b': B });
    const demarrer = vi.spyOn(m.ex, 'demarrer');
    expect(await m.ex.demarrer('inbox', 't1', 'wf-a', A, { waId: WA, contactId: 'c1' }, { depuis: 'entree', fenetreOuverte: true })).toBe(true);
    const sauts = demarrer.mock.calls.filter((c) => c[0] === 'aller_a');
    expect(sauts).toHaveLength(20);
    expect(sauts.map((c) => (c[5] as { sauts: number }).sauts)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(m.resolus, 'le 21e saut ne va même pas chercher sa cible').toHaveLength(20);
    // Le 21e part de A (les sauts impairs partent de A).
    expect(m.equipe).toEqual([[null, false, 'wf-a']]);
    expect(m.journal).toHaveLength(1);
    expect(m.journal[0]!.erreur).toContain('plus de 20 « Aller à » enchaînés sans pause');
    expect(m.journal[0]!.erreur).toContain('« Vers B »');
  });

  it('une pause réarme le compteur : chaque réponse repart à un saut', async () => {
    // A pose une question ; sa réponse saute vers B, qui repose la question de A. Chaque saut suit une pause.
    const a: WorkflowGraph = {
      nodes: [n('q', 'question', { body: 'Encore ?', rows: [{ title: 'Oui' }], code: code(42) }), n('ja', 'aller_a', { cible: code(43) })],
      edges: [e('q', 'ja', 'row:0')],
    };
    const b: WorkflowGraph = { nodes: [n('jb', 'aller_a', { cible: code(42), code: code(43) })], edges: [] };
    const m = monter({ 'wf-a': a, 'wf-b': b });
    await m.ex.demarrer('inbox', 't1', 'wf-a', a, { waId: WA, contactId: 'c1' }, { depuis: 'entree', fenetreOuverte: true });
    for (let i = 0; i < 25; i++) await m.ex.advance('t1', WA, `m${i}`, 'row:0');
    expect(m.calls.filter((c) => c === 'question:Encore ?')).toHaveLength(26);
    expect(m.journal).toEqual([]);
    expect(m.equipe).toEqual([]);
  });
});

describe('🔴 une cible absente à l’exécution', () => {
  const a: WorkflowGraph = {
    nodes: [n('q', 'question', { body: 'Menu ?', rows: [{ title: 'Suite' }], code: code(50) }), n('j', 'aller_a', { name: 'Vers le menu', cible: code(59) })],
    edges: [e('q', 'j', 'row:0')],
  };

  it('le parcours s’arrête, la conversation va à l’équipe, et le journal nomme le bloc', async () => {
    silence();
    const m = monter({ 'wf-a': a });
    await m.ex.demarrer('inbox', 't1', 'wf-a', a, { waId: WA, contactId: 'c1' }, { depuis: 'entree', fenetreOuverte: true });
    await m.ex.advance('t1', WA, 'm1', 'row:0');
    expect(m.runs.runs.map((r) => `${r.workflowId}:${r.status}`)).toEqual(['wf-a:done']);
    expect(m.journal).toEqual([{ workflowId: 'wf-a', runId: 'r1', messageId: 'm1', erreur: `le bloc « Vers le menu » vise un bloc qui n’existe plus (${code(59)})` }]);
    expect(m.equipe).toEqual([[null, false, 'wf-a']]);
  });

  it('🔴 un code d’un autre espace est une cible inexistante', async () => {
    silence();
    const b: WorkflowGraph = { nodes: [n('x', 'quick_message', { body: 'Chez un autre client', code: code(59) })], edges: [] };
    // Le scénario qui porte le code appartient à l'espace t2 ; le parcours tourne dans t1.
    const m = monter({ 'wf-a': a, 'wf-autre': b }, {}, 't2');
    await m.ex.demarrer('inbox', 't1', 'wf-a', a, { waId: WA, contactId: 'c1' }, { depuis: 'entree', fenetreOuverte: true });
    await m.ex.advance('t1', WA, 'm1', 'row:0');
    expect(m.calls).toEqual(['question:Menu ?']);
    expect(m.journal).toHaveLength(1);
    expect(m.journal[0]!.erreur).toContain('n’existe plus');
  });

  it('une cible du même scénario absente du graphe joué ne se cherche pas dans sa version publiée', async () => {
    silence();
    // Le test joue le brouillon (figé) : la cible n'y est plus, mais elle est encore dans le publié.
    const publie: WorkflowGraph = { nodes: [...a.nodes, n('vieux', 'quick_message', { body: 'Ancien menu', code: code(59) })], edges: a.edges };
    const m = monter({ 'wf-a': publie });
    await m.ex.demarrer('lien_de_test', 't1', 'wf-a', a, { waId: WA, contactId: 'c1' }, { depuis: 'entree' });
    await m.ex.advance('t1', WA, 'm1', 'row:0');
    expect(m.calls).toEqual(['question:Menu ?']);
    expect(m.journal).toHaveLength(1);
  });
});

describe('🔴 la fenêtre de 24 h suit le saut, au réveil', () => {
  const a: WorkflowGraph = {
    nodes: [n('w', 'wait', { delay: 2, unit: 'days' }), n('j', 'aller_a', { name: 'Relancer', cible: code(80) })],
    edges: [e('w', 'j')],
  };
  const b: WorkflowGraph = { nodes: [n('r', 'quick_message', { body: 'Relance', quickReplies: ['Ok'], code: code(80) })], edges: [] };
  const reveil = { id: 'r1', workflowId: 'wf-a', tenantId: 't1', waId: WA, currentNode: 'w', grapheFige: null, status: 'sleeping' as const };

  it('fenêtre fermée : le scénario d’arrivée refuse d’ouvrir par un message de session, la conversation va à l’équipe', async () => {
    silence();
    const m = monter({ 'wf-a': a, 'wf-b': b }, { isWindowOpen: async () => false });
    await m.ex.demarrer('inbox', 't1', 'wf-a', a, { waId: WA, contactId: 'c1' }, { depuis: 'entree', fenetreOuverte: true });
    expect(m.runs.runs.map((r) => r.status)).toEqual(['sleeping']);
    expect(await m.ex.resume(reveil)).toBe(true);
    expect(m.calls).toEqual([]);
    expect(m.journal).toHaveLength(1);
    expect(m.journal[0]!.erreur).toContain('impossible hors de la fenêtre de 24 h');
    expect(m.equipe).toEqual([[null, false, 'wf-a']]);
  });

  it('fenêtre ouverte (le contact a écrit pendant l’attente) : le message part', async () => {
    const m = monter({ 'wf-a': a, 'wf-b': b }, { isWindowOpen: async () => true });
    await m.ex.demarrer('inbox', 't1', 'wf-a', a, { waId: WA, contactId: 'c1' }, { depuis: 'entree', fenetreOuverte: true });
    await m.ex.resume(reveil);
    expect(m.calls).toEqual(['qm:Relance']);
    expect(m.runs.runs.map((r) => `${r.workflowId}:${r.status}`)).toEqual(['wf-a:done', 'wf-b:waiting']);
  });
});

describe('le test et la campagne', () => {
  it('lien de test : une cible du même scénario se lit dans le BROUILLON figé, une autre dans sa version publiée', async () => {
    const brouillon: WorkflowGraph = {
      nodes: [n('t', 'tag', { tag: 'test' }), n('j', 'aller_a', { cible: code(92) }), n('neuf', 'question', { body: 'Bloc du brouillon', code: code(92) })],
      edges: [e('t', 'j')],
    };
    const m = monter({ 'wf-a': { nodes: [n('t', 'tag', { tag: 'test' })], edges: [] } });
    await m.ex.demarrer('lien_de_test', 't1', 'wf-a', brouillon, { waId: WA, contactId: 'c1' }, { depuis: 'entree' });
    expect(m.calls).toEqual(['tag:test', 'question:Bloc du brouillon']);
    expect(m.resolus).toEqual([]);

    const versB: WorkflowGraph = { nodes: [n('j', 'aller_a', { cible: code(32) })], edges: [] };
    const m2 = monter({ 'wf-a': { nodes: [], edges: [] }, 'wf-b': B_TRI });
    await m2.ex.demarrer('lien_de_test', 't1', 'wf-a', versB, { waId: WA, contactId: 'c1' }, { depuis: 'entree' });
    expect(m2.calls).toEqual(['qm:Bien noté']);
    expect(m2.runs.runs[0]!.grapheFige, 'B n’est pas figé : seul le scénario testé l’est').toBeNull();
  });

  it('🔴 un saut franchi au démarrage d’une campagne ne publie pas les étiquettes du scénario d’arrivée', async () => {
    const a: WorkflowGraph = { nodes: [n('tpl', 'template', { templateName: 'promo' }), n('j', 'aller_a', { cible: code(111) })], edges: [e('tpl', 'j')] };
    const b: WorkflowGraph = { nodes: [n('bt', 'tag', { tag: 'vu-b', code: code(111) }), n('t2', 'template', { templateName: 'suite' })], edges: [e('bt', 't2')] };
    // L'agent de Meta est allumé : le modèle sans bouton ne retient pas le parcours, qui va jusqu'au saut.
    const campagne = monter({ 'wf-a': a, 'wf-b': b }, { mbaActifPour: async () => true });
    const demarrer = vi.spyOn(campagne.ex, 'demarrer');
    await campagne.ex.demarrer('campagne_scenario', 't1', 'wf-a', a, { waId: WA, contactId: 'c1' });
    expect(campagne.calls).toEqual(['tpl:promo', 'tag:vu-b', 'tpl:suite']);
    expect(campagne.emis).toEqual([]);
    expect(demarrer.mock.calls.map((c) => c[0])).toEqual(['campagne_scenario', 'aller_a_masse']);

    const inbox = monter({ 'wf-a': a, 'wf-b': b }, { mbaActifPour: async () => true });
    await inbox.ex.demarrer('inbox', 't1', 'wf-a', a, { waId: WA, contactId: 'c1' }, { depuis: 'entree', fenetreOuverte: true });
    expect(inbox.emis).toEqual(['vu-b']);
  });
});

describe('le vrai câblage', () => {
  it('🔴 `resoudreBloc` ne lit que les scénarios de l’espace demandé, et le journal écrit dans les échecs de scénario', async () => {
    const requetes: Array<{ sql: string; params: unknown[] }> = [];
    const lus: string[] = [];
    const inerte = {} as never;
    const graph: WorkflowGraph = { nodes: [n('x', 'quick_message', { body: 'Ici', code: code(130) })], edges: [] };
    const { executor } = buildWorkflowRuntime({
      pool: { query: async (sql: string, params: unknown[]) => { requetes.push({ sql, params }); return { rows: [], rowCount: 1 }; } } as never,
      queue: { enqueue: async () => {} }, dryRun: true, repo: inerte, contactStore: inerte, inboxStore: inerte, settingsStore: inerte,
      workflowStore: { list: async (t: string) => { lus.push(t); return t === 't1' ? [{ id: 'wf-1', name: 'Un', code: null, graph }] : []; } } as never,
      metaCredentials: inerte, metaFactory: inerte, rcsProvider: 'fake', emailTemplates: inerte, emailResolver: inerte,
      numeroDeLEspace: async () => null, runStore: inerte, fil: inerte,
    });
    const deps = Reflect.get(executor, 'deps') as WorkflowExecutorDeps;
    expect(await deps.resoudreBloc('t2', code(130))).toBeNull();
    expect(await deps.resoudreBloc('t1', code(130))).toEqual({ workflowId: 'wf-1', nodeId: 'x', graph });
    expect(lus).toEqual(['t2', 't1']);
    await deps.journaliserEchecSaut({ tenantId: 't1', waId: WA, workflowId: 'wf-1', runId: null, messageId: 'm1', erreur: 'boucle' });
    expect(requetes).toHaveLength(1);
    expect(requetes[0]!.sql).toMatch(/insert into workflow_advance_failures/);
    expect(requetes[0]!.params).toEqual(['t1', WA, 'm1', 'wf-1', null, null, 'boucle']);
  });
});

describe('🔴 le refus de publication', () => {
  const B: ScenarioDeLEspace = { id: 'wf-b', name: 'Menu principal', graph: B_TRI };
  const aVers = (cible: unknown, avant: Array<ReturnType<typeof n>> = []): WorkflowGraph => ({
    nodes: [...avant, n('j', 'aller_a', { name: 'Vers le menu', ...(cible === undefined ? {} : { cible }) })],
    edges: avant.length > 0 ? [e(avant[avant.length - 1]!.id, 'j')] : [],
  });

  it('une cible vide ou inexistante est refusée, avec le nom du bloc', () => {
    expect(refusDePublication(aVers(undefined), 'wf-a', [B])).toContain('« Vers le menu » ne vise aucun bloc');
    expect(refusDePublication(aVers(code(999)), 'wf-a', [B])).toContain('« Vers le menu » vise un bloc qui n’existe pas');
  });

  it('une cible du brouillon publié, ou de la version publiée d’un autre scénario, passe', () => {
    const interne: WorkflowGraph = { nodes: [...aVers(code(7)).nodes, n('t', 'tag', { tag: 'x', code: code(7) })], edges: [] };
    expect(refusDePublication(interne, 'wf-a', [B])).toBeNull();
    expect(refusDePublication(aVers(code(31)), 'wf-a', [B])).toBeNull();
  });

  it('🔴 une cible seulement dans la version publiée de CE scénario, ou seulement dans le brouillon d’un autre, est refusée', () => {
    const lui: ScenarioDeLEspace = { id: 'wf-a', name: 'Lui', graph: { nodes: [n('vieux', 'tag', { tag: 'x', code: code(7) })], edges: [] } };
    expect(refusDePublication(aVers(code(7)), 'wf-a', [lui, B])).toContain('n’existe pas');
    // `scenarios` porte les graphes PUBLIÉS : un bloc d'un brouillon d'à côté n'y est pas.
    const brouillonAilleurs: ScenarioDeLEspace = { id: 'wf-c', name: 'C', graph: { nodes: [], edges: [] } };
    expect(refusDePublication(aVers(code(8)), 'wf-a', [brouillonAilleurs])).toContain('n’existe pas');
  });

  it('🔴 après une attente longue, un saut vers un autre scénario qui ouvre par un message de session est refusé', () => {
    const attente = n('w', 'wait', { name: 'Deux jours', delay: 2, unit: 'days' });
    // La condition de B mène à des messages rapides : son premier envoi est un message de session.
    const refus = refusDePublication(aVers(code(31), [attente]), 'wf-a', [B]);
    expect(refus).toContain('« Deux jours »');
    expect(refus).toContain('« Vers le menu »');
    expect(refus).toContain('du scénario « Menu principal »');
    // Vers un modèle, ou après une attente courte : rien à redire.
    const modele: ScenarioDeLEspace = { id: 'wf-m', name: 'Relance', graph: { nodes: [n('tpl', 'template', { templateName: 'relance', code: code(60) })], edges: [] } };
    expect(refusDePublication(aVers(code(60), [attente]), 'wf-a', [B, modele])).toBeNull();
    expect(refusDePublication(aVers(code(31), [n('w', 'wait', { delay: 1, unit: 'hours' })]), 'wf-a', [B])).toBeNull();
    // Un saut qui mène à un autre saut : on le suit jusqu'au message.
    const relais: ScenarioDeLEspace = { id: 'wf-r', name: 'Relais', graph: { nodes: [n('jr', 'aller_a', { cible: code(31), code: code(61) })], edges: [] } };
    expect(refusDePublication(aVers(code(61), [attente]), 'wf-a', [B, relais])).toContain('« Menu principal »');
  });
});
