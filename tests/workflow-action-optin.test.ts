import { describe, it, expect } from 'vitest';
import { walk } from '../src/workflow/engine';
import { WorkflowExecutor } from '../src/workflow/executor';
import type { WorkflowExecutorDeps } from '../src/workflow/executor';
import type { WorkflowRunRow } from '../src/workflow/run-store.pg';
import type { WorkflowGraph } from '../src/workflow/graph';
import { jamaisDesabonne } from './consentement';
import { avecGardesDEtatInertes, consentementNonEcrit, depsInertes } from './executeur-inerte';

/**
 * Le bloc « Action » qui pose le CONSENTEMENT d'un contact.
 *
 * C'est le seul chemin capable de poser un opt-out AUTOMATIQUEMENT : l'upsert d'import et d'API ne fait jamais
 * régresser un statut, et la bascule à la main suppose un opérateur. Derrière un mot-clé de désinscription
 * branché en automation, c'est ce bloc qui rend le refus exécutoire pour les campagnes.
 */
const n = (id: string, type: string, data: Record<string, unknown> = {}) =>
  ({ id, type, position: { x: 0, y: 0 }, data }) as WorkflowGraph['nodes'][number];

describe('lecture du graphe : bloc Action, sous-actions de consentement', () => {
  /** Actions produites par un bloc Action seul, via le parcours PUBLIC (`actionOf` est prive, a raison). */
  const actionsDu = (data: Record<string, unknown>): unknown[] =>
    walk({ nodes: [n('a', 'action', data)], edges: [] }, 'a').actions.map((e) => e.action);

  it('set_optin / set_optout -> une action optIn dans le bon sens', () => {
    expect(actionsDu({ actionKind: 'set_optin' })).toEqual([{ kind: 'optIn', value: 'opted_in' }]);
    expect(actionsDu({ actionKind: 'set_optout' })).toEqual([{ kind: 'optIn', value: 'opted_out' }]);
  });

  it('🔴 rien a saisir, donc jamais « incomplet » : aucune donnee annexe requise', () => {
    // Un tag ou un champ vide rend le bloc no-op. Le consentement, lui, porte son sens dans le choix de
    // l'action : exiger une valeur en plus n'aurait rien a valider et creerait un bloc muet inexplicable.
    expect(actionsDu({ actionKind: 'set_optout', tag: '', fieldKey: '' })).toEqual([{ kind: 'optIn', value: 'opted_out' }]);
  });

  it('une sous-action inconnue ne produit AUCUNE action', () => {
    expect(actionsDu({ actionKind: 'set_optin_maybe' })).toEqual([]);
  });
});

describe('executeur : l’action optIn appelle la dépendance', () => {
  function executeur(graph: WorkflowGraph, avecDep = true) {
    const poses: Array<{ waId: string; value: string }> = [];
    const run = { id: 'r1', workflowId: 'wf1', tenantId: 't1', waId: '33600000001', currentNode: 'n1', lastMessageId: null } as unknown as WorkflowRunRow;
    // 🔴 PLUS DE `Record<string, unknown>` NI DE `as never` : ce faux mentait au compilateur, et il lui manquait
    // `estDesabonne` et `sendQuestion` sans que personne le voie.
    const deps: WorkflowExecutorDeps = {
      ...depsInertes,
      estDesabonne: jamaisDesabonne,
      runs: avecGardesDEtatInertes({
        findWaitingByWaId: async () => run,
        setState: async () => {},
        // Requis par le contrat : un demarrage remplace le parcours en cours. Ce faux n exerce que l avance.
        closeActiveByWaId: async () => [],
        start: async () => ({ id: 'r1' }),
      }),
      getGraph: async () => graph,
      applyTag: async () => {},
      setField: async () => {},
      removeTag: async () => {},
      clearField: async () => {},
      sendTemplate: async () => {},
      sendQuickMessage: async () => {},
      sendFlow: async () => {},
      sendQuestion: async () => {},
      setOptIn: avecDep
        ? async (_t: string, waId: string, value: string): Promise<void> => { poses.push({ waId, value }); }
        : consentementNonEcrit,
    };
    return { ex: new WorkflowExecutor(deps), poses };
  }

  const graphe = (kind: string): WorkflowGraph => ({
    nodes: [
      n('n1', 'quick_message', { body: 'Tu veux te desinscrire ?', quickReplies: [{ text: 'Oui' }] }),
      n('n2', 'action', { actionKind: kind }),
    ],
    edges: [{ id: 'e0', source: 'n1', target: 'n2', sourceHandle: 'Oui' }],
  });

  it('🔴 le parcours atteint le bloc -> le consentement est posé', async () => {
    const { ex, poses } = executeur(graphe('set_optout'));
    await ex.advance('t1', '33600000001', 'msg1', 'Oui');
    expect(poses).toEqual([{ waId: '33600000001', value: 'opted_out' }]);
  });

  it('opt-in : même chemin, autre sens', async () => {
    const { ex, poses } = executeur(graphe('set_optin'));
    await ex.advance('t1', '33600000001', 'msg1', 'Oui');
    expect(poses).toEqual([{ waId: '33600000001', value: 'opted_in' }]);
  });

  it('🔴 câblage SANS effet de consentement -> no-op silencieux, pas une erreur', async () => {
    // La dep est REQUISE depuis le lot 3 de l'audit ponytail ; ce cas garde la preuve que sa valeur inerte
    // (`consentementNonEcrit`) reproduit l'ancienne absence : un scénario qui traverse le bloc ne part pas en DLQ.
    const { ex, poses } = executeur(graphe('set_optout'), false);
    await expect(ex.advance('t1', '33600000001', 'msg1', 'Oui')).resolves.not.toThrow();
    expect(poses).toEqual([]);
  });
});
