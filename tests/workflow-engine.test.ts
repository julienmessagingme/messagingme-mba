import { describe, it, expect } from 'vitest';
import { walk, entryNode, nextNode, nextNodeByHandle, opensOutsideServiceWindow } from '../src/workflow/engine';
import type { WorkflowGraph, WorkflowNodeType } from '../src/workflow/graph';
import type { EvalContext, BusinessHours } from '../src/workflow/conditions';

const n = (id: string, type: WorkflowNodeType, data: Record<string, unknown> = {}): WorkflowGraph['nodes'][number] => ({ id, type, position: { x: 0, y: 0 }, data });
const e = (id: string, source: string, target: string) => ({ id, source, target });
const eh = (id: string, source: string, target: string, sourceHandle: string) => ({ id, source, target, sourceHandle });

const BH_9_18: BusinessHours = {
  '0': { closed: true, open: '', close: '' }, '1': { closed: false, open: '09:00', close: '18:00' },
  '2': { closed: false, open: '09:00', close: '18:00' }, '3': { closed: false, open: '09:00', close: '18:00' },
  '4': { closed: false, open: '09:00', close: '18:00' }, '5': { closed: false, open: '09:00', close: '18:00' },
  '6': { closed: true, open: '', close: '' },
};
const evalCtx = (over: Partial<EvalContext> = {}): EvalContext => ({
  fields: {}, tags: [], optIn: 'unknown', name: null, phone: null, bsuid: null,
  now: new Date('2026-08-03T12:00:00Z'), timeZone: 'Europe/Paris', businessHours: BH_9_18, ...over,
});

// tag(vip) -> template(promo) -> inbox
const linear: WorkflowGraph = {
  nodes: [n('t', 'tag', { tag: 'vip' }), n('tpl', 'template', { templateName: 'promo', language: 'fr' }), n('ib', 'inbox')],
  edges: [e('e1', 't', 'tpl'), e('e2', 'tpl', 'ib')],
};

describe('entryNode / nextNode', () => {
  it('entryNode = bloc sans arête entrante', () => {
    expect(entryNode(linear)).toBe('t');
  });
  it('nextNode = cible de la 1re arête sortante', () => {
    expect(nextNode(linear, 't')).toBe('tpl');
    expect(nextNode(linear, 'ib')).toBeNull();
  });
  it('graphe vide -> entryNode null', () => {
    expect(entryNode({ nodes: [], edges: [] })).toBeNull();
  });
});

describe('nextNodeByHandle', () => {
  const g: WorkflowGraph = {
    nodes: [n('tpl', 'template', { templateName: 'p' }), n('a', 'tag', { tag: 'a' }), n('b', 'tag', { tag: 'b' })],
    edges: [eh('e0', 'tpl', 'a', 'btn:0'), eh('e1', 'tpl', 'b', 'btn:1')],
  };
  it('suit l\'arête du handle demandé', () => {
    expect(nextNodeByHandle(g, 'tpl', 'btn:0')).toBe('a');
    expect(nextNodeByHandle(g, 'tpl', 'btn:1')).toBe('b');
  });
  it('handle inconnu -> null (le repli nextNode est géré par l\'appelant)', () => {
    expect(nextNodeByHandle(g, 'tpl', 'btn:9')).toBeNull();
    expect(nextNode(g, 'tpl')).toBe('a'); // repli = 1re arête
  });
});

describe('walk : action sendTemplate porte les boutons du template', () => {
  it('template avec boutons -> action { buttons }', () => {
    const g: WorkflowGraph = {
      nodes: [n('tpl', 'template', { templateName: 'promo', language: 'fr', templateButtons: [{ type: 'QUICK_REPLY', text: 'Oui' }, { type: 'URL', text: 'Site', url: 'https://x' }] })],
      edges: [],
    };
    const r = walk(g, 'tpl');
    expect(r.actions).toEqual([{ kind: 'sendTemplate', templateName: 'promo', language: 'fr', buttons: [{ type: 'QUICK_REPLY', text: 'Oui' }, { type: 'URL', text: 'Site' }] }]);
  });
});

describe('walk : quick_message', () => {
  it('corps + réponses -> action sendQuickMessage (ordre préservé), waiting', () => {
    const g: WorkflowGraph = { nodes: [n('qm', 'quick_message', { body: 'Ça te va ?', quickReplies: ['Oui', 'Non'] })], edges: [] };
    const r = walk(g, 'qm');
    expect(r.actions).toEqual([{ kind: 'sendQuickMessage', body: 'Ça te va ?', buttons: [{ type: 'QUICK_REPLY', text: 'Oui' }, { type: 'QUICK_REPLY', text: 'Non' }] }]);
    expect(r.rest).toEqual({ status: 'waiting', nodeId: 'qm' });
  });
  it('sans corps -> pas d\'action mais attend quand même (bloc bloquant)', () => {
    const g: WorkflowGraph = { nodes: [n('qm', 'quick_message', { body: '', quickReplies: ['Oui'] })], edges: [] };
    const r = walk(g, 'qm');
    expect(r.actions).toEqual([]);
    expect(r.rest).toEqual({ status: 'waiting', nodeId: 'qm' });
  });
  it('aucune réponse non vide -> pas d\'action', () => {
    const g: WorkflowGraph = { nodes: [n('qm', 'quick_message', { body: 'Salut', quickReplies: ['', ''] })], edges: [] };
    expect(walk(g, 'qm').actions).toEqual([]);
  });
});

describe('walk : node flow (Lot 7 : envoi du formulaire, fini le no-op)', () => {
  it('flowId + nom -> action sendFlow avec accroche et cta par défaut, waiting', () => {
    const g: WorkflowGraph = { nodes: [n('f', 'flow', { flowId: 'fl1', flowName: 'Prise de RDV' })], edges: [] };
    const r = walk(g, 'f');
    expect(r.actions).toEqual([{ kind: 'sendFlow', flowId: 'fl1', flowName: 'Prise de RDV', body: 'Formulaire : Prise de RDV', cta: 'Envoyer' }]);
    expect(r.rest).toEqual({ status: 'waiting', nodeId: 'f' });
  });
  it('accroche et cta du node prioritaires (cta tronqué à 30)', () => {
    const g: WorkflowGraph = { nodes: [n('f', 'flow', { flowId: 'fl1', flowName: 'RDV', body: ' Réserve ton créneau ', cta: 'Un libellé beaucoup trop long pour un bouton' })], edges: [] };
    expect(walk(g, 'f').actions).toEqual([
      { kind: 'sendFlow', flowId: 'fl1', flowName: 'RDV', body: 'Réserve ton créneau', cta: 'Un libellé beaucoup trop long ' },
    ]);
  });
  it('sans flowId -> pas d\'action mais attend quand même (bloc bloquant, contrat historique)', () => {
    const g: WorkflowGraph = { nodes: [n('f', 'flow', {})], edges: [] };
    const r = walk(g, 'f');
    expect(r.actions).toEqual([]);
    expect(r.rest).toEqual({ status: 'waiting', nodeId: 'f' });
  });
});

describe('opensOutsideServiceWindow (garde fenêtre 24 h à l\'ouverture)', () => {
  it('flow (ou chaîne synchrone -> flow) en ouverture -> true', () => {
    const direct: WorkflowGraph = { nodes: [n('f', 'flow', { flowId: 'fl1' })], edges: [] };
    expect(opensOutsideServiceWindow(direct)).toBe(true);
    const chained: WorkflowGraph = {
      nodes: [n('t', 'tag', { tag: 'vip' }), n('f', 'flow', { flowId: 'fl1' })],
      edges: [e('e1', 't', 'f')],
    };
    expect(opensOutsideServiceWindow(chained)).toBe(true);
  });
  it('quick_message en ouverture -> true ; template en ouverture -> false', () => {
    const qm: WorkflowGraph = { nodes: [n('q', 'quick_message', { body: 'Salut', quickReplies: ['Oui'] })], edges: [] };
    expect(opensOutsideServiceWindow(qm)).toBe(true);
    expect(opensOutsideServiceWindow(linear)).toBe(false);
  });
  it('flow APRÈS un template (pas en ouverture) -> false ; flow d\'ouverture NON configuré (sans flowId) -> false', () => {
    const after: WorkflowGraph = {
      nodes: [n('tpl', 'template', { templateName: 'promo', language: 'fr' }), n('f', 'flow', { flowId: 'fl1' })],
      edges: [e('e1', 'tpl', 'f')],
    };
    expect(opensOutsideServiceWindow(after)).toBe(false);
    // Node flow vide : aucune action produite -> le graphe reste enregistrable pendant la construction.
    const unconfigured: WorkflowGraph = { nodes: [n('f', 'flow', {})], edges: [] };
    expect(opensOutsideServiceWindow(unconfigured)).toBe(false);
  });
  it('graphe vide -> false', () => {
    expect(opensOutsideServiceWindow({ nodes: [], edges: [] })).toBe(false);
  });
  it('condition dont une branche OUVRE par un message de session -> true (branch-aware)', () => {
    // condition --true--> quick_message (ouverture session illégale) ; --false--> template (légal)
    const g: WorkflowGraph = {
      nodes: [n('c', 'condition', { match: 'all', clauses: [] }), n('q', 'quick_message', { body: 'Salut', quickReplies: ['Oui'] }), n('tpl', 'template', { templateName: 'p' })],
      edges: [eh('e1', 'c', 'q', 'true'), eh('e2', 'c', 'tpl', 'false')],
    };
    expect(opensOutsideServiceWindow(g)).toBe(true);
  });
  it('condition dont les DEUX branches sont légales (template) -> false', () => {
    const g: WorkflowGraph = {
      nodes: [n('c', 'condition', { match: 'all', clauses: [] }), n('a', 'template', { templateName: 'a' }), n('b', 'template', { templateName: 'b' })],
      edges: [eh('e1', 'c', 'a', 'true'), eh('e2', 'c', 'b', 'false')],
    };
    expect(opensOutsideServiceWindow(g)).toBe(false);
  });
});

describe('walk', () => {
  it('depuis l\'entrée : applique le tag SYNCHRONE puis s\'arrête au template (waiting)', () => {
    const r = walk(linear, entryNode(linear)!);
    expect(r.actions).toEqual([
      { kind: 'tag', tag: 'vip' },
      { kind: 'sendTemplate', templateName: 'promo', language: 'fr', buttons: [] },
    ]);
    expect(r.rest).toEqual({ status: 'waiting', nodeId: 'tpl' });
  });

  it('depuis le bloc après le template (inbox) : rest=inbox, aucune action', () => {
    const r = walk(linear, nextNode(linear, 'tpl')!);
    expect(r.actions).toEqual([]);
    expect(r.rest).toEqual({ status: 'inbox' });
  });

  it('bloc field -> action field', () => {
    const g: WorkflowGraph = { nodes: [n('f', 'field', { fieldKey: 'ville', value: 'Lyon' }), n('ib', 'inbox')], edges: [e('e', 'f', 'ib')] };
    const r = walk(g, 'f');
    expect(r.actions).toEqual([{ kind: 'field', key: 'ville', value: 'Lyon' }]);
    expect(r.rest).toEqual({ status: 'inbox' });
  });

  it('tag sans arête sortante -> done', () => {
    const g: WorkflowGraph = { nodes: [n('t', 'tag', { tag: 'x' })], edges: [] };
    expect(walk(g, 't').rest).toEqual({ status: 'done' });
  });

  it('cycle -> stoppe (done), pas de boucle infinie', () => {
    const g: WorkflowGraph = { nodes: [n('a', 'tag', { tag: 'a' }), n('b', 'tag', { tag: 'b' })], edges: [e('e1', 'a', 'b'), e('e2', 'b', 'a')] };
    const r = walk(g, 'a');
    expect(r.actions).toEqual([{ kind: 'tag', tag: 'a' }, { kind: 'tag', tag: 'b' }]);
    expect(r.rest).toEqual({ status: 'done' });
  });

  it('bloc de départ inconnu -> done sans action', () => {
    expect(walk(linear, 'zzz')).toEqual({ actions: [], rest: { status: 'done' } });
  });

  it('template sans templateName -> pas d\'action mais attend quand même', () => {
    const g: WorkflowGraph = { nodes: [n('tpl', 'template')], edges: [] };
    const r = walk(g, 'tpl');
    expect(r.actions).toEqual([]);
    expect(r.rest).toEqual({ status: 'waiting', nodeId: 'tpl' });
  });
});

describe('walk : node condition (branche « Si réunie » / « Sinon »)', () => {
  // condition(tag vip ?) --true--> tag(gold) ; --false--> tag(std)
  const cond: WorkflowGraph = {
    nodes: [
      n('c', 'condition', { match: 'all', clauses: [{ kind: 'tag', op: 'has', tag: 'vip' }] }),
      n('g', 'tag', { tag: 'gold' }), n('s', 'tag', { tag: 'std' }),
    ],
    edges: [eh('e1', 'c', 'g', 'true'), eh('e2', 'c', 's', 'false')],
  };
  it('condition vraie -> sortie true (aucune action de condition, on continue)', () => {
    const r = walk(cond, 'c', evalCtx({ tags: ['vip'] }));
    expect(r.actions).toEqual([{ kind: 'tag', tag: 'gold' }]);
    expect(r.rest).toEqual({ status: 'done' });
  });
  it('condition fausse -> sortie false', () => {
    expect(walk(cond, 'c', evalCtx({ tags: ['autre'] })).actions).toEqual([{ kind: 'tag', tag: 'std' }]);
  });
  it('sans contexte (ctx absent : analyse de graphe pure) -> branche false DÉTERMINISTE', () => {
    expect(walk(cond, 'c').actions).toEqual([{ kind: 'tag', tag: 'std' }]);
  });
  it('sortie false en arête simple (repli nextNode) quand aucun handle false', () => {
    const g: WorkflowGraph = {
      nodes: [n('c', 'condition', { match: 'all', clauses: [{ kind: 'tag', op: 'has', tag: 'vip' }] }), n('s', 'tag', { tag: 'std' })],
      edges: [e('e1', 'c', 's')],
    };
    expect(walk(g, 'c', evalCtx({ tags: [] })).actions).toEqual([{ kind: 'tag', tag: 'std' }]);
  });
  it('data de condition malformée -> coerce défensif (clauses non-array -> [] -> all vrai) -> sortie true', () => {
    const g: WorkflowGraph = {
      nodes: [n('c', 'condition', { clauses: 'pas-un-array' }), n('g', 'tag', { tag: 'gold' }), n('s', 'tag', { tag: 'std' })],
      edges: [eh('e1', 'c', 'g', 'true'), eh('e2', 'c', 's', 'false')],
    };
    expect(walk(g, 'c', evalCtx()).actions).toEqual([{ kind: 'tag', tag: 'gold' }]);
  });
  it('condition sans sortie câblée -> done sans action', () => {
    const g: WorkflowGraph = { nodes: [n('c', 'condition', { match: 'all', clauses: [] })], edges: [] };
    expect(walk(g, 'c', evalCtx())).toEqual({ actions: [], rest: { status: 'done' } });
  });
  it('boucle de conditions -> anti-cycle -> done (pas de boucle infinie)', () => {
    const g: WorkflowGraph = {
      nodes: [n('a', 'condition', { match: 'all', clauses: [] }), n('b', 'condition', { match: 'all', clauses: [] })],
      edges: [eh('e1', 'a', 'b', 'true'), eh('e2', 'b', 'a', 'true')],
    };
    expect(walk(g, 'a', evalCtx()).rest).toEqual({ status: 'done' });
  });
  it('sortie « true » SEULE câblée + condition FAUSSE -> done (ne VOLE PAS la branche true)', () => {
    const g: WorkflowGraph = {
      nodes: [n('c', 'condition', { match: 'all', clauses: [{ kind: 'tag', op: 'has', tag: 'vip' }] }), n('g', 'tag', { tag: 'gold' })],
      edges: [eh('e1', 'c', 'g', 'true')], // seule la sortie 'true' est câblée
    };
    const r = walk(g, 'c', evalCtx({ tags: [] })); // condition fausse
    expect(r.actions).toEqual([]); // n'emprunte PAS l'arête 'true'
    expect(r.rest).toEqual({ status: 'done' });
  });
  it('sortie « false » SEULE câblée + condition VRAIE -> done (symétrique)', () => {
    const g: WorkflowGraph = {
      nodes: [n('c', 'condition', { match: 'all', clauses: [{ kind: 'tag', op: 'has', tag: 'vip' }] }), n('s', 'tag', { tag: 'std' })],
      edges: [eh('e1', 'c', 's', 'false')],
    };
    const r = walk(g, 'c', evalCtx({ tags: ['vip'] })); // condition vraie
    expect(r.actions).toEqual([]);
    expect(r.rest).toEqual({ status: 'done' });
  });
});

describe('walk : le ctx reflète les tag/field posés PLUS TÔT dans la même chaîne synchrone', () => {
  it('field NOW -> condition datetime not_empty sur CE champ -> branche true (cas d’usage phare)', () => {
    const g: WorkflowGraph = {
      nodes: [
        n('f', 'field', { fieldKey: 'visite_le', valueKind: 'now' }),
        n('c', 'condition', { match: 'all', clauses: [{ kind: 'datetime', key: 'visite_le', op: 'not_empty' }] }),
        n('a', 'tag', { tag: 'vu' }), n('b', 'tag', { tag: 'pas_vu' }),
      ],
      edges: [e('e0', 'f', 'c'), eh('e1', 'c', 'a', 'true'), eh('e2', 'c', 'b', 'false')],
    };
    // Contact SANS visite_le en base : c'est le field NOW qui vient de le poser dans CE walk.
    const r = walk(g, 'f', evalCtx({ fields: {} }));
    expect(r.actions).toContainEqual({ kind: 'tag', tag: 'vu' });
    expect(r.actions).not.toContainEqual({ kind: 'tag', tag: 'pas_vu' });
  });
  it('tag -> condition has CE MÊME tag -> branche true', () => {
    const g: WorkflowGraph = {
      nodes: [
        n('t', 'tag', { tag: 'vip' }),
        n('c', 'condition', { match: 'all', clauses: [{ kind: 'tag', op: 'has', tag: 'vip' }] }),
        n('a', 'tag', { tag: 'oui' }), n('b', 'tag', { tag: 'non' }),
      ],
      edges: [e('e0', 't', 'c'), eh('e1', 'c', 'a', 'true'), eh('e2', 'c', 'b', 'false')],
    };
    expect(walk(g, 't', evalCtx({ tags: [] })).actions).toEqual([{ kind: 'tag', tag: 'vip' }, { kind: 'tag', tag: 'oui' }]);
  });
});

describe('walk : bloc field en mode NOW (horodatage courant)', () => {
  it('valueKind now -> valeur = ISO UTC du contexte (comparable par une condition datetime)', () => {
    const g: WorkflowGraph = { nodes: [n('f', 'field', { fieldKey: 'derniere_visite', valueKind: 'now' }), n('ib', 'inbox')], edges: [e('e', 'f', 'ib')] };
    const r = walk(g, 'f', evalCtx({ now: new Date('2026-08-02T14:30:00Z') }));
    expect(r.actions).toEqual([{ kind: 'field', key: 'derniere_visite', value: '2026-08-02T14:30:00.000Z' }]);
  });
  it('valueKind now SANS contexte -> valeur vide (non exécuté hors run)', () => {
    const g: WorkflowGraph = { nodes: [n('f', 'field', { fieldKey: 'x', valueKind: 'now' })], edges: [] };
    expect(walk(g, 'f').actions).toEqual([{ kind: 'field', key: 'x', value: '' }]);
  });
  it('field valeur FIXE inchangé (pas de valueKind)', () => {
    const g: WorkflowGraph = { nodes: [n('f', 'field', { fieldKey: 'ville', value: 'Lyon' })], edges: [] };
    expect(walk(g, 'f', evalCtx()).actions).toEqual([{ kind: 'field', key: 'ville', value: 'Lyon' }]);
  });
});
