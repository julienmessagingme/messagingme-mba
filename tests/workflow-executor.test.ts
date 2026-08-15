import { describe, it, expect } from 'vitest';
import { WorkflowExecutor } from '../src/workflow/executor';
import type { WorkflowExecutorDeps } from '../src/workflow/executor';
import type { WorkflowGraph, WorkflowNodeType } from '../src/workflow/graph';
import type { EvalContext } from '../src/workflow/conditions';
import type { WorkflowRunRow, RunState } from '../src/workflow/run-store.pg';

const n = (id: string, type: WorkflowNodeType, data: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, data });
const e = (id: string, source: string, target: string) => ({ id, source, target });
const eh = (id: string, source: string, target: string, sourceHandle: string) => ({ id, source, target, sourceHandle });

class FakeRuns {
  run: WorkflowRunRow | null = null;
  async start(tenantId: string, workflowId: string, waId: string, _contactId: string | null, state: RunState): Promise<{ id: string }> {
    this.run = { id: 'r1', workflowId, tenantId, waId, currentNode: state.currentNode, status: state.status, lastMessageId: null };
    return { id: 'r1' };
  }
  async findWaitingByWaId(_t: string, waId: string): Promise<WorkflowRunRow | null> {
    return this.run && this.run.status === 'waiting' && this.run.waId === waId ? this.run : null;
  }
  async setState(id: string, state: RunState): Promise<void> {
    if (this.run && this.run.id === id) this.run = { ...this.run, currentNode: state.currentNode, status: state.status, lastMessageId: state.lastMessageId ?? this.run.lastMessageId };
  }
}

function make(graph: WorkflowGraph, over: Partial<WorkflowExecutorDeps> = {}) {
  const runs = new FakeRuns();
  const calls: string[] = [];
  const escalations: string[] = []; // capture séparée : les assertions `calls` existantes restent inchangées
  const ex = new WorkflowExecutor({
    runs,
    getGraph: async () => graph,
    applyTag: async (_t, _w, tag) => { calls.push(`tag:${tag}`); },
    setField: async (_t, _w, k, v) => { calls.push(`field:${k}=${v}`); },
    removeTag: async (_t, _w, tag) => { calls.push(`untag:${tag}`); },
    clearField: async (_t, _w, k) => { calls.push(`clear:${k}`); },
    sendTemplate: async (_t, _w, name) => { calls.push(`tpl:${name}`); },
    sendQuickMessage: async (_t, _w, body) => { calls.push(`qm:${body}`); },
    sendFlow: async (_t, _w, flowId, body, cta) => { calls.push(`flow:${flowId}:${body}:${cta}`); },
    escalateToHuman: async (_t, w) => { escalations.push(w); },
    ...over,
  });
  return { ex, runs, calls, escalations };
}

describe('WorkflowExecutor', () => {
  // tag -> template -> inbox
  const linear: WorkflowGraph = {
    nodes: [n('t', 'tag', { tag: 'vip' }), n('tpl', 'template', { templateName: 'promo', language: 'fr' }), n('ib', 'inbox')],
    edges: [e('e1', 't', 'tpl'), e('e2', 'tpl', 'ib')],
  };

  it('start : pose le tag, envoie le template, run en attente au template', async () => {
    const { ex, runs, calls } = make(linear);
    await ex.start('t1', 'wf1', linear, { waId: '33600', contactId: 'c1' });
    expect(calls).toEqual(['tag:vip', 'tpl:promo']);
    expect(runs.run).toMatchObject({ status: 'waiting', currentNode: 'tpl' });
  });

  it('start : bloc action « retirer tag » puis « vider champ » appelle removeTag / clearField', async () => {
    const g: WorkflowGraph = {
      nodes: [n('a1', 'action', { actionKind: 'remove_tag', tag: 'vip' }), n('a2', 'action', { actionKind: 'clear_field', fieldKey: 'statut' }), n('ib', 'inbox')],
      edges: [e('e1', 'a1', 'a2'), e('e2', 'a2', 'ib')],
    };
    const { ex, calls } = make(g);
    await ex.start('t1', 'wf1', g, { waId: '33600', contactId: 'c1' });
    expect(calls).toEqual(['untag:vip', 'clear:statut']);
  });

  it('advance : le contact répond -> la conversation arrive en inbox (run terminé)', async () => {
    const { ex, runs, calls } = make(linear);
    await ex.start('t1', 'wf1', linear, { waId: '33600', contactId: 'c1' });
    await ex.advance('t1', '33600', 'msg1');
    expect(runs.run).toMatchObject({ status: 'inbox', currentNode: null });
    expect(calls).toEqual(['tag:vip', 'tpl:promo']); // pas de nouvel envoi (inbox n'a pas d'action)
  });

  it('atteindre le node inbox escalade à un humain (escalateToHuman) ; pas d’escalade tant qu’on n’y est pas', async () => {
    const { ex, escalations } = make(linear);
    await ex.start('t1', 'wf1', linear, { waId: '33600', contactId: 'c1' });
    expect(escalations).toEqual([]); // start s'arrête au template (waiting), pas encore inbox
    await ex.advance('t1', '33600', 'msg1'); // le contact répond -> node inbox
    expect(escalations).toEqual(['33600']);
  });

  // Garde fenêtre 24 h (Lot 7) : `start` = chemin campagne, HORS fenêtre de service -> un scénario qui OUVRE
  // sur un message de session (quick_message/flow) est refusé en bloc (aucune action, aucun run).
  it('start : quick_message en OUVERTURE -> refusé (fenêtre 24 h), aucune action, aucun run', async () => {
    const g: WorkflowGraph = { nodes: [n('qm', 'quick_message', { body: 'Salut', quickReplies: ['Oui', 'Non'] })], edges: [] };
    const { ex, runs, calls } = make(g);
    await ex.start('t1', 'wf1', g, { waId: '33600', contactId: 'c1' });
    expect(calls).toEqual([]);
    expect(runs.run).toBeNull();
  });

  it('start : tag -> flow en ouverture -> refusé EN BLOC (le tag non plus n\'est pas appliqué)', async () => {
    const g: WorkflowGraph = {
      nodes: [n('t', 'tag', { tag: 'vip' }), n('f', 'flow', { flowId: 'fl1', flowName: 'RDV' })],
      edges: [e('e1', 't', 'f')],
    };
    const { ex, runs, calls } = make(g);
    await ex.start('t1', 'wf1', g, { waId: '33600', contactId: 'c1' });
    expect(calls).toEqual([]);
    expect(runs.run).toBeNull();
  });

  it('advance : quick_message APRÈS un template est envoyé (fenêtre ouverte), run en attente au bloc', async () => {
    const g: WorkflowGraph = {
      nodes: [n('tpl', 'template', { templateName: 'promo', language: 'fr' }), n('qm', 'quick_message', { body: 'Salut', quickReplies: ['Oui', 'Non'] })],
      edges: [e('e1', 'tpl', 'qm')],
    };
    const { ex, runs, calls } = make(g);
    await ex.start('t1', 'wf1', g, { waId: '33600', contactId: 'c1' });
    expect(calls).toEqual(['tpl:promo']);
    await ex.advance('t1', '33600', 'm1');
    expect(calls).toEqual(['tpl:promo', 'qm:Salut']);
    expect(runs.run).toMatchObject({ status: 'waiting', currentNode: 'qm' });
  });

  it('advance : node flow APRÈS un template -> sendFlow (flowId + accroche par défaut + cta), attente au bloc', async () => {
    const g: WorkflowGraph = {
      nodes: [n('tpl', 'template', { templateName: 'promo', language: 'fr' }), n('f', 'flow', { flowId: 'fl1', flowName: 'RDV' })],
      edges: [e('e1', 'tpl', 'f')],
    };
    const { ex, runs, calls } = make(g);
    await ex.start('t1', 'wf1', g, { waId: '33600', contactId: 'c1' });
    await ex.advance('t1', '33600', 'm1');
    expect(calls).toEqual(['tpl:promo', 'flow:fl1:Formulaire : RDV:Envoyer']);
    expect(runs.run).toMatchObject({ status: 'waiting', currentNode: 'f' });
  });

  it('advance : node flow SANS flowId -> aucune action (no-op), run en attente (même contrat que template vide)', async () => {
    const g: WorkflowGraph = {
      nodes: [n('tpl', 'template', { templateName: 'promo', language: 'fr' }), n('f', 'flow', {})],
      edges: [e('e1', 'tpl', 'f')],
    };
    const { ex, runs, calls } = make(g);
    await ex.start('t1', 'wf1', g, { waId: '33600', contactId: 'c1' });
    await ex.advance('t1', '33600', 'm1');
    expect(calls).toEqual(['tpl:promo']);
    expect(runs.run).toMatchObject({ status: 'waiting', currentNode: 'f' });
  });

  it('workflow 100% synchrone (tag seul) : action appliquée, AUCUN run persistant', async () => {
    const g: WorkflowGraph = { nodes: [n('t', 'tag', { tag: 'x' })], edges: [] };
    const { ex, runs, calls } = make(g);
    await ex.start('t1', 'wf1', g, { waId: '33600', contactId: 'c1' });
    expect(calls).toEqual(['tag:x']);
    expect(runs.run).toBeNull();
  });

  it('advance idempotent : un même message ne fait pas avancer 2 fois', async () => {
    // tag -> tpl1 -> tpl2 -> inbox : après la 1re réponse, run attend au tpl2.
    const g: WorkflowGraph = {
      nodes: [n('t', 'tag', { tag: 'a' }), n('tpl1', 'template', { templateName: 't1', language: 'fr' }), n('tpl2', 'template', { templateName: 't2', language: 'fr' }), n('ib', 'inbox')],
      edges: [e('e1', 't', 'tpl1'), e('e2', 'tpl1', 'tpl2'), e('e3', 'tpl2', 'ib')],
    };
    const { ex, runs, calls } = make(g);
    await ex.start('t1', 'wf1', g, { waId: '33600', contactId: 'c1' });
    expect(calls).toEqual(['tag:a', 'tpl:t1']);
    await ex.advance('t1', '33600', 'm1'); // -> envoie t2, attend au tpl2
    expect(runs.run).toMatchObject({ status: 'waiting', currentNode: 'tpl2', lastMessageId: 'm1' });
    await ex.advance('t1', '33600', 'm1'); // MÊME message -> no-op
    expect(calls).toEqual(['tag:a', 'tpl:t1', 'tpl:t2']); // pas de 2e envoi de t2
  });

  it('advance sans run en attente -> no-op', async () => {
    const { ex } = make(linear);
    await expect(ex.advance('t1', '33600', 'm1')).resolves.toBeUndefined();
  });

  // template à 2 boutons quick-reply -> 2 branches (btn:0 -> tag oui, btn:1 -> tag non).
  const branched: WorkflowGraph = {
    nodes: [
      n('tpl', 'template', { templateName: 'promo', language: 'fr', templateButtons: [{ type: 'QUICK_REPLY', text: 'Oui' }, { type: 'QUICK_REPLY', text: 'Non' }] }),
      n('ta', 'tag', { tag: 'oui' }), n('tb', 'tag', { tag: 'non' }), n('ib', 'inbox'),
    ],
    edges: [eh('e0', 'tpl', 'ta', 'btn:0'), eh('e1', 'tpl', 'tb', 'btn:1'), e('e2', 'ta', 'ib'), e('e3', 'tb', 'ib')],
  };

  it('advance BRANCHE par bouton : btn:1 -> suit l\'arête de CE bouton', async () => {
    const { ex, runs, calls } = make(branched);
    await ex.start('t1', 'wf1', branched, { waId: '33600', contactId: 'c1' });
    expect(runs.run).toMatchObject({ status: 'waiting', currentNode: 'tpl' });
    await ex.advance('t1', '33600', 'm1', 'btn:1'); // tape « Non »
    expect(calls).toContain('tag:non');
    expect(calls).not.toContain('tag:oui');
    expect(runs.run).toMatchObject({ status: 'inbox' });
  });

  it('advance REPLI : réponse texte (buttonPayload null) -> 1re arête sortante', async () => {
    const { ex, calls } = make(branched);
    await ex.start('t1', 'wf1', branched, { waId: '33600', contactId: 'c1' });
    await ex.advance('t1', '33600', 'm2', null);
    expect(calls).toContain('tag:oui'); // 1re arête (btn:0)
    expect(calls).not.toContain('tag:non');
  });

  it('advance REPLI : bouton non câblé (btn:9) -> 1re arête sortante', async () => {
    const { ex, calls } = make(branched);
    await ex.start('t1', 'wf1', branched, { waId: '33600', contactId: 'c1' });
    await ex.advance('t1', '33600', 'm3', 'btn:9');
    expect(calls).toContain('tag:oui'); // repli : aucun handle btn:9 -> nextNode
  });

  // Capture le 6e arg (explicitParams) de sendTemplate pour vérifier le câblage campagne workflow.
  function makeCapturing(graph: WorkflowGraph) {
    const runs = new FakeRuns();
    const captured: Array<string[] | undefined> = [];
    const ex = new WorkflowExecutor({
      runs,
      getGraph: async () => graph,
      applyTag: async () => {},
      setField: async () => {},
      removeTag: async () => {},
      clearField: async () => {},
      sendTemplate: async (_t, _w, _name, _lang, _btns, explicitParams) => { captured.push(explicitParams); },
      sendQuickMessage: async () => {},
      sendFlow: async () => {},
    });
    return { ex, captured };
  }

  it('start avec firstTemplateParams : le 1er sendTemplate reçoit ces params (campagne workflow, pas de re-résolution)', async () => {
    const g: WorkflowGraph = {
      nodes: [n('tpl', 'template', { templateName: 'promo', language: 'fr' }), n('ib', 'inbox')],
      edges: [e('e1', 'tpl', 'ib')],
    };
    const { ex, captured } = makeCapturing(g);
    await ex.start('t1', 'wf1', g, { waId: '33600', contactId: 'c1' }, ['Julie']);
    expect(captured).toEqual([['Julie']]);
  });

  // startFromNode (cible node de /v1/sends, D-1) : démarre à un bloc ARBITRAIRE, SANS la garde fenêtre 24 h
  // (l'appelant a déjà écarté les contacts hors fenêtre). `start` garde la sienne : cf. tests plus haut.
  describe('startFromNode', () => {
    it('démarre à un bloc du MILIEU du graphe (les blocs amont ne sont pas rejoués)', async () => {
      const g: WorkflowGraph = {
        nodes: [n('t', 'tag', { tag: 'amont' }), n('tpl', 'template', { templateName: 'promo', language: 'fr' }), n('ib', 'inbox')],
        edges: [e('e1', 't', 'tpl'), e('e2', 'tpl', 'ib')],
      };
      const { ex, runs, calls } = make(g);
      await ex.startFromNode('t1', 'wf1', g, { waId: '33600', contactId: 'c1' }, 'tpl');
      expect(calls).toEqual(['tpl:promo']); // pas de 'tag:amont' : on a sauté l'entrée
      expect(runs.run).toMatchObject({ status: 'waiting', currentNode: 'tpl' });
    });

    it('quick_message en cible : PART (contrairement à start qui le bloquerait)', async () => {
      const g: WorkflowGraph = { nodes: [n('qm', 'quick_message', { body: 'Salut', quickReplies: ['Oui', 'Non'] })], edges: [] };
      const { ex, runs, calls } = make(g);
      await ex.startFromNode('t1', 'wf1', g, { waId: '33600', contactId: 'c1' }, 'qm');
      expect(calls).toEqual(['qm:Salut']);
      expect(runs.run).toMatchObject({ status: 'waiting', currentNode: 'qm' });
      // NON-RÉGRESSION : le MÊME graphe via `start` reste refusé (garde 24 h intacte).
      const via = make(g);
      await via.ex.start('t1', 'wf1', g, { waId: '33600', contactId: 'c1' });
      expect(via.calls).toEqual([]);
      expect(via.runs.run).toBeNull();
    });

    it('flow en cible : PART aussi (message de session légitime en fenêtre ouverte)', async () => {
      const g: WorkflowGraph = { nodes: [n('f', 'flow', { flowId: 'fl1', flowName: 'RDV' })], edges: [] };
      const { ex, calls } = make(g);
      await ex.startFromNode('t1', 'wf1', g, { waId: '33600', contactId: 'c1' }, 'f');
      expect(calls).toEqual(['flow:fl1:Formulaire : RDV:Envoyer']);
    });

    it('bloc SUPPRIMÉ entre-temps (nodeId inconnu) -> aucune action, aucun run, aucun throw, et le NON-démarrage est signalé', async () => {
      const { ex, runs, calls } = make(linear);
      // Pas `true` = rien n'est parti : c'est ce que la campagne doit voir pour marquer le destinataire en échec
      // au lieu de le compter comme envoyé (revue Lot D). Depuis le 2026-08-15 le refus porte SA RAISON (une
      // chaîne) au lieu d'un simple `false`, pour que la campagne l'affiche telle quelle.
      const refus = await ex.startFromNode('t1', 'wf1', linear, { waId: '33600', contactId: 'c1' }, 'disparu');
      expect(refus).not.toBe(true);
      expect(typeof refus).toBe('string');
      expect(calls).toEqual([]);
      expect(runs.run).toBeNull();
    });

    it('cible 100 % synchrone (tag en fin de chaîne) : action appliquée, aucun run persistant', async () => {
      const g: WorkflowGraph = { nodes: [n('t', 'tag', { tag: 'x' })], edges: [] };
      const { ex, runs, calls } = make(g);
      await ex.startFromNode('t1', 'wf1', g, { waId: '33600', contactId: 'c1' }, 't');
      expect(calls).toEqual(['tag:x']);
      expect(runs.run).toBeNull();
    });
  });

  it('advance : sendTemplate SANS explicitParams (hints stockés -> comportement inchangé)', async () => {
    // tpl1 -> tpl2 -> inbox : start envoie tpl1 AVEC params, l\'advance envoie tpl2 SANS params (undefined).
    const g: WorkflowGraph = {
      nodes: [n('tpl1', 'template', { templateName: 't1', language: 'fr' }), n('tpl2', 'template', { templateName: 't2', language: 'fr' }), n('ib', 'inbox')],
      edges: [e('e1', 'tpl1', 'tpl2'), e('e2', 'tpl2', 'ib')],
    };
    const { ex, captured } = makeCapturing(g);
    await ex.start('t1', 'wf1', g, { waId: '33600', contactId: 'c1' }, ['Julie']);
    await ex.advance('t1', '33600', 'm1');
    expect(captured).toEqual([['Julie'], undefined]);
  });
});

describe('WorkflowExecutor : blocs condition & field NOW (contexte injecté par evalContext)', () => {
  function makeEval(graph: WorkflowGraph, ctx: EvalContext | null) {
    const runs = new FakeRuns();
    const calls: string[] = [];
    const ex = new WorkflowExecutor({
      runs,
      getGraph: async () => graph,
      applyTag: async (_t, _w, tag) => { calls.push(`tag:${tag}`); },
      setField: async (_t, _w, k, v) => { calls.push(`field:${k}=${v}`); },
      removeTag: async (_t, _w, tag) => { calls.push(`untag:${tag}`); },
      clearField: async (_t, _w, k) => { calls.push(`clear:${k}`); },
      sendTemplate: async (_t, _w, name) => { calls.push(`tpl:${name}`); },
      sendQuickMessage: async (_t, _w, body) => { calls.push(`qm:${body}`); },
      sendFlow: async (_t, _w, flowId) => { calls.push(`flow:${flowId}`); },
      evalContext: async () => ctx,
    });
    return { ex, runs, calls };
  }
  const baseCtx = (over: Partial<EvalContext> = {}): EvalContext => ({
    fields: {}, tags: [], optIn: 'unknown', name: null, phone: null, bsuid: null,
    now: new Date('2026-08-02T14:30:00Z'), timeZone: 'Europe/Paris',
    businessHours: {
      '0': { closed: true, open: '', close: '' }, '1': { closed: false, open: '09:00', close: '18:00' },
      '2': { closed: false, open: '09:00', close: '18:00' }, '3': { closed: false, open: '09:00', close: '18:00' },
      '4': { closed: false, open: '09:00', close: '18:00' }, '5': { closed: false, open: '09:00', close: '18:00' },
      '6': { closed: true, open: '', close: '' },
    },
    ...over,
  });
  // condition(vip ?) --true--> tag gold ; --false--> tag std
  const condGraph: WorkflowGraph = {
    nodes: [n('c', 'condition', { match: 'all', clauses: [{ kind: 'tag', op: 'has', tag: 'vip' }] }), n('g', 'tag', { tag: 'gold' }), n('s', 'tag', { tag: 'std' })],
    edges: [eh('e1', 'c', 'g', 'true'), eh('e2', 'c', 's', 'false')],
  };

  it('start : condition à l\'entrée route selon le ctx (vrai -> gold)', async () => {
    const { ex, calls } = makeEval(condGraph, baseCtx({ tags: ['vip'] }));
    await ex.start('t1', 'wf1', condGraph, { waId: '33600', contactId: 'c1' });
    expect(calls).toEqual(['tag:gold']);
  });
  it('start : condition fausse -> branche std', async () => {
    const { ex, calls } = makeEval(condGraph, baseCtx({ tags: [] }));
    await ex.start('t1', 'wf1', condGraph, { waId: '33600', contactId: 'c1' });
    expect(calls).toEqual(['tag:std']);
  });
  it('advance : condition APRÈS un template route selon le ctx', async () => {
    const g: WorkflowGraph = {
      nodes: [n('tpl', 'template', { templateName: 'promo', language: 'fr' }), n('c', 'condition', { match: 'all', clauses: [{ kind: 'tag', op: 'has', tag: 'vip' }] }), n('g', 'tag', { tag: 'gold' }), n('s', 'tag', { tag: 'std' })],
      edges: [e('e0', 'tpl', 'c'), eh('e1', 'c', 'g', 'true'), eh('e2', 'c', 's', 'false')],
    };
    const { ex, calls } = makeEval(g, baseCtx({ tags: ['vip'] }));
    await ex.start('t1', 'wf1', g, { waId: '33600', contactId: 'c1' });
    expect(calls).toEqual(['tpl:promo']);
    await ex.advance('t1', '33600', 'm1');
    expect(calls).toEqual(['tpl:promo', 'tag:gold']);
  });
  it('start : bloc field NOW -> setField reçoit l\'ISO UTC du ctx', async () => {
    const g: WorkflowGraph = { nodes: [n('f', 'field', { fieldKey: 'vu_le', valueKind: 'now' })], edges: [] };
    const { ex, calls } = makeEval(g, baseCtx({ now: new Date('2026-08-02T14:30:00Z') }));
    await ex.start('t1', 'wf1', g, { waId: '33600', contactId: 'c1' });
    expect(calls).toEqual(['field:vu_le=2026-08-02T14:30:00.000Z']);
  });
  it('evalContext renvoie null (contact introuvable) -> branche false déterministe', async () => {
    const { ex, calls } = makeEval(condGraph, null);
    await ex.start('t1', 'wf1', condGraph, { waId: '33600', contactId: 'c1' });
    expect(calls).toEqual(['tag:std']);
  });
  it('start : une BRANCHE de condition qui OUVRE par quick_message reste refusée par la garde 24h (aucun envoi, aucun run)', async () => {
    // condition (clauses vide -> all -> true) --true--> quick_message (ouverture session) ; --false--> template
    const g: WorkflowGraph = {
      nodes: [n('c', 'condition', { match: 'all', clauses: [] }), n('q', 'quick_message', { body: 'Salut', quickReplies: ['Oui'] }), n('tpl', 'template', { templateName: 'p' })],
      edges: [eh('e1', 'c', 'q', 'true'), eh('e2', 'c', 'tpl', 'false')],
    };
    const { ex, runs, calls } = makeEval(g, baseCtx());
    await ex.start('t1', 'wf1', g, { waId: '33600', contactId: 'c1' });
    expect(calls).toEqual([]);
    expect(runs.run).toBeNull();
  });
});

/**
 * INVARIANT le plus coûteux du lot Automation : un tag posé par un scénario ne publie « tag ajouté » QUE si ce
 * scénario a été lancé pour UN contact. Le même exécuteur sert les campagnes : sans ce garde-fou, une campagne
 * workflow de 5 000 destinataires dont le graphe contient un bloc Action publierait 5 000 événements, donc
 * potentiellement 5 000 scénarios et autant de messages facturés que personne n'a demandés.
 */
describe('publication « tag ajouté » : gouvernée par le CHEMIN, pas par l’action', () => {
  const graphe: WorkflowGraph = { nodes: [n('t', 'tag', { tag: 'vip' })], edges: [] };

  function exec(over: Partial<WorkflowExecutorDeps> = {}) {
    const emitted: string[] = [];
    const deps: WorkflowExecutorDeps = {
      runs: { start: async () => ({ id: 'r1' }), findWaitingByWaId: async () => null, setState: async () => {} },
      getGraph: async () => graphe,
      applyTag: async () => true, // le tag est réellement nouveau
      setField: async () => {}, removeTag: async () => {}, clearField: async () => {},
      sendTemplate: async () => {}, sendQuickMessage: async () => {}, sendFlow: async () => {},
      emitTagAdded: async (_t, _w, tag) => { emitted.push(tag); },
      ...over,
    };
    return { ex: new WorkflowExecutor(deps), emitted };
  }

  it('CAMPAGNE (start sans option) -> AUCUNE publication', async () => {
    const { ex, emitted } = exec();
    await ex.start('t1', 'wf1', graphe, { waId: '33611', contactId: 'c1' });
    expect(emitted).toEqual([]);
  });

  it('campagne ciblant un bloc (startFromNode sans option) -> AUCUNE publication', async () => {
    const { ex, emitted } = exec();
    await ex.startFromNode('t1', 'wf1', graphe, { waId: '33611', contactId: 'c1' }, 't');
    expect(emitted).toEqual([]);
  });

  it('démarrage UNITAIRE (automation / test) -> publication', async () => {
    const { ex, emitted } = exec();
    await ex.startInWindow('t1', 'wf1', graphe, { waId: '33611', contactId: 'c1' }, { emitEvents: true });
    expect(emitted).toEqual(['vip']);
  });

  it('tag DÉJÀ présent (applyTag renvoie false) -> aucune publication même en unitaire', async () => {
    const { ex, emitted } = exec({ applyTag: async () => false });
    await ex.startInWindow('t1', 'wf1', graphe, { waId: '33611', contactId: 'c1' }, { emitEvents: true });
    expect(emitted).toEqual([]);
  });

  it('une publication qui échoue ne fait pas échouer le parcours', async () => {
    const { ex } = exec({ emitTagAdded: async () => { throw new Error('file indisponible'); } });
    await expect(ex.startInWindow('t1', 'wf1', graphe, { waId: '33611', contactId: 'c1' }, { emitEvents: true })).resolves.toBe(true);
  });
});

describe('WorkflowExecutor.resume (réveil après un bloc Attente)', () => {
  const n2 = (id: string, type: WorkflowNodeType, data: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, data });

  /** tag -> attente -> <suite>. Le run dort sur 'w', la reprise doit repartir de la suite. */
  const grapheAvecSuite = (suite: ReturnType<typeof n2>): WorkflowGraph => ({
    nodes: [n2('t', 'tag', { tag: 'vip' }), n2('w', 'wait', { delay: 2, unit: 'hours' }), suite],
    edges: [{ id: 'e1', source: 't', target: 'w' }, { id: 'e2', source: 'w', target: suite.id }],
  });

  function makeResume(graph: WorkflowGraph, over: Partial<WorkflowExecutorDeps> = {}) {
    const runs = new FakeRuns();
    runs.run = { id: 'r1', workflowId: 'wf1', tenantId: 't1', waId: '33600', currentNode: 'w', status: 'sleeping', lastMessageId: null };
    const calls: string[] = [];
    const escalations: string[] = [];
    const emis: string[] = []; // événements d'automation publiés (tag ajouté)
    const ex = new WorkflowExecutor({
      runs,
      getGraph: async () => graph,
      applyTag: async (_t, _w, tag) => { calls.push(`tag:${tag}`); return true; },
      setField: async () => {},
      removeTag: async () => {},
      clearField: async () => {},
      sendTemplate: async (_t, _w, name) => { calls.push(`tpl:${name}`); },
      sendQuickMessage: async (_t, _w, body) => { calls.push(`qm:${body}`); },
      sendFlow: async (_t, _w, id) => { calls.push(`flow:${id}`); },
      escalateToHuman: async (_t, w) => { escalations.push(w); },
      emitTagAdded: async (_t, _w, tag) => { emis.push(tag); },
      ...over,
    });
    const run = { id: 'r1', workflowId: 'wf1', tenantId: 't1', waId: '33600', currentNode: 'w' };
    return { ex, runs, calls, escalations, emis, run };
  }

  it('reprend au bloc SUIVANT l’attente, jamais sur l’attente elle-même (sinon le parcours se rendort en boucle)', async () => {
    const { ex, runs, calls, run } = makeResume(grapheAvecSuite(n2('tpl', 'template', { templateName: 'relance' })));
    expect(await ex.resume(run)).toBe(true);
    expect(calls).toEqual(['tpl:relance']);
    expect(runs.run).toMatchObject({ status: 'waiting', currentNode: 'tpl' });
  });

  it('un TEMPLATE part même hors fenêtre 24 h : c’est tout son intérêt', async () => {
    const { ex, calls, run } = makeResume(grapheAvecSuite(n2('tpl', 'template', { templateName: 'relance' })), {
      isWindowOpen: async () => false,
    });
    expect(await ex.resume(run)).toBe(true);
    expect(calls).toEqual(['tpl:relance']);
  });

  it('un MESSAGE RAPIDE hors fenêtre n’est PAS envoyé, et la conversation part en inbox', async () => {
    const suite = n2('qm', 'quick_message', { body: 'Alors ?', quickReplies: ['Oui'] });
    const { ex, runs, calls, escalations, run } = makeResume(grapheAvecSuite(suite), { isWindowOpen: async () => false });
    expect(await ex.resume(run)).toBe(false);
    expect(calls).toEqual([]); // rien n'est parti
    expect(runs.run).toMatchObject({ status: 'inbox' });
    expect(escalations).toEqual(['33600']);
  });

  it('même message rapide, mais fenêtre OUVERTE -> envoyé normalement', async () => {
    const suite = n2('qm', 'quick_message', { body: 'Alors ?', quickReplies: ['Oui'] });
    const { ex, calls, run } = makeResume(grapheAvecSuite(suite), { isWindowOpen: async () => true });
    expect(await ex.resume(run)).toBe(true);
    expect(calls).toEqual(['qm:Alors ?']);
  });

  it('SANS dep de fenêtre -> fenêtre considérée FERMÉE (on préfère ne rien envoyer qu’un envoi refusé par Meta)', async () => {
    const suite = n2('qm', 'quick_message', { body: 'Alors ?', quickReplies: ['Oui'] });
    const { ex, calls, run } = makeResume(grapheAvecSuite(suite));
    expect(await ex.resume(run)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('fil repris par un humain pendant l’attente -> aucune action, run clos', async () => {
    const { ex, runs, calls, run } = makeResume(grapheAvecSuite(n2('tpl', 'template', { templateName: 'relance' })), {
      mayAct: async () => false,
    });
    expect(await ex.resume(run)).toBe(false);
    expect(calls).toEqual([]);
    expect(runs.run).toMatchObject({ status: 'done' });
  });

  it('bloc supprimé du graphe pendant l’attente -> run clos, jamais laissé dormant', async () => {
    const { ex, runs, run } = makeResume({ nodes: [n2('autre', 'tag', { tag: 'x' })], edges: [] });
    expect(await ex.resume(run)).toBe(false);
    expect(runs.run).toMatchObject({ status: 'done' });
  });

  it('attente en fin de chaîne (aucune suite) -> run clos', async () => {
    const graph: WorkflowGraph = { nodes: [n2('w', 'wait', { delay: 1, unit: 'hours' })], edges: [] };
    const { ex, runs, run } = makeResume(graph);
    expect(await ex.resume(run)).toBe(false);
    expect(runs.run).toMatchObject({ status: 'done' });
  });

  it('la reprise PUBLIE l’événement « tag ajouté », comme après une réponse du contact', async () => {
    // Un réveil est unitaire par nature (un contact, ici et maintenant). Sans ça, « attendre 1 jour puis poser
    // le tag relance » ne déclencherait pas l'automation branchée dessus, alors que le MÊME tag posé après une
    // réponse la déclenche. Les campagnes, elles, n'émettent pas (5 000 destinataires = 5 000 événements).
    const graph: WorkflowGraph = {
      nodes: [n2('w', 'wait', { delay: 1, unit: 'hours' }), n2('tg', 'tag', { tag: 'relance_j1' })],
      edges: [{ id: 'e1', source: 'w', target: 'tg' }],
    };
    const { ex, calls, emis, run } = makeResume(graph);
    expect(await ex.resume(run)).toBe(true);
    expect(calls).toEqual(['tag:relance_j1']);
    expect(emis).toEqual(['relance_j1']);
  });

  it('envoi REFUSÉ au réveil -> run clos et conversation remontée à un humain', async () => {
    // Laisser le run en attente le ferait repartir au bloc SUIVANT dès que le contact écrirait, en réponse à
    // un message qu'il n'a jamais reçu.
    const { ex, runs, escalations, run } = makeResume(
      grapheAvecSuite(n2('tpl', 'template', { templateName: 'relance' })),
      { sendTemplate: async () => 'template « relance » introuvable chez Meta' },
    );
    expect(await ex.resume(run)).toBe(false);
    expect(runs.run).toMatchObject({ status: 'inbox' });
    expect(escalations).toEqual(['33600']);
  });

  it('DEUX attentes à la suite : la reprise redort, avec la nouvelle échéance', async () => {
    const graph: WorkflowGraph = {
      nodes: [n2('w', 'wait', { delay: 1, unit: 'hours' }), n2('w2', 'wait', { delay: 3, unit: 'minutes' }), n2('tpl', 'template', { templateName: 'p' })],
      edges: [{ id: 'e1', source: 'w', target: 'w2' }, { id: 'e2', source: 'w2', target: 'tpl' }],
    };
    const { ex, runs, run } = makeResume(graph, { now: () => 1_000_000 });
    expect(await ex.resume(run)).toBe(true);
    expect(runs.run).toMatchObject({ status: 'sleeping', currentNode: 'w2' });
  });
});

/**
 * Un envoi REFUSÉ à l'intérieur d'un scénario ne doit jamais être compté comme parti.
 *
 * Le refus est décidé dans le worker (visuel de carte non re-téléversable, variable sans valeur, template
 * absent chez Meta). Il n'existait que dans les logs : la campagne affichait « envoyé » avec l'identifiant
 * synthétique `wf-<id>` et rien n'arrivait sur le téléphone. Vécu trois fois en production le 2026-08-15.
 */
describe('WorkflowExecutor : remontée d’un envoi refusé', () => {
  const linear: WorkflowGraph = {
    nodes: [n('t', 'tag', { tag: 'vip' }), n('tpl', 'template', { templateName: 'promo', language: 'fr' }), n('ib', 'inbox')],
    edges: [e('e1', 't', 'tpl'), e('e2', 'tpl', 'ib')],
  };
  const RAISON = 'template « promo » : l’image de la carte 2 n’a pas pu être préparée pour l’envoi';

  it('start : la raison EXACTE remonte à l’appelant (c’est elle que la campagne affiche)', async () => {
    const { ex } = make(linear, { sendTemplate: async () => RAISON });
    expect(await ex.start('t1', 'wf1', linear, { waId: '33600', contactId: 'c1' })).toBe(RAISON);
  });

  it('start refusé : AUCUN run en attente n’est laissé derrière', async () => {
    // Sinon il attendrait une réponse à un message jamais reçu, et le premier message du contact le ferait
    // repartir au bloc SUIVANT, sorti de nulle part.
    const { ex, runs } = make(linear, { sendTemplate: async () => RAISON });
    await ex.start('t1', 'wf1', linear, { waId: '33600', contactId: 'c1' });
    expect(runs.run).toBeNull();
  });

  it('start refusé : les actions synchrones déjà appliquées le restent (on ne les rejoue pas)', async () => {
    const { ex, calls } = make(linear, { sendTemplate: async () => RAISON });
    await ex.start('t1', 'wf1', linear, { waId: '33600', contactId: 'c1' });
    expect(calls).toEqual(['tag:vip']);
  });

  it('start qui PASSE : toujours `true`, run en attente au template (non-régression)', async () => {
    const { ex, runs } = make(linear);
    expect(await ex.start('t1', 'wf1', linear, { waId: '33600', contactId: 'c1' })).toBe(true);
    expect(runs.run).toMatchObject({ status: 'waiting', currentNode: 'tpl' });
  });

  it('une chaîne VIDE rendue par un câblage n’est pas un refus', async () => {
    const { ex, runs } = make(linear, { sendTemplate: async () => '' });
    expect(await ex.start('t1', 'wf1', linear, { waId: '33600', contactId: 'c1' })).toBe(true);
    expect(runs.run).toMatchObject({ status: 'waiting' });
  });

  it('advance : envoi refusé -> run clos et conversation remontée à un humain', async () => {
    const g: WorkflowGraph = {
      nodes: [n('tpl1', 'template', { templateName: 'a', language: 'fr' }), n('tpl2', 'template', { templateName: 'b', language: 'fr' })],
      edges: [e('e1', 'tpl1', 'tpl2')],
    };
    let refuse = false;
    const { ex, runs, escalations } = make(g, { sendTemplate: async () => (refuse ? 'variable sans valeur pour ce contact' : undefined) });
    await ex.start('t1', 'wf1', g, { waId: '33600', contactId: 'c1' });
    refuse = true;
    await ex.advance('t1', '33600', 'm1');
    expect(runs.run).toMatchObject({ status: 'inbox', currentNode: null });
    expect(escalations).toEqual(['33600']);
  });
});
