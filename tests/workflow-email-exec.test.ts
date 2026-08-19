import { describe, it, expect, vi } from 'vitest';
import { WorkflowExecutor } from '../src/workflow/executor';
import type { WorkflowExecutorDeps } from '../src/workflow/executor';
import type { WorkflowGraph, WorkflowNodeType } from '../src/workflow/graph';
import type { WorkflowRunRow, RunState } from '../src/workflow/run-store.pg';

/**
 * Task 8 : le node « Envoi de mail » est câblé dans `apply` (executor.ts) en BEST-EFFORT STRICT, contrairement
 * aux canaux WhatsApp/RCS qui peuvent refuser tout le run. Un envoi qui lève ne doit ni interrompre le parcours,
 * ni compter comme un refus.
 *
 * Preuve dans les DEUX sens (règle Julien, 2026-08-18) : vérifiée manuellement en retirant temporairement le
 * try/catch autour de `this.deps.sendEmail` dans `apply` (executor.ts) -> le test « n'arrête pas le parcours »
 * tombe alors en échec (le rejet remonte, `applyTag` du node suivant n'est jamais atteint). Try/catch remis ->
 * PASS. Non automatisée dans ce fichier (modifier executor.ts en dur romprait la garantie en prod pour de vrai
 * pendant l'exécution des tests) ; la preuve est rapportée à part.
 */

const n = (id: string, type: WorkflowNodeType, data: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, data });
const e = (id: string, source: string, target: string) => ({ id, source, target });

/** Graphe minimal du plan (Task 8, étape 1) : un bloc « Envoi de mail » suivi d'un bloc tag. Aucun des deux
 *  n'est bloquant (cf. engine.ts `walk`, branche tag/field/email) -> le parcours se termine en une seule passe
 *  de `start`, sans passer par `advance`. */
const graph: WorkflowGraph = {
  nodes: [
    n('em', 'email', { emailAccountId: 'a1', templateId: 't1', to: { kind: 'literal', value: 'dest@exemple.fr' } }),
    n('tg', 'tag', { tag: 'mail-tente' }),
  ],
  edges: [e('e1', 'em', 'tg')],
};

/** Runs factices minimales : ce graphe 100 % synchrone n'atteint jamais `runs.start` (aucun bloc bloquant, même
 *  contrat que le test « workflow 100% synchrone » de workflow-executor.test.ts), mais l'interface les exige. */
class FakeRuns {
  async start(_tenantId: string, _workflowId: string, _waId: string, _contactId: string | null, _state: RunState): Promise<{ id: string }> {
    return { id: 'r1' };
  }
  async findWaitingByWaId(): Promise<WorkflowRunRow | null> {
    return null;
  }
  async setState(): Promise<void> {}
}

/** Deps minimales communes aux trois tests, `sendEmail` et `applyTag` injectées par chaque cas. */
function makeDeps(sendEmail: WorkflowExecutorDeps['sendEmail'], applyTag: WorkflowExecutorDeps['applyTag']): WorkflowExecutorDeps {
  return {
    runs: new FakeRuns(),
    getGraph: async () => graph,
    applyTag,
    setField: async () => {},
    removeTag: async () => {},
    clearField: async () => {},
    sendTemplate: async () => {},
    sendQuickMessage: async () => {},
    sendFlow: async () => {},
    sendEmail,
  };
}

describe('executor : le node email est best-effort', () => {
  it('un envoi qui échoue n’arrête pas le parcours (le node suivant est appliqué)', async () => {
    const sendEmail = vi.fn().mockRejectedValue(new Error('SMTP down'));
    const applyTag = vi.fn().mockResolvedValue(undefined);
    const ex = new WorkflowExecutor(makeDeps(sendEmail, applyTag));

    const outcome = await ex.start('t1', 'wf1', graph, { waId: '33600000001', contactId: 'c1' });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith(
      't1',
      '33600000001',
      { kind: 'sendEmail', emailAccountId: 'a1', templateId: 't1', to: { kind: 'literal', value: 'dest@exemple.fr' } },
    );
    // Le node SUIVANT (tag) est quand même appliqué : la panne d'envoi n'a pas arrêté le parcours.
    expect(applyTag).toHaveBeenCalledTimes(1);
    expect(applyTag).toHaveBeenCalledWith('t1', '33600000001', 'mail-tente');
    // Un échec d'email n'est PAS un refus au sens de `start()` : rien ne doit remonter comme raison de non-départ.
    expect(outcome).toBe(true);
  });

  it('un envoi réussi appelle sendEmail ET le node suivant (comportement nominal)', async () => {
    const sendEmail = vi.fn().mockResolvedValue(undefined);
    const applyTag = vi.fn().mockResolvedValue(undefined);
    const ex = new WorkflowExecutor(makeDeps(sendEmail, applyTag));

    await ex.start('t1', 'wf1', graph, { waId: '33600000001', contactId: 'c1' });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(applyTag).toHaveBeenCalledTimes(1);
  });

  it('sendEmail absente des deps (câblage partiel, ex. suite d’intégration existante) : no-op silencieux, le node suivant est quand même appliqué', async () => {
    const applyTag = vi.fn().mockResolvedValue(undefined);
    const ex = new WorkflowExecutor(makeDeps(undefined, applyTag));

    const outcome = await ex.start('t1', 'wf1', graph, { waId: '33600000001', contactId: 'c1' });

    expect(applyTag).toHaveBeenCalledTimes(1);
    expect(outcome).toBe(true);
  });
});
