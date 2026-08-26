import { describe, it, expect } from 'vitest';
import { WorkflowExecutor } from '../src/workflow/executor';
import type { WorkflowExecutorDeps } from '../src/workflow/executor';
import type { WorkflowGraph, WorkflowNodeType } from '../src/workflow/graph';
import type { WorkflowRunRow, RunState } from '../src/workflow/run-store.pg';
import { runWorkflowWakeSweep } from '../src/workflow/wake-sweep';
import type { DueRun } from '../src/workflow/wake-sweep';

/**
 * Bloc QUESTION : l'EXÉCUTION. Le contrat pur est dans `workflow-question-node`, ici on vérifie ce que
 * l'executor en fait vraiment.
 *
 * Ce que ce fichier verrouille, et pourquoi chaque cas coûterait cher s'il lâchait :
 *  - l'échéance est POSÉE sur un run `waiting` (et pas `sleeping`) : c'est ce qui permet à la fois de
 *    recevoir la réponse et d'être réveillé par le balayeur ;
 *  - une ligne du menu route vers SA branche, et une ligne branchée sur rien ESCALADE au lieu de rendre la
 *    main en silence (le contact a fait un choix qu'on lui a proposé) ;
 *  - une réponse écrite prend la sortie libre, même quand le menu existe ;
 *  - à l'échéance, on sort par `timeout` et JAMAIS par le successeur.
 */
const n = (id: string, type: WorkflowNodeType, data: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, data });
const e = (id: string, source: string, target: string, sourceHandle?: string) =>
  ({ id, source, target, ...(sourceHandle ? { sourceHandle } : {}) });

/** Question à deux lignes, avec une branche par ligne, une sortie libre et une sortie « pas de réponse ». */
const GRAPHE: WorkflowGraph = {
  nodes: [
    n('q', 'question', { body: 'Ça vous convient ?', buttonLabel: 'Répondre', rows: [{ title: 'Oui' }, { title: 'Non' }], timeoutValue: 30, timeoutUnit: 'minutes' }),
    n('oui', 'tag', { tag: 'ok' }),
    n('non', 'tag', { tag: 'refus' }),
    n('libre', 'tag', { tag: 'ecrit' }),
    n('muet', 'tag', { tag: 'sans-reponse' }),
  ],
  edges: [
    e('e1', 'q', 'oui', 'row:0'),
    e('e2', 'q', 'non', 'row:1'),
    e('e3', 'q', 'libre'), // sortie LIBRE : aucune poignée, donc aucun sourceHandle
    e('e4', 'q', 'muet', 'timeout'),
  ],
};

interface Capture {
  envois: string[];
  tags: string[];
  etats: Array<{ id: string; state: RunState }>;
  escalades: string[];
}

function monter(graph: WorkflowGraph, run: WorkflowRunRow | null, cap: Capture, over: Partial<WorkflowExecutorDeps> = {}) {
  const deps: WorkflowExecutorDeps = {
    runs: {
      start: async (_t: string, _w: string, _wa: string, _c: string | null, state: RunState) => { cap.etats.push({ id: 'r1', state }); return { id: 'r1' }; },
      findWaitingByWaId: async () => run,
      setState: async (id: string, state: RunState) => { cap.etats.push({ id, state }); },
    },
    getGraph: async () => graph,
    applyTag: async (_t, _w, tag) => { cap.tags.push(tag); },
    setField: async () => {},
    removeTag: async () => {},
    clearField: async () => {},
    sendTemplate: async () => {},
    sendQuickMessage: async () => {},
    sendFlow: async () => {},
    sendQuestion: async (_t, _w, body, bouton, rows) => {
      cap.envois.push(`${body}|${bouton}|${rows.map((r) => r.title).join(',')}`);
    },
    isWindowOpen: async () => true,
    escalateToHuman: async (_t, waId) => { cap.escalades.push(waId); },
    now: () => 1_000_000,
    ...over,
  };
  return { ex: new WorkflowExecutor(deps), deps };
}

const capture = (): Capture => ({ envois: [], tags: [], etats: [], escalades: [] });
const runQ = (): WorkflowRunRow => ({
  id: 'r1', workflowId: 'wf1', tenantId: 't1', waId: '33600', contactId: 'c1',
  currentNode: 'q', status: 'waiting', lastMessageId: null, channel: 'whatsapp',
});

describe('bloc Question : l’envoi et l’échéance', () => {
  it('🔴 envoie la question et pose l’échéance sur un run WAITING, pas SLEEPING', async () => {
    // C'est LE point d'architecture du bloc : `findWaitingByWaId` ne voit que les runs `waiting`, donc un run
    // `sleeping` ne pourrait jamais recevoir la réponse du contact. L'échéance doit donc cohabiter avec
    // `waiting`, ce qu'aucun autre bloc ne fait.
    const cap = capture();
    const { ex } = monter(GRAPHE, null, cap);
    await ex.startInWindow('t1', 'wf1', GRAPHE, { waId: '33600', contactId: 'c1' });
    expect(cap.envois).toEqual(['Ça vous convient ?|Répondre|Oui,Non']);
    const etat = cap.etats.at(-1)?.state;
    expect(etat?.status).toBe('waiting');
    expect(etat?.currentNode).toBe('q');
    expect(etat?.resumeAt?.getTime()).toBe(1_000_000 + 30 * 60_000);
  });

  it('sans délai, aucune échéance n’est posée : la question attend sans limite', async () => {
    const g: WorkflowGraph = { ...GRAPHE, nodes: GRAPHE.nodes.map((x) => (x.id === 'q' ? n('q', 'question', { body: 'Q', rows: [{ title: 'Oui' }] }) : x)) };
    const cap = capture();
    const { ex } = monter(g, null, cap);
    await ex.startInWindow('t1', 'wf1', g, { waId: '33600', contactId: 'c1' });
    expect(cap.etats.at(-1)?.state.resumeAt).toBeUndefined();
  });

  it('🔴 hors fenêtre de 24 h, la question ne part PAS (c’est un message de session)', async () => {
    const cap = capture();
    const { ex } = monter(GRAPHE, null, cap, { isWindowOpen: async () => false });
    // `allowSessionOpen` absent : c'est le chemin d'une campagne, qui part à froid.
    const refus = await ex.start('t1', 'wf1', GRAPHE, { waId: '33600', contactId: 'c1' });
    expect(cap.envois).toEqual([]);
    expect(String(refus)).toContain('question');
  });
});

describe('bloc Question : le routage de la réponse', () => {
  it('🔴 une ligne du menu part sur SA branche', async () => {
    const cap = capture();
    const { ex } = monter(GRAPHE, runQ(), cap);
    await ex.advance('t1', '33600', 'm1', 'row:1');
    expect(cap.tags).toEqual(['refus']);
  });

  it('🔴 une réponse ÉCRITE prend la sortie libre, même quand le menu existe', async () => {
    // C'est la demande explicite : un menu n'empêche pas d'écrire, et ce cas doit pouvoir être prévu.
    const cap = capture();
    const { ex } = monter(GRAPHE, runQ(), cap);
    await ex.advance('t1', '33600', 'm1', null);
    expect(cap.tags).toEqual(['ecrit']);
  });

  it('🔴 une ligne branchée sur RIEN escalade vers un humain', async () => {
    // Le contact a fait un choix qu'on lui a proposé et n'a rien reçu : c'est un trou de MONTAGE, pas une
    // sortie de script. Sans le préfixe `row:` dans la règle, ce cas retomberait en silence sur « il a écrit ».
    // On retire la branche de `row:1` ET la sortie libre : sans elle, la réponse retomberait sur
    // « il a écrit » et le test passerait pour la mauvaise raison.
    const g: WorkflowGraph = { ...GRAPHE, edges: GRAPHE.edges.filter((x) => x.sourceHandle !== undefined && x.sourceHandle !== 'row:1') };
    const cap = capture();
    const { ex } = monter(g, runQ(), cap);
    await ex.advance('t1', '33600', 'm1', 'row:1');
    expect(cap.escalades).toEqual(['33600']);
    expect(cap.etats.at(-1)?.state.status).toBe('done');
  });

  it('répondre efface l’échéance : le balayeur ne réveillera pas un parcours déjà reparti', async () => {
    const cap = capture();
    const { ex } = monter(GRAPHE, runQ(), cap);
    await ex.advance('t1', '33600', 'm1', 'row:0');
    // Le parcours se termine sur le tag : l'état écrit ne porte plus d'échéance.
    expect(cap.etats.every((x) => x.state.resumeAt === undefined)).toBe(true);
  });
});

describe('bloc Question : le réveil « pas de réponse »', () => {
  it('🔴 à l’échéance, on sort par `timeout`, JAMAIS par le successeur', async () => {
    const cap = capture();
    const { ex } = monter(GRAPHE, null, cap);
    const repris = await ex.resume({ id: 'r1', workflowId: 'wf1', tenantId: 't1', waId: '33600', contactId: 'c1', currentNode: 'q', status: 'waiting' });
    expect(repris).toBe(true);
    expect(cap.tags).toEqual(['sans-reponse']);
  });

  it('🔴 sortie « pas de réponse » NON câblée -> le parcours se clôt et rend la main', async () => {
    // Sans la remise de main, le fil resterait tenu par un parcours mort et l'agent ne reprendrait jamais la
    // parole : la conversation deviendrait muette sans que personne ne le voie.
    const g: WorkflowGraph = { ...GRAPHE, edges: GRAPHE.edges.filter((x) => x.sourceHandle !== 'timeout') };
    const cap = capture();
    const rendus: string[] = [];
    const { ex } = monter(g, null, cap, {
      mbaActifPour: async () => true,
      releaseToMba: async (_t: string, waId: string) => { rendus.push(waId); },
    });
    const repris = await ex.resume({ id: 'r1', workflowId: 'wf1', tenantId: 't1', waId: '33600', contactId: 'c1', currentNode: 'q', status: 'waiting' });
    expect(repris).toBe(false);
    expect(cap.etats.at(-1)?.state.status).toBe('done');
    expect(rendus).toEqual(['33600']);
  });

  it('contrôle : un bloc ATTENTE garde son comportement, il reprend au SUCCESSEUR', async () => {
    // La règle ne doit pas déborder sur le bloc Attente, dont le réveil repart du bloc suivant.
    const g: WorkflowGraph = {
      nodes: [n('w', 'wait', { delay: 1, unit: 'hours' }), n('apres', 'tag', { tag: 'apres-attente' })],
      edges: [e('e1', 'w', 'apres')],
    };
    const cap = capture();
    const { ex } = monter(g, null, cap);
    await ex.resume({ id: 'r1', workflowId: 'wf1', tenantId: 't1', waId: '33600', contactId: 'c1', currentNode: 'w', status: 'sleeping' });
    expect(cap.tags).toEqual(['apres-attente']);
  });
});

/**
 * Le BALAYEUR sert desormais DEUX familles d'echeance : le sommeil d'un bloc Attente, et le delai « pas de
 * reponse » d'un bloc Question. Elles ne se reclament pas pareil, et la confusion se paierait cher : une
 * question jamais reveillee, ou un dormant reveille par la mauvaise sortie.
 */
describe('balayeur : les deux familles d echeance', () => {
  const dormant = (id: string): DueRun => ({ id, workflowId: 'wf', tenantId: 't1', waId: '33600', currentNode: 'w' });
  const question = (id: string): DueRun => ({ id, workflowId: 'wf', tenantId: 't1', waId: '33601', currentNode: 'q', status: 'waiting' });

  it('reprend les dormants ET les questions sans reponse, en portant leur statut', async () => {
    const vus: Array<{ id: string; status?: string }> = [];
    const n = await runWorkflowWakeSweep({
      claimDue: async () => [dormant('a')],
      claimDueQuestions: async () => [question('b')],
      resume: async (r) => { vus.push({ id: r.id, ...(r.status ? { status: r.status } : {}) }); return true; },
    });
    expect(n).toBe(2);
    expect(vus).toEqual([{ id: 'a' }, { id: 'b', status: 'waiting' }]);
  });

  it('sans la reclamation des questions, le comportement d avant est inchange', async () => {
    const vus: string[] = [];
    const n = await runWorkflowWakeSweep({
      claimDue: async () => [dormant('a')],
      resume: async (r) => { vus.push(r.id); return true; },
    });
    expect(n).toBe(1);
    expect(vus).toEqual(['a']);
  });

  it('UNE reclamation des questions en echec n empeche pas les dormants de repartir', async () => {
    // Le sommeil est le chemin historique : une nouveaute qui casse ne doit pas l emporter avec elle.
    const vus: string[] = [];
    const n = await runWorkflowWakeSweep({
      claimDue: async () => [dormant('a')],
      claimDueQuestions: async () => { throw new Error('base indisponible'); },
      resume: async (r) => { vus.push(r.id); return true; },
    });
    expect(n).toBe(1);
    expect(vus).toEqual(['a']);
  });
});
