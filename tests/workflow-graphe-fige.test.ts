import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { jamaisDesabonne } from './consentement';
import { avecGardesDEtatInertes, depsInertes } from './executeur-inerte';
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
    ...depsInertes,
    estDesabonne: jamaisDesabonne,
    runs: avecGardesDEtatInertes(runs),
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
  it('🔴 le lien de test (`brouillon_fige`) transmet le graphe JOUÉ au dépôt', async () => {
    const brouillon = avecReponse('version brouillon');
    const { ex, runs } = monter(avecReponse('version publiee'));
    await ex.demarrer('lien_de_test', 't1', 'wf1', brouillon, { waId: '33600', contactId: 'c1' }, { depuis: 'bloc', noeudId: 'tpl' });
    expect(runs.grapheFigeEcrit).toEqual(brouillon);
  });

  it('⚠️ une campagne ne fige rien : 5 000 destinataires ne recopient pas 5 000 graphes', async () => {
    const publie = avecReponse('version publiee');
    const { ex, runs } = monter(publie);
    await ex.demarrer('campagne_scenario', 't1', 'wf1', publie, { waId: '33600', contactId: 'c1' });
    expect(runs.grapheFigeEcrit).toBeNull();
  });
});

describe('les points de reprise jouent le graphe figé', () => {
  it('🔴 `advance` : le contact répond, et c’est le BROUILLON qui continue', async () => {
    // Le défaut d'avant : le démarrage jouait le brouillon, la réponse du contact rebasculait sur le publié.
    const brouillon = avecReponse('version brouillon');
    const { ex, calls, luPublie } = monter(avecReponse('version publiee'));
    await ex.demarrer('lien_de_test', 't1', 'wf1', brouillon, { waId: '33600', contactId: 'c1' }, { depuis: 'bloc', noeudId: 'tpl' });
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
 * SEUL LE LIEN DE TEST JOUE LE BROUILLON, ET LUI SEUL LE FIGE.
 *
 * ⚠️ LE CÂBLAGE NE SE LIT PLUS ICI (lot « lancements de scénario », 2026-10-04). Les cas qui lisaient le bloc
 * `startTestRun` de `src/worker.ts` (il fige, il joue `grapheEditable(wf)`, il résout le bloc par `blocDesigne` et
 * démarre au bloc quand le jeton en désigne un, et `figerLeGraphe` n'apparaît qu'une fois dans le worker) sont
 * devenus la colonne « graphe » de `POLITIQUE_DE_LANCEMENT`, exécutée type par type, et le cas du bloc désigné du
 * lien de test, dans `tests/workflow-lancements.test.ts`. Reste ici l'inventaire de `src/`, que la table ne voit
 * pas : un chemin d'exécution qui appellerait `grapheEditable` sans passer par les lancements.
 */
describe('SEUL le lien de test joue le brouillon : l’inventaire de `grapheEditable` dans `src/`', () => {
  /**
   * 🔴 L'INVARIANT LE PLUS CHER DU LOT, ET IL N'ÉTAIT GARDÉ NULLE PART (relevé en revue globale, 2026-09-16).
   *
   * « Un contact RÉEL ne tombe jamais dans un brouillon. » Le lien de test est le SEUL chemin d'exécution qui
   * joue `grapheEditable(wf)` ; tous les autres jouent le PUBLIÉ. Rien dans le langage ne le dit : il suffirait
   * qu'un jour quelqu'un trouve pratique d'ouvrir le lancement depuis l'Inbox sur le brouillon pour qu'une
   * version de travail parte à un vrai client, sans erreur et sans trace.
   */
  it('🔴 SEUL le lien de test joue le BROUILLON, dans TOUT `src/`', () => {
    // ⚠️ L'INVENTAIRE EST DÉRIVÉ, PAS ÉCRIT (correction de la revue finale, 2026-09-16). Il ne regardait que
    // `src/worker.ts` et `src/index.ts` : un futur chemin d'exécution posé dans `src/workflow/wiring.ts` ou
    // dans un module de routes serait passé sans être vu, alors que `documentation.md` énonce l'invariant
    // sans cette réserve. On balaie donc TOUT `src/` et on compare à un inventaire nommé.
    const attendus = new Map([
      ['src/workflow/store.pg.ts', 'la DÉFINITION de `grapheEditable`'],
      ['src/http/workflows.ts', 'la DUPLICATION d’un scénario : on recopie le travail en cours, on n’exécute rien'],
      ['src/workflow/lancements.ts', 'l’entrée des lancements, pour le seul type dont la politique joue le brouillon (`lien_de_test`)'],
    ]);
    // ⚠️ `--untracked` N'EST PAS DÉCORATIF (mesuré par la seconde passe de revue) : sans lui, `git grep` ne
    // voit que les fichiers SUIVIS, et un nouvel appelant pas encore `git add` passait en VERT chez son
    // auteur, c'est-à-dire précisément au moment où il l'écrit. En CI, tout est suivi, donc le trou ne
    // s'ouvrait que là où il coûte le plus cher.
    //
    // ⚠️ Et l'inventaire suit le SYMBOLE, pas la QUESTION : quelqu'un qui écrirait `wf.draftGraph ?? wf.graph`
    // en ligne ne serait pas vu. C'est une limite assumée, pas une garantie.
    const trouves = execSync('git grep -l --untracked "grapheEditable" -- src/', { cwd: process.cwd(), encoding: 'utf8' })
      .split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    expect(trouves.length, 'git grep n’a rien trouvé du tout : la sonde est cassée, pas l’invariant').toBeGreaterThan(0);
    expect(new Set(trouves),
      `un nouvel appelant de grapheEditable dans src/ : est-ce un chemin d’EXÉCUTION ? S’il l’est, il ferait jouer un BROUILLON à un vrai contact. Inventaire attendu : ${[...attendus].map(([f, r]) => `${f} (${r})`).join(' | ')}`)
      .toEqual(new Set(attendus.keys()));
  });
});
