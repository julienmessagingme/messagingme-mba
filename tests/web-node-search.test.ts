import { describe, it, expect } from 'vitest';
import { filterNodes, normalizeSearch, type SearchableNode } from '../web/lib/node-search';

// Fonctions PURES (aucune dépendance React) : gate testable de la recherche Contenu > Blocs.

const NODES: SearchableNode[] = [
  { type: 'template', summary: 'promo_ete', workflowName: 'Onboarding', code: 'nod_k7m2p3_0123456789ABCDEFGHJKMNPQRS' },
  { type: 'tag', summary: 'VIP', workflowName: 'Relance', code: null },
  { type: 'quick_message', summary: 'Bonjour, un café ?', workflowName: 'Accueil', code: null },
  { type: 'field', summary: 'Ville = Paris', workflowName: 'Onboarding', code: null },
];

describe('normalizeSearch', () => {
  it('minuscule, sans accents, espaces resserrés', () => {
    expect(normalizeSearch('  Café   Crème ')).toBe('cafe creme');
  });
});

describe('filterNodes', () => {
  it('type=all, query vide -> tout', () => {
    expect(filterNodes(NODES, 'all', '')).toHaveLength(4);
  });

  it('filtre par type seul (typologie)', () => {
    const r = filterNodes(NODES, 'tag', '');
    expect(r).toHaveLength(1);
    expect(r[0]!.summary).toBe('VIP');
  });

  it('recherche par contenu (summary)', () => {
    expect(filterNodes(NODES, 'all', 'promo').map((n) => n.type)).toEqual(['template']);
  });

  it('recherche par nom de scénario', () => {
    expect(filterNodes(NODES, 'all', 'onboarding')).toHaveLength(2);
  });

  it('recherche par code public', () => {
    expect(filterNodes(NODES, 'all', 'GHJKMNPQRS')).toHaveLength(1);
  });

  it('recherche par type brut (mot-clé)', () => {
    expect(filterNodes(NODES, 'all', 'quick_message')).toHaveLength(1);
  });

  it('insensible à la casse ET aux accents', () => {
    expect(filterNodes(NODES, 'all', 'CAFE')).toHaveLength(1); // « café »
  });

  it('filtres CUMULABLES : type + texte', () => {
    // type template restreint à Onboarding, puis « promo » -> 1 ; « VIP » (tag) exclu par le type
    expect(filterNodes(NODES, 'template', 'promo')).toHaveLength(1);
    expect(filterNodes(NODES, 'template', 'vip')).toHaveLength(0);
  });

  it('aucune correspondance -> liste vide', () => {
    expect(filterNodes(NODES, 'all', 'zzzz')).toHaveLength(0);
  });

  it('préserve le type d\'item (générique)', () => {
    const tagged = NODES.map((n) => ({ ...n, extra: 1 }));
    const r = filterNodes(tagged, 'all', 'promo');
    expect(r[0]!.extra).toBe(1);
  });
});
