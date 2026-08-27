import { describe, it, expect } from 'vitest';
import { walk } from '../src/workflow/engine';
import { restToState } from '../src/workflow/executor';
import type { WorkflowGraph, WorkflowNodeType } from '../src/workflow/graph';

const n = (id: string, type: WorkflowNodeType, data: Record<string, unknown> = {}): WorkflowGraph['nodes'][number] => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data,
});
const e = (id: string, source: string, target: string) => ({ id, source, target });

/**
 * Tâche 7 : le bloc agent rend la main, il n'est pas traversé. Deux pannes silencieuses sont fermées ici, et
 * ces tests existent pour qu'elles ne se rouvrent pas :
 *  1. sans branche dédiée dans `walk`, un type sans cas tombe dans la fin de boucle générique et le parcours
 *     AVANCE au bloc suivant (le passe-plat des types legacy, délibéré et testé ailleurs) ;
 *  2. sans cas explicite dans `restToState`, le statut tombe dans le `return` final et le parcours est clos en
 *     `done` pile au moment où l'agent doit prendre la main.
 */
describe('bloc agent : la main rendue (tâche 7)', () => {
  it('rend la main au lieu d etre traversé, et le bloc suivant n est PAS exécuté', () => {
    const g: WorkflowGraph = {
      nodes: [n('a', 'agent', { agentId: 'ag_1' }), n('b', 'quick_message', { body: 'apres' })],
      edges: [e('e', 'a', 'b')],
    };
    const r = walk(g, 'a');
    expect(r.rest).toEqual({ status: 'agent_turn', nodeId: 'a' });
    expect(r.actions).toHaveLength(0);
  });

  it('les actions qui PRÉCÈDENT le bloc agent partent quand même', () => {
    const g: WorkflowGraph = {
      nodes: [n('t', 'tag', { tag: 'vu' }), n('a', 'agent', { agentId: 'ag_1' })],
      edges: [e('e', 't', 'a')],
    };
    const r = walk(g, 't');
    expect(r.rest).toEqual({ status: 'agent_turn', nodeId: 'a' });
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]?.action).toEqual({ kind: 'tag', tag: 'vu' });
  });

  it('NON configuré (pas d agentId) = passe-plat : le parcours continue, il ne gèle pas', () => {
    // Même choix que le bloc Question sans texte. Rendre la main à un agent qui n'existe pas figerait le
    // parcours pour toujours, sans le moindre signal.
    // Bloc suivant = template (il attend SUR lui-même), ce qui montre nettement que le parcours a avancé
    // jusqu'à 'b' au lieu de s'arrêter sur le bloc agent.
    const g: WorkflowGraph = {
      nodes: [n('a', 'agent'), n('b', 'template', { templateName: 'promo', language: 'fr' })],
      edges: [e('e', 'a', 'b')],
    };
    const r = walk(g, 'a');
    expect(r.rest).toEqual({ status: 'waiting', nodeId: 'b' });
    expect(r.actions.map((x) => x.action)).toEqual([
      { kind: 'sendTemplate', templateName: 'promo', language: 'fr', buttons: [] },
    ]);
  });

  it('restToState garde le run en attente SUR le bloc agent, jamais en done', () => {
    // C'est ce qui permet à `findWaitingByWaId` de retrouver le parcours au message suivant du contact.
    expect(restToState({ status: 'agent_turn', nodeId: 'a' }, Date.now())).toEqual({ currentNode: 'a', status: 'waiting' });
  });
});
