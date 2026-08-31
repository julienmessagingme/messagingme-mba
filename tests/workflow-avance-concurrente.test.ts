import { describe, it, expect, vi } from 'vitest';
import { WorkflowExecutor } from '../src/workflow/executor';
import type { WorkflowExecutorDeps } from '../src/workflow/executor';
import type { WorkflowGraph, WorkflowNodeType } from '../src/workflow/graph';
import type { WorkflowRunRow, RunState } from '../src/workflow/run-store.pg';

const n = (id: string, type: WorkflowNodeType, data: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, data });
const e = (id: string, source: string, target: string) => ({ id, source, target });

/** a -> b : le contact répond sur `a`, le parcours doit avancer sur `b`. */
const graphe: WorkflowGraph = {
  nodes: [n('a', 'quick_message', { body: 'A' }), n('b', 'quick_message', { body: 'B' })],
  edges: [e('e1', 'a', 'b')],
};

/**
 * Store de runs qui sait écrire CONDITIONNELLEMENT, comme celui de production. `aBouge` simule la course :
 * un autre traitement a fait avancer le run pendant qu'on travaillait.
 */
class RunsConditionnels {
  run: WorkflowRunRow | null = {
    id: 'r1', workflowId: 'wf1', tenantId: 't1', waId: '33600', currentNode: 'a', status: 'waiting', lastMessageId: null,
  };
  aBouge = false;
  /** Ce que la garde a reçu comme bloc de DÉPART, appel par appel. */
  readonly gardes: Array<string | null> = [];
  readonly inconditionnels: string[] = [];

  async start(): Promise<{ id: string }> { return { id: 'r1' }; }
  async findWaitingByWaId(): Promise<WorkflowRunRow | null> {
    return this.run && this.run.status === 'waiting' ? this.run : null;
  }
  async setState(id: string, state: RunState): Promise<void> {
    this.inconditionnels.push(id);
    if (this.run) this.run = { ...this.run, currentNode: state.currentNode, status: state.status };
  }
  async setStateSiEncoreSur(_t: string, _id: string, nodeId: string | null, state: RunState): Promise<boolean> {
    this.gardes.push(nodeId);
    if (this.aBouge) return false; // le run n'est plus là où on l'a lu : quelqu'un d'autre l'a avancé
    if (this.run) this.run = { ...this.run, currentNode: state.currentNode, status: state.status };
    return true;
  }
}

function exec(runs: RunsConditionnels, over: Partial<WorkflowExecutorDeps> = {}) {
  const calls: string[] = [];
  const ex = new WorkflowExecutor({
    runs: runs as unknown as WorkflowExecutorDeps['runs'],
    getGraph: async () => graphe,
    applyTag: async () => {},
    setField: async () => {},
    removeTag: async () => {},
    clearField: async () => {},
    sendTemplate: async () => {},
    sendQuickMessage: async (_t, _w, body) => { calls.push(`qm:${body}`); },
    sendFlow: async () => {},
    sendQuestion: async () => {},
    ...over,
  });
  return { ex, calls };
}

/**
 * ÉCRITURE CONDITIONNELLE DE L'AVANCE (lot 1 du programme, 2026-08-31).
 *
 * Deux avances peuvent se chevaucher DÈS AUJOURD'HUI, avec un seul worker : le process API traite certains
 * retours RCS pendant que le worker traite un webhook du même contact. Les deux lisaient le run sur le bloc N
 * et écrivaient tous les deux : le dernier gagnait, en écrasant `current_node`. Un parcours pouvait ainsi
 * REVENIR sur un bloc déjà franchi et rejouer sa branche au message suivant, sans aucune trace.
 *
 * ⚠️ Ces tests prouvent que l'ÉTAT est protégé. Ils ne prouvent PAS que le double ENVOI est fermé : les
 * messages du perdant sont déjà partis quand la garde le refuse. C'est un lot à part (claim avant l'envoi,
 * donc statut transitoire, donc migration), et le commentaire de `advance` le dit noir sur blanc.
 */
describe('avance concurrente : l’écriture d’état est conditionnée au bloc de départ', () => {
  it('cas nominal : la garde porte sur le bloc où le run a été LU, et l’écriture passe', async () => {
    const runs = new RunsConditionnels();
    const { ex, calls } = exec(runs);
    await ex.advance('t1', '33600', 'msg1');
    expect(calls).toEqual(['qm:B']); // le parcours a bien avancé
    expect(runs.gardes).toEqual(['a']); // ...gardé sur le bloc de DÉPART, pas sur la destination
    // La chaîne se termine sur `b` (aucune arête sortante) : le run est clos, ce qui prouve que l'écriture
    // conditionnelle est bien PASSÉE (sans elle, le run serait resté sur `a`).
    expect(runs.run).toMatchObject({ currentNode: null, status: 'done' });
  });

  it('🔴 le run a bougé pendant le traitement -> l’état N’EST PAS écrasé', async () => {
    const runs = new RunsConditionnels();
    runs.aBouge = true;
    const { ex } = exec(runs);
    const avertissements: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((m: unknown) => { avertissements.push(String(m)); });
    try {
      await ex.advance('t1', '33600', 'msg1');
    } finally {
      spy.mockRestore();
    }
    // La garde a refusé : le run reste tel que l'autre traitement l'a laissé (ici, inchangé par NOUS).
    expect(runs.run).toMatchObject({ currentNode: 'a' });
    // Et on le DIT : une course qu'on ne voit pas est une course qu'on ne corrigera jamais.
    expect(avertissements.some((a) => a.includes('avance PERDUE'))).toBe(true);
  });

  it('🔴 l’écriture INCONDITIONNELLE n’est plus utilisée quand la garde existe', async () => {
    // C'est ce qui rend la protection réelle : s'il restait un `setState` nu sur un chemin d'avance, ce
    // chemin-là continuerait d'écraser l'état d'un autre traitement.
    const runs = new RunsConditionnels();
    const { ex } = exec(runs);
    await ex.advance('t1', '33600', 'msg1');
    expect(runs.inconditionnels).toEqual([]);
  });

  it('un store SANS garde (fixtures, câblages de test) garde le comportement d’avant', async () => {
    const runs = new RunsConditionnels();
    // On retire la méthode : l'exécuteur doit retomber sur `setState`, sans rien casser.
    (runs as unknown as { setStateSiEncoreSur?: unknown }).setStateSiEncoreSur = undefined;
    const { ex, calls } = exec(runs);
    await ex.advance('t1', '33600', 'msg1');
    expect(calls).toEqual(['qm:B']);
    expect(runs.inconditionnels).toEqual(['r1']);
  });
});
