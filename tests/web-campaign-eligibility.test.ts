import { describe, it, expect } from 'vitest';
import { entryNodeOf, isCampaignEligible } from '../web/lib/campaign-eligibility';
import type { GraphLike, GraphNodeLike } from '../web/lib/campaign-eligibility';

/**
 * Helper PUR du sélecteur de scénarios côté campagne (web/lib/campaign-eligibility.ts), testé depuis la suite
 * racine par import RELATIF (aucune dépendance React/Next).
 *
 * Ce qu'il protège : depuis le Lot D, un scénario peut démarrer par autre chose qu'un template et reste
 * enregistrable. Le sélecteur de campagne ne doit proposer QUE ce qui partira réellement en broadcast (audience
 * froide -> seul un template peut ouvrir, sinon Meta 131047). Un faux positif ici = une campagne proposée qui
 * échoue au clic (le serveur la refuse en 400) ; un faux négatif = un scénario valide invisible, donc
 * inutilisable depuis l'UI.
 */

const g = (nodes: GraphNodeLike[], edges: GraphLike['edges'] = []): GraphLike => ({ nodes, edges });
const n = (id: string, type: string, data: Record<string, unknown> = {}): GraphNodeLike => ({ id, type, data });

describe('entryNodeOf', () => {
  it('entrée = bloc SANS arête entrante, même s’il n’est pas le premier du tableau', () => {
    // L'ordre du tableau ne fait pas foi : c'est la topologie qui décide (miroir du serveur).
    const graph = g([n('b', 'tag', { tag: 'x' }), n('a', 'template', { templateName: 'promo' })], [{ id: 'e', source: 'a', target: 'b' }]);
    expect(entryNodeOf(graph)?.id).toBe('a');
  });

  it('graphe vide -> null ; cycle (tous les blocs ont une entrée) -> repli sur le 1er', () => {
    expect(entryNodeOf(g([]))).toBeNull();
    const cycle = g([n('a', 'template', { templateName: 'p' }), n('b', 'tag')], [{ id: 'e1', source: 'a', target: 'b' }, { id: 'e2', source: 'b', target: 'a' }]);
    expect(entryNodeOf(cycle)?.id).toBe('a');
  });
});

describe('isCampaignEligible', () => {
  it('entrée template CONFIGURÉE -> éligible', () => {
    expect(isCampaignEligible(g([n('a', 'template', { templateName: 'promo' })]))).toBe(true);
  });

  it('entrée template NON configurée (nom vide ou absent) -> NON éligible (échouerait au lancement)', () => {
    expect(isCampaignEligible(g([n('a', 'template', { templateName: '   ' })]))).toBe(false);
    expect(isCampaignEligible(g([n('a', 'template')]))).toBe(false);
  });

  it('entrée formulaire / message rapide -> NON éligible (une campagne part hors fenêtre 24 h)', () => {
    expect(isCampaignEligible(g([n('a', 'flow', { flowId: 'fl1' })]))).toBe(false);
    expect(isCampaignEligible(g([n('a', 'quick_message', { body: 'Salut', quickReplies: ['Oui'] })]))).toBe(false);
  });

  it('template PRÉSENT mais pas en entrée (tag -> template) -> NON éligible', () => {
    // Le serveur exige que l'ENTRÉE soit un template (c'est elle qui porte les variables de la campagne) :
    // proposer ce scénario mènerait à un 400 après le clic.
    const graph = g([n('a', 'tag', { tag: 'vip' }), n('b', 'template', { templateName: 'promo' })], [{ id: 'e', source: 'a', target: 'b' }]);
    expect(isCampaignEligible(graph)).toBe(false);
  });

  it('graphe vide -> NON éligible (rien à envoyer)', () => {
    expect(isCampaignEligible(g([]))).toBe(false);
  });
});
