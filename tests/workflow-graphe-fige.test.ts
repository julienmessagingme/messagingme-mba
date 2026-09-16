import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { jamaisDesabonne } from './consentement';
import { WorkflowExecutor, grapheDuRun } from '../src/workflow/executor';
import type { WorkflowExecutorDeps } from '../src/workflow/executor';
import type { WorkflowGraph, WorkflowNodeType } from '../src/workflow/graph';
import type { RunState, WorkflowRunRow } from '../src/workflow/run-store.pg';

/**
 * LE GRAPHE FIGÉ D'UN PARCOURS DE TEST (migration 0151).
 *
 * 🔴 CE QUE CES TESTS GARDENT EST UN DÉFAUT VÉCU, pas une fonctionnalité neuve. Un test DÉMARRAIT sur le
 * brouillon et REPRENAIT sur le publié : les trois points de reprise de l'exécuteur demandaient le graphe à
 * `getGraph`, que le câblage résout en `row.graph`. Un test qui atteignait un bloc d'attente et recevait une
 * réponse changeait donc de version EN SILENCE.
 *
 * ⚠️ ET LA MOITIÉ QUI COMPTE EST LE CÂBLAGE, PAS LA FONCTION PURE. Un test qui n'exercerait que
 * `grapheDuRun` resterait vert si on débranchait la préférence des trois points de reprise : c'est la leçon
 * du 2026-09-16 (« une garde qu'on peut débrancher sans qu'aucun test ne tombe n'est pas une garde »). Les
 * cas ci-dessous font donc tourner le VRAI exécuteur, et comptent les lectures du publié.
 */

const n = (id: string, type: WorkflowNodeType, data: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, data });
const e = (id: string, source: string, target: string) => ({ id, source, target });

/** tag -> attente -> template. Le parcours dort sur 'w', la reprise repart sur le template. */
const avecAttente = (texte: string): WorkflowGraph => ({
  nodes: [n('t', 'tag', { tag: 'vip' }), n('w', 'wait', { delay: 2, unit: 'hours' }), n('tpl', 'template', { templateName: texte, language: 'fr' })],
  edges: [e('e1', 't', 'w'), e('e2', 'w', 'tpl')],
});

/** template -> message rapide. Le parcours attend sur 'tpl', la réponse du contact envoie le message rapide. */
const avecReponse = (texte: string): WorkflowGraph => ({
  nodes: [n('tpl', 'template', { templateName: 'promo', language: 'fr' }), n('qm', 'quick_message', { body: texte })],
  edges: [e('e1', 'tpl', 'qm')],
});

class FauxRuns {
  run: WorkflowRunRow | null = null;
  /** Ce que la CRÉATION a transmis au dépôt : c'est là que le figeage se prouve, pas dans ce que rend `runFrom`. */
  grapheFigeEcrit: WorkflowGraph | null | undefined = undefined;
  async closeActiveByWaId(): Promise<string[]> { return []; }
  async start(tenantId: string, workflowId: string, waId: string, _c: string | null, state: RunState, grapheFige: WorkflowGraph | null): Promise<{ id: string }> {
    this.grapheFigeEcrit = grapheFige;
    this.run = { id: 'r1', workflowId, tenantId, waId, currentNode: state.currentNode, status: state.status, lastMessageId: null, grapheFige };
    return { id: 'r1' };
  }
  async findWaitingByWaId(_t: string, waId: string): Promise<WorkflowRunRow | null> {
    return this.run && this.run.status === 'waiting' && this.run.waId === waId ? this.run : null;
  }
  async setState(id: string, state: RunState): Promise<void> {
    if (this.run && this.run.id === id) this.run = { ...this.run, currentNode: state.currentNode, status: state.status };
  }
}

/** Monte l'exécuteur en COMPTANT les lectures du publié : c'est ce compte qui prouve que le figé a servi. */
function monter(publie: WorkflowGraph, over: Partial<WorkflowExecutorDeps> = {}) {
  const runs = new FauxRuns();
  const calls: string[] = [];
  const luPublie: string[] = [];
  const ex = new WorkflowExecutor({
    estDesabonne: jamaisDesabonne,
    runs,
    getGraph: async (id) => { luPublie.push(id); return publie; },
    applyTag: async (_t, _w, tag) => { calls.push(`tag:${tag}`); return true; },
    setField: async () => {},
    removeTag: async () => {},
    clearField: async () => {},
    sendTemplate: async (_t, _w, name) => { calls.push(`tpl:${name}`); },
    sendQuickMessage: async (_t, _w, body) => { calls.push(`qm:${body}`); },
    sendFlow: async () => {},
    sendQuestion: async () => {},
    ...over,
  });
  return { ex, runs, calls, luPublie };
}

describe('grapheDuRun : le point de passage unique', () => {
  it('🔴 un parcours qui porte un graphe figé joue le SIEN, et le publié n’est même pas lu', async () => {
    const lu: string[] = [];
    const fige = avecAttente('brouillon');
    const graphe = await grapheDuRun({ grapheFige: fige }, async () => { lu.push('publie'); return avecAttente('publie'); });
    expect(graphe).toEqual(fige);
    expect(lu, 'le publié ne doit même pas être lu quand un graphe est figé').toEqual([]);
  });

  it('⚠️ sans graphe figé, on lit le publié : c’est le comportement de TOUS les parcours réels', async () => {
    const publie = avecAttente('publie');
    expect(await grapheDuRun({ grapheFige: null }, async () => publie)).toEqual(publie);
  });
});

describe('le figeage à la création du parcours', () => {
  it('🔴 `figerLeGraphe` transmet le graphe JOUÉ au dépôt', async () => {
    const brouillon = avecReponse('version brouillon');
    const { ex, runs } = monter(avecReponse('version publiee'));
    await ex.startFromNode('t1', 'wf1', brouillon, { waId: '33600', contactId: 'c1' }, 'tpl', { figerLeGraphe: true });
    expect(runs.grapheFigeEcrit).toEqual(brouillon);
  });

  it('⚠️ SANS l’option, rien n’est figé : une campagne de 5 000 destinataires ne recopie pas 5 000 graphes', async () => {
    const publie = avecReponse('version publiee');
    const { ex, runs } = monter(publie);
    await ex.start('t1', 'wf1', publie, { waId: '33600', contactId: 'c1' });
    expect(runs.grapheFigeEcrit).toBeNull();
  });
});

describe('les points de reprise jouent le graphe figé', () => {
  it('🔴 `advance` : le contact répond, et c’est le BROUILLON qui continue', async () => {
    // Le défaut d'avant : le démarrage jouait le brouillon, la réponse du contact rebasculait sur le publié.
    const brouillon = avecReponse('version brouillon');
    const { ex, calls, luPublie } = monter(avecReponse('version publiee'));
    await ex.startFromNode('t1', 'wf1', brouillon, { waId: '33600', contactId: 'c1' }, 'tpl', { figerLeGraphe: true });
    await ex.advance('t1', '33600', 'm1');
    expect(calls).toEqual(['tpl:promo', 'qm:version brouillon']);
    expect(luPublie, 'aucune lecture du publié sur tout le parcours').toEqual([]);
  });

  it('🔴 `resume` : le réveil après une attente joue le BROUILLON', async () => {
    const { ex, calls, luPublie } = monter(avecAttente('publie'));
    const dormant = {
      id: 'r1', workflowId: 'wf1', tenantId: 't1', waId: '33600', currentNode: 'w',
      status: 'sleeping' as const, grapheFige: avecAttente('brouillon'),
    };
    expect(await ex.resume(dormant)).toBe(true);
    expect(calls).toEqual(['tpl:brouillon']);
    expect(luPublie).toEqual([]);
  });

  it('🔴 `runEnAttenteSur` : la GARDE des reprises RCS et agent lit elle aussi le figé', async () => {
    // Ce troisième point n'avance pas le parcours, il DÉCIDE si le signal le concerne : il compare le type du
    // bloc courant. Le lire dans le publié suffisait à faire répondre « ce contact n'attend rien » à un accusé
    // RCS parfaitement légitime, dès que le bloc avait changé de type depuis la publication.
    const publie: WorkflowGraph = { nodes: [n('r', 'template', { templateName: 'promo', language: 'fr' })], edges: [] };
    const brouillon: WorkflowGraph = { nodes: [n('r', 'rcs_message', { body: 'coucou' })], edges: [] };
    const { ex, runs, luPublie } = monter(publie);
    runs.run = {
      id: 'r1', workflowId: 'wf1', tenantId: 't1', waId: '33600', currentNode: 'r',
      status: 'waiting', lastMessageId: null, channel: 'rcs', grapheFige: brouillon,
    };
    expect(await ex.rcsUndeliverable('t1', '33600', 'm1')).toBe(true);
    expect(luPublie).toEqual([]);
  });

  it('⚠️ sans graphe figé, `resume` lit le publié, exactement comme avant', async () => {
    const { ex, calls, luPublie } = monter(avecAttente('publie'));
    const dormant = {
      id: 'r1', workflowId: 'wf1', tenantId: 't1', waId: '33600', currentNode: 'w',
      status: 'sleeping' as const, grapheFige: null,
    };
    expect(await ex.resume(dormant)).toBe(true);
    expect(calls).toEqual(['tpl:publie']);
    expect(luPublie).toEqual(['wf1']);
  });
});

/**
 * LE CÂBLAGE, parce que c'est là que la règle se décide vraiment.
 *
 * Un câblage n'a par construction aucun dépendant : la seule question à lui poser est l'inverse, « qu'est-ce
 * qu'il suppose du module qu'on vient de changer ? ». Ici il suppose que le figeage est une EXCEPTION, posée
 * sur le seul chemin qui joue un brouillon. Rien dans le langage ne relie un commentaire à un appel, d'où ce
 * test qui lit la source, sur le modèle de `tests/campagne-controle-humain.test.ts`.
 */
describe('le figeage est cable sur le lien de test, et NULLE PART ailleurs', () => {
  const worker = readFileSync(join(process.cwd(), 'src', 'worker.ts'), 'utf8');

  /**
   * ⚠️ L'ANCRE EST LE BLOC DE CÂBLAGE, PAS UNE LIGNE D'APPEL. Elle a d'abord désigné
   * `startInWindow(tenant, workflowId, grapheEditable(wf)`, que le lot du 2026-09-16 a réécrit en deux
   * branches : le test tombait alors sur un changement parfaitement légitime. Un test qui lit la source
   * doit s'accrocher à ce qu'il mesure (« ce câblage-ci »), pas à la forme d'une ligne.
   */
  const cablageDuLienDeTest = (): string => {
    const debut = worker.indexOf('startTestRun: async (');
    expect(debut, 'le câblage du lien de test a disparu de worker.ts').toBeGreaterThan(-1);
    const fin = worker.indexOf('\n        },', debut);
    expect(fin, 'fin du bloc startTestRun introuvable').toBeGreaterThan(debut);
    return worker.slice(debut, fin);
  };

  it('🔴 le lien de test fige', () => {
    expect(cablageDuLienDeTest()).toContain('figerLeGraphe: true');
  });

  it('🔴 et il démarre AU BLOC quand le jeton en désigne un', () => {
    // Le câblage est la seule pièce qui traduit `nodeId` en chemin d'exécution, et aucun test unitaire ne
    // peut monter `main()`. Sans cette garde, revenir à un `startInWindow` inconditionnel ferait démarrer
    // TOUS les tests à l'entrée du scénario, en silence : le bouton d'un bloc enverrait le premier message.
    const bloc = cablageDuLienDeTest();
    expect(bloc).toContain('nodeId === null');
    expect(bloc).toContain('startFromNode');
    expect(bloc).toContain('startInWindow');
  });

  it('🔴 et c’est le SEUL : une campagne ne recopie pas son graphe par destinataire', () => {
    // Le compte vaut la règle : deux occurrences voudraient dire qu'un second chemin fige, et le seul autre
    // candidat de ce fichier est la campagne (`start`, `startFromNode`), qui envoie à des contacts RÉELS.
    expect(worker.split('figerLeGraphe').length - 1).toBe(1);
  });
});
