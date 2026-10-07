import { describe, it, expect } from 'vitest';
import { walk, scanOpening, waitBeforeSessionMessage, nextNode, nextNodeByHandle } from '../src/workflow/engine';
import {
  famillesDeCondition, sortiesDeCondition, sortieDeCondition, poigneeDeFamille, clausesDuBloc, besoinsDesClauses,
  evaluateConditionGroup, coerceConditionGroup, MAX_FAMILLES_CONDITION, type EvalContext,
} from '../src/workflow/conditions';
import type { WorkflowGraph, WorkflowNodeType } from '../src/workflow/graph';

/**
 * LE BLOC CONDITION À FAMILLES (RC5, livraison A).
 *
 * Un bloc a N familles nommées (10 au plus), chacune son groupe en ET ou en OU ; le contact suit la PREMIÈRE vraie,
 * de haut en bas, sinon « Sinon ». Deux propriétés décident de la justesse, et chacune a sa moitié de fichier :
 *
 * 🔴 LA COMPATIBILITÉ SANS MIGRATION. Les graphes publiés n'ont pas `familles` : chacun doit se lire comme une famille
 * unique de poignée `true`, « Sinon » restant `false`, et suivre EXACTEMENT les sorties d'avant. La référence est le
 * code d'avant lui-même, recopié ci-dessous (`ancienneSortie`), pas une attente réécrite à la main.
 *
 * 🔴 CHAQUE LECTEUR DU GRAPHE VOIT UNE FAMILLE NEUVE. `true` / `false` étaient écrits en dur à six endroits ; un
 * lecteur qui l'oublierait laisserait une branche invisible à l'analyse, sans aucune erreur.
 */

const n = (id: string, type: WorkflowNodeType, data: Record<string, unknown> = {}): WorkflowGraph['nodes'][number] => ({ id, type, position: { x: 0, y: 0 }, data });
const e = (id: string, source: string, target: string, sourceHandle?: string) => ({ id, source, target, ...(sourceHandle ? { sourceHandle } : {}) });
const ctx = (over: Partial<EvalContext> = {}): EvalContext => ({
  fields: {}, tags: [], optIn: 'unknown', name: null, phone: null, bsuid: null, analyse: null,
  now: new Date('2026-08-03T12:00:00Z'), timeZone: 'Europe/Paris', businessHours: {}, ...over,
});
const aTag = (tag: string) => ({ match: 'all', clauses: [{ kind: 'tag', op: 'has', tag }] });

/** Trois familles : « VIP » (tag vip), « Gold » (tag gold), « Pro » (tag pro), puis « Sinon ». */
const TROIS = { familles: [
  { code: 'true', nom: 'VIP', groupe: aTag('vip') },
  { code: 'k2', nom: 'Gold', groupe: aTag('gold') },
  { code: 'k3', nom: 'Pro', groupe: aTag('pro') },
] };

describe('famillesDeCondition : la lecture d’un bloc', () => {
  it('🔴 un bloc SANS `familles` est UNE famille de code `true`, qui porte son groupe d’origine', () => {
    const data = { match: 'any', clauses: [{ kind: 'tag', op: 'has', tag: 'vip' }] };
    expect(famillesDeCondition(data)).toEqual([{ code: 'true', nom: '', groupe: { match: 'any', clauses: data.clauses } }]);
    // Ses sorties sont EXACTEMENT celles qui étaient écrites en dur.
    expect(sortiesDeCondition(n('c', 'condition', data))).toEqual(['true', 'false']);
    expect(sortiesDeCondition(n('c', 'condition', {}))).toEqual(['true', 'false']);
  });

  it('les familles d’un bloc neuf, dans leur ordre, chacune sa poignée stable, « Sinon » en dernier', () => {
    expect(sortiesDeCondition(n('c', 'condition', TROIS))).toEqual(['true', 'famille:k2', 'famille:k3', 'false']);
    expect(poigneeDeFamille('true')).toBe('true');
    expect(poigneeDeFamille('k2')).toBe('famille:k2');
  });

  it('borné au moteur : dix familles au plus, codes invalides, en double ou « false » écartés', () => {
    const douze = Array.from({ length: 12 }, (_, i) => ({ code: `c${i}`, nom: `F${i}`, groupe: aTag('x') }));
    expect(famillesDeCondition({ familles: douze })).toHaveLength(MAX_FAMILLES_CONDITION);
    const sales = { familles: [
      { code: 'a', groupe: aTag('x') }, { code: 'a', groupe: aTag('y') }, // doublon : le premier gagne
      { code: 'false', groupe: aTag('x') }, // le code de « Sinon » ne peut pas être une famille
      { code: 'a:b', groupe: aTag('x') }, { code: '', groupe: aTag('x') }, { code: 12 }, null, 'texte',
      { code: 'b' }, // groupe absent : un groupe vide en ET, donc toujours vrai, comme un bloc sans clause
    ] };
    expect(famillesDeCondition(sales).map((f) => f.code)).toEqual(['a', 'b']);
    expect(famillesDeCondition(sales)[1]!.groupe).toEqual({ match: 'all', clauses: [] });
  });

  it('`familles` vide : seulement « Sinon » ; il fait foi, l’ancienne forme n’est plus lue', () => {
    expect(sortiesDeCondition(n('c', 'condition', { familles: [], clauses: [] }))).toEqual(['false']);
  });

  it('les clauses du bloc, toutes familles confondues', () => {
    expect(clausesDuBloc(TROIS).map((c) => (c as { tag: string }).tag)).toEqual(['vip', 'gold', 'pro']);
    expect(clausesDuBloc({ match: 'all', clauses: [{ kind: 'tag', op: 'has', tag: 'x' }] })).toHaveLength(1);
  });
});

describe('sortieDeCondition : la première famille vraie, de haut en bas', () => {
  it('🔴 deux familles vraies : la PREMIÈRE gagne', () => {
    expect(sortieDeCondition(TROIS, ctx({ tags: ['gold', 'pro'] }))).toBe('famille:k2');
    expect(sortieDeCondition(TROIS, ctx({ tags: ['pro', 'vip'] }))).toBe('true');
  });
  it('aucune vraie : « Sinon »', () => {
    expect(sortieDeCondition(TROIS, ctx({ tags: ['autre'] }))).toBe('false');
  });
  it('l’ordre est celui du tableau, pas celui des codes', () => {
    const inverse = { familles: [...TROIS.familles].reverse() };
    expect(sortieDeCondition(inverse, ctx({ tags: ['vip', 'pro'] }))).toBe('famille:k3');
  });
});

/**
 * Le pas « condition » de `walk`, tel qu'il était écrit AVANT les familles (`2c0523f8`, src/workflow/engine.ts),
 * recopié mot pour mot. C'est la référence de la compatibilité : un graphe d'avant doit suivre la même arête.
 */
function ancienneSortie(graph: WorkflowGraph, here: string, work: EvalContext | undefined): string | null {
  const node = graph.nodes.find((x) => x.id === here)!;
  const passed = work ? evaluateConditionGroup(coerceConditionGroup(node.data), work) : false;
  const hasTypedEdge = graph.edges.some((ed) => ed.source === here && (ed.sourceHandle === 'true' || ed.sourceHandle === 'false'));
  return nextNodeByHandle(graph, here, passed ? 'true' : 'false') ?? (hasTypedEdge ? null : nextNode(graph, here));
}

describe('🔴 compatibilité : un graphe d’AVANT les familles passe par le moteur neuf sans rien changer', () => {
  const donnees: Array<Record<string, unknown>> = [
    { match: 'all', clauses: [{ kind: 'tag', op: 'has', tag: 'vip' }] },
    { match: 'any', clauses: [{ kind: 'tag', op: 'has', tag: 'vip' }, { kind: 'tag', op: 'has', tag: 'gold' }] },
    { match: 'all', clauses: [] }, // aucune clause : toujours « Si réunie »
    { clauses: 'pas-un-array' }, // malformé : coercé en groupe vide
    {},
  ];
  const cablages: Array<[string, WorkflowGraph['edges']]> = [
    ['les deux sorties', [e('e1', 'c', 'oui', 'true'), e('e2', 'c', 'non', 'false')]],
    ['« Si réunie » seule', [e('e1', 'c', 'oui', 'true')]],
    ['« Sinon » seule', [e('e2', 'c', 'non', 'false')]],
    ['aucune sortie typée (repli sur la 1re arête)', [e('e3', 'c', 'oui')]],
    ['rien', []],
  ];
  const contextes: Array<EvalContext | undefined> = [undefined, ctx(), ctx({ tags: ['vip'] }), ctx({ tags: ['gold'] })];

  it('même bloc suivant que l’ancien code, pour chaque bloc, chaque câblage, chaque contact', () => {
    let compares = 0;
    for (const data of donnees) {
      for (const [nom, edges] of cablages) {
        const g: WorkflowGraph = { nodes: [n('c', 'condition', data), n('oui', 'tag', { tag: 'oui' }), n('non', 'tag', { tag: 'non' })], edges };
        const avant = JSON.stringify(g);
        for (const w of contextes) {
          const attendu = ancienneSortie(g, 'c', w);
          const r = walk(g, 'c', w);
          const suivi = r.actions[0]?.nodeId ?? null;
          expect(suivi, `${JSON.stringify(data)} / ${nom} / ${JSON.stringify(w?.tags)}`).toBe(attendu);
          compares += 1;
        }
        // « Pas d'un octet » : le moteur ne réécrit rien du graphe qu'il lit.
        expect(JSON.stringify(g)).toBe(avant);
      }
    }
    expect(compares).toBe(donnees.length * cablages.length * contextes.length);
  });

  it('les analyses de graphe voient les deux mêmes branches qu’avant', () => {
    // condition --true--> message rapide (session) ; --false--> template : exactement le cas qui existait déjà.
    const g: WorkflowGraph = {
      nodes: [n('c', 'condition', { match: 'all', clauses: [] }), n('q', 'quick_message', { body: 'Salut' }), n('t', 'template', { templateName: 'p' })],
      edges: [e('e1', 'c', 'q', 'true'), e('e2', 'c', 't', 'false')],
    };
    expect(scanOpening(g)).toMatchObject({ sessionOpen: true, firstTemplate: { id: 't' } });
  });
});

describe('le moteur suit les familles', () => {
  // c -> VIP: a, Gold: b, Pro: p, Sinon: s
  const g: WorkflowGraph = {
    nodes: [n('c', 'condition', TROIS), n('a', 'tag', { tag: 'a' }), n('b', 'tag', { tag: 'b' }), n('p', 'tag', { tag: 'p' }), n('s', 'tag', { tag: 's' })],
    edges: [e('e1', 'c', 'a', 'true'), e('e2', 'c', 'b', 'famille:k2'), e('e3', 'c', 'p', 'famille:k3'), e('e4', 'c', 's', 'false')],
  };
  const suivi = (tags: string[]) => walk(g, 'c', ctx({ tags })).actions.map((x) => x.nodeId);

  it('🔴 trois familles dont deux vraies : la première, et elle seule', () => {
    expect(suivi(['gold', 'pro'])).toEqual(['b']);
    expect(suivi(['pro'])).toEqual(['p']);
  });
  it('aucune vraie : « Sinon »', () => {
    expect(suivi([])).toEqual(['s']);
  });
  it('sans contexte (analyse de graphe pure) : « Sinon », déterministe', () => {
    expect(walk(g, 'c').actions.map((x) => x.nodeId)).toEqual(['s']);
  });
  it('une famille vraie mais NON reliée arrête le parcours, jamais la branche d’une autre', () => {
    const sansGold: WorkflowGraph = { ...g, edges: g.edges.filter((x) => x.sourceHandle !== 'famille:k2') };
    const r = walk(sansGold, 'c', ctx({ tags: ['gold', 'pro'] }));
    expect(r.actions).toEqual([]);
    expect(r.rest).toEqual({ status: 'done' });
  });
});

describe('🔴 chaque analyse serveur voit une branche `famille:<code>`', () => {
  it('scanOpening : un message de session derrière la TROISIÈME famille rend le scénario non ouvrable à froid', () => {
    const g: WorkflowGraph = {
      nodes: [n('c', 'condition', TROIS), n('t1', 'template', { templateName: 'promo' }), n('t2', 'template', { templateName: 'promo' }), n('q', 'quick_message', { body: 'Salut' }), n('t3', 'template', { templateName: 'promo' })],
      edges: [e('e1', 'c', 't1', 'true'), e('e2', 'c', 't2', 'famille:k2'), e('e3', 'c', 'q', 'famille:k3'), e('e4', 'c', 't3', 'false')],
    };
    expect(scanOpening(g).sessionOpen).toBe(true);
    // Et deux modèles différents derrière deux familles rendent l'ouverture ambiguë.
    const ambigu: WorkflowGraph = { ...g, nodes: g.nodes.map((x) => (x.id === 'q' ? n('q', 'template', { templateName: 'autre' }) : x)) };
    expect(scanOpening(ambigu).ambiguousTemplate).toBe(true);
  });

  it('waitBeforeSessionMessage : attente de 2 jours puis un message rapide derrière une famille ajoutée', () => {
    const g: WorkflowGraph = {
      nodes: [n('w', 'wait', { delay: 2, unit: 'days' }), n('c', 'condition', TROIS), n('t', 'template', { templateName: 'p' }), n('q', 'quick_message', { body: 'Relance' })],
      edges: [e('e0', 'w', 'c'), e('e1', 'c', 't', 'true'), e('e3', 'c', 'q', 'famille:k3')],
    };
    expect(waitBeforeSessionMessage(g)).toEqual({ waitNodeId: 'w', messageNodeId: 'q' });
  });
});

describe('besoinsDesClauses : ce que le contexte doit charger', () => {
  it('rien pour des clauses ordinaires, et une clause malformée ne fait pas tomber la lecture', () => {
    expect(besoinsDesClauses([{ kind: 'tag', op: 'has', tag: 'x' }, null, 'texte'])).toEqual({ dernierMessageRecu: false, langueDetectee: false });
  });
  it('chaque champ système qui coûte une requête est demandé par sa clause, et par elle seule', () => {
    expect(besoinsDesClauses([{ kind: 'dernier_message_recu', op: 'empty' }])).toEqual({ dernierMessageRecu: true, langueDetectee: false });
    expect(besoinsDesClauses([{ kind: 'langue_detectee', op: 'is', value: 'en' }])).toEqual({ dernierMessageRecu: false, langueDetectee: true });
    // Le pays se lit sur le numéro déjà dans le contexte : aucune requête.
    expect(besoinsDesClauses([{ kind: 'pays', op: 'is_one_of', values: ['FR'] }])).toEqual({ dernierMessageRecu: false, langueDetectee: false });
  });
});
