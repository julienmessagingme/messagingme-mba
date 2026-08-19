import { describe, it, expect } from 'vitest';
import { etapeOffreUnChoix, walk } from '../src/workflow/engine';
import type { WorkflowGraph } from '../src/workflow/graph';

/**
 * Le prédicat qui gouverne le contrôle du fil, et son effet sur le parcours.
 *
 * Règle produit : une étape qui offre un CHOIX au client (bouton, réponse rapide, formulaire) garde la main
 * face à l'agent de Meta, parce que la réponse doit nous revenir pour être appariée. Une étape qui n'offre rien
 * relâche : l'agent reprend la parole et les actions du scénario continuent de leur côté.
 */

const noeud = (id: string, type: string, data: Record<string, unknown> = {}) =>
  ({ id, type, position: { x: 0, y: 0 }, data }) as WorkflowGraph['nodes'][number];

const graphe = (nodes: WorkflowGraph['nodes'], edges: Array<[string, string]> = []): WorkflowGraph => ({
  nodes,
  edges: edges.map(([source, target], i) => ({ id: `e${i}`, source, target })),
});

describe('etapeOffreUnChoix', () => {
  it('un template AVEC un bouton libellé offre un choix', () => {
    expect(etapeOffreUnChoix({ kind: 'sendTemplate', templateName: 't', language: 'fr', buttons: [{ type: 'QUICK_REPLY', text: 'Oui' }] })).toBe(true);
  });

  it('🔴 un template SANS bouton n’offre AUCUN choix', () => {
    // C'est le cas central de la règle : un template purement informatif ne doit pas retenir le fil, sinon
    // l'agent de Meta reste muet alors que personne n'attend de réponse précise.
    expect(etapeOffreUnChoix({ kind: 'sendTemplate', templateName: 't', language: 'fr', buttons: [] })).toBe(false);
    expect(etapeOffreUnChoix({ kind: 'sendTemplate', templateName: 't', language: 'fr', buttons: [{ type: 'URL', text: '   ' }] })).toBe(false);
  });

  it('un message rapide suit la même règle que le template', () => {
    expect(etapeOffreUnChoix({ kind: 'sendQuickMessage', body: 'b', buttons: [{ type: 'QUICK_REPLY', text: 'Oui' }] })).toBe(true);
    expect(etapeOffreUnChoix({ kind: 'sendQuickMessage', body: 'b', buttons: [{ type: 'QUICK_REPLY', text: '' }] })).toBe(false);
  });

  it('un formulaire attend forcément une saisie, donc il offre un choix', () => {
    expect(etapeOffreUnChoix({ kind: 'sendFlow', flowId: 'f', flowName: 'form', body: 'b', cta: 'Ouvrir' })).toBe(true);
  });

  it('une action qui ne parle pas au client n’offre rien', () => {
    expect(etapeOffreUnChoix({ kind: 'tag', tag: 'x' })).toBe(false);
    expect(etapeOffreUnChoix(null)).toBe(false);
  });
});

describe('walk : ce qui bloque le parcours selon que MBA est allumé', () => {
  const templateSansBouton = graphe(
    [noeud('n1', 'template', { templateName: 'info', templateButtons: [] }), noeud('n2', 'tag', { tag: 'informe' })],
    [['n1', 'n2']],
  );

  it('🔴 MBA ÉTEINT : un template sans bouton attend la réponse (comportement historique préservé)', () => {
    // Aucun client n'a MBA aujourd'hui : changer ce comportement pour tout le monde casserait des scénarios en
    // service, où le bloc qui suit un template n'est censé s'exécuter qu'à la réponse du contact.
    const r = walk(templateSansBouton, 'n1');
    expect(r.rest).toEqual({ status: 'waiting', nodeId: 'n1' });
    expect(r.actions.map((e) => e.action.kind)).toEqual(['sendTemplate']);
  });

  it('🔴 MBA ALLUMÉ : le même template ne bloque plus, et les actions suivantes s’exécutent', () => {
    const r = walk(templateSansBouton, 'n1', undefined, { mbaActif: true });
    expect(r.rest).toEqual({ status: 'done' });
    expect(r.actions.map((e) => e.action.kind)).toEqual(['sendTemplate', 'tag']);
  });

  it('MBA allumé : un template AVEC bouton attend quand même, le scénario est plus fort', () => {
    const avecBouton = graphe(
      [noeud('n1', 'template', { templateName: 'choix', templateButtons: [{ type: 'QUICK_REPLY', text: 'Oui' }] }), noeud('n2', 'tag', { tag: 'x' })],
      [['n1', 'n2']],
    );
    expect(walk(avecBouton, 'n1', undefined, { mbaActif: true }).rest).toEqual({ status: 'waiting', nodeId: 'n1' });
  });

  it('MBA allumé : un formulaire attend toujours', () => {
    const flow = graphe([noeud('n1', 'flow', { flowId: 'f1', body: 'b', cta: 'Ouvrir' })]);
    expect(walk(flow, 'n1', undefined, { mbaActif: true }).rest).toEqual({ status: 'waiting', nodeId: 'n1' });
  });

  it('un message rapide sans bouton continue dans les DEUX cas (règle historique inchangée)', () => {
    const rapide = graphe(
      [noeud('n1', 'quick_message', { body: 'coucou', quickReplies: [] }), noeud('n2', 'tag', { tag: 'vu' })],
      [['n1', 'n2']],
    );
    expect(walk(rapide, 'n1').rest).toEqual({ status: 'done' });
    expect(walk(rapide, 'n1', undefined, { mbaActif: true }).rest).toEqual({ status: 'done' });
  });
});
