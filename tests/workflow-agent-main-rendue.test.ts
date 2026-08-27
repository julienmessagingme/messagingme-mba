import { describe, it, expect } from 'vitest';
import { walk, scanOpening, waitBeforeSessionMessage } from '../src/workflow/engine';
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

/**
 * Tâche 8 : les analyses du produit doivent voir le bloc agent comme le moteur le voit. Le test de parité
 * front/serveur (`tests/web-campaign-eligibility.test.ts`) prouve seulement que les deux côtés sont IDENTIQUES,
 * pas qu'ils sont CORRECTS : si les deux traversaient l'agent, la parité passerait quand même. D'où ces
 * assertions explicites sur les valeurs attendues.
 */
describe('bloc agent : les gardes des analyses (tâche 8)', () => {
  it('scanOpening : un agent configuré ouvre en SESSION et bloque l exploration', () => {
    // Sans ce garde, le template en aval serait vu comme l'ouverture : la campagne l'accepterait, ferait
    // paramétrer ce template, et au lancement rien ne partirait alors que les destinataires seraient
    // comptés touchés. C'est le « 500 envoyés, 0 message réel ».
    const g: WorkflowGraph = {
      nodes: [n('a', 'agent', { agentId: 'ag_1' }), n('t', 'template', { templateName: 'promo', language: 'fr' })],
      edges: [e('e', 'a', 't')],
    };
    const out = scanOpening(g);
    expect(out.sessionOpen).toBe(true);
    expect(out.firstTemplate).toBeNull();
  });

  it('scanOpening : un agent NON configuré est traversé, le template en aval est vu (miroir de walk)', () => {
    const g: WorkflowGraph = {
      nodes: [n('a', 'agent'), n('t', 'template', { templateName: 'promo', language: 'fr' })],
      edges: [e('e', 'a', 't')],
    };
    const out = scanOpening(g);
    expect(out.sessionOpen).toBe(false);
    expect(out.firstTemplate?.id).toBe('t');
  });

  it('waitBeforeSessionMessage : attente longue puis agent configuré est SIGNALÉ', () => {
    // Le premier message de l'agent est un message de session : après 24 h d'attente cumulée, Meta le refuse.
    const g: WorkflowGraph = {
      nodes: [n('w', 'wait', { delay: 2, unit: 'days' }), n('a', 'agent', { agentId: 'ag_1' })],
      edges: [e('e', 'w', 'a')],
    };
    expect(waitBeforeSessionMessage(g)).toEqual({ waitNodeId: 'w', messageNodeId: 'a' });
  });

  it('waitBeforeSessionMessage : attente COURTE puis agent n est pas signalé', () => {
    const g: WorkflowGraph = {
      nodes: [n('w', 'wait', { delay: 2, unit: 'hours' }), n('a', 'agent', { agentId: 'ag_1' })],
      edges: [e('e', 'w', 'a')],
    };
    expect(waitBeforeSessionMessage(g)).toBeNull();
  });

  it('waitBeforeSessionMessage : agent NON configuré est traversé, c est le message d après qui est signalé', () => {
    const g: WorkflowGraph = {
      nodes: [n('w', 'wait', { delay: 2, unit: 'days' }), n('a', 'agent'), n('q', 'quick_message', { body: 'coucou' })],
      edges: [e('e1', 'w', 'a'), e('e2', 'a', 'q')],
    };
    expect(waitBeforeSessionMessage(g)).toEqual({ waitNodeId: 'w', messageNodeId: 'q' });
  });
});
