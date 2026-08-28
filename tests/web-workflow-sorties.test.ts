import { describe, it, expect } from 'vitest';
import { SORTIE_LIBRE, poigneeCanevas, poigneeGraphe, uneAreteParSortie } from '../web/lib/workflow-sorties';

/**
 * La SORTIE LIBRE d'un bloc, et la traduction entre le canevas et le graphe enregistré.
 *
 * 🔴 CE QUE CES TESTS FERMENT, ET C'EST MESURÉ. Dans le graphe enregistré, la sortie libre est une arête SANS
 * `sourceHandle` : c'est le contrat du moteur (`nextNodeSansHandle`). React Flow, lui, ancre une arête sans
 * poignée sur la PREMIÈRE poignée de sortie du bloc : la flèche de « Toute autre réponse » était donc dessinée
 * sur la ligne de la première réponse rapide, où une autre flèche part déjà. Vérifié le 2026-08-28 en mesurant
 * le point de départ des flèches dans le DOM : l'arête libre partait exactement à l'ordonnée de `btn:0`.
 *
 * D'où la règle testée ici : le canevas NOMME cette poignée, le graphe enregistré continue de ne rien porter.
 */
describe('la sortie libre, entre le canevas et le graphe', () => {
  it('🔴 une arête sans poignée part de la sortie libre DANS LE CANEVAS', () => {
    // Sans ça, React Flow l'ancre sur la première poignée du bloc : deux flèches semblent partir de la même
    // réponse, et celle qu'on vient de relier n'apparaît pas là où on l'a tirée.
    expect(poigneeCanevas(undefined)).toBe(SORTIE_LIBRE);
    expect(poigneeCanevas(null)).toBe(SORTIE_LIBRE);
    expect(poigneeCanevas('')).toBe(SORTIE_LIBRE);
  });

  it('une poignée nommée reste elle-même', () => {
    for (const h of ['btn:0', 'row:2', 'timeout', 'true', 'false', 'sent', 'unreachable', 'sortie:fini', 'card:1:btn:0']) {
      expect(poigneeCanevas(h), h).toBe(h);
    }
  });

  it('🔴 la sortie libre redevient une arête SANS poignée à l’enregistrement', () => {
    // Le moteur lit `!e.sourceHandle` pour router une réponse hors boutons. Enregistrer « libre » ferait
    // disparaître cette branche du parcours, sur tous les scénarios déjà en production.
    expect(poigneeGraphe(SORTIE_LIBRE)).toBeUndefined();
    expect(poigneeGraphe(undefined)).toBeUndefined();
    expect(poigneeGraphe('')).toBeUndefined();
  });

  it('🔴 l’aller-retour ne change RIEN à un graphe existant', () => {
    // La garantie qui compte : ouvrir un scénario et l'enregistrer sans y toucher ne doit pas modifier ses
    // arêtes. Sept arêtes libres existent en production au 2026-08-28.
    for (const avant of [undefined, 'btn:0', 'row:1', 'sortie:escalade']) {
      expect(poigneeGraphe(poigneeCanevas(avant)), String(avant)).toBe(avant);
    }
  });

  it('🔴 une seule arête par sortie : le canevas montre ce que le MOTEUR fera', () => {
    // Le moteur prend la PREMIÈRE arête qui part d'une sortie : une seconde est inatteignable. La dessiner
    // ferait promettre une branche que le parcours n'empruntera jamais.
    const edges = [
      { id: 'a', source: 'n1', target: 'x', sourceHandle: 'btn:0' },
      { id: 'b', source: 'n1', target: 'y', sourceHandle: 'btn:0' },
      { id: 'c', source: 'n1', target: 'z' },
      { id: 'd', source: 'n1', target: 'w' },
      { id: 'e', source: 'n2', target: 'x', sourceHandle: 'btn:0' },
    ];
    expect(uneAreteParSortie(edges).map((e) => e.id)).toEqual(['a', 'c', 'e']);
  });

  it('une arête libre et une arête de bouton COEXISTENT : ce sont deux sorties', () => {
    const edges = [
      { id: 'a', source: 'n1', target: 'x', sourceHandle: 'btn:0' },
      { id: 'b', source: 'n1', target: 'y' },
    ];
    expect(uneAreteParSortie(edges)).toHaveLength(2);
  });
});
