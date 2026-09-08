import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { cheminDeNav, contientLaCle, ongletDeLaPage, type NavEntree, type Onglet } from './nav';

/**
 * La chaîne d'ancêtres d'une page dans la barre de navigation.
 *
 * Ce qu'on garde ici, ce n'est pas « la fonction rend un tableau », c'est la conséquence VISIBLE d'une
 * chaîne fausse : la page active se retrouve dans un menu replié, donc invisible, et son groupe de premier
 * niveau n'est pas surligné. Les deux se lisent sur ce même retour, d'où les deux sens vérifiés à chaque
 * niveau (trouvé -> chaîne complète ; pas trouvé -> vide, pas une exception).
 */
const NAV: NavEntree[] = [
  { key: 'accueil', href: '/accueil', label: 'Accueil' },
  { key: 'ia', label: 'AI Agent', children: [
    { key: 'mba', label: 'MBA', children: [
      { key: 'mba-guide', href: '/mba', label: 'MBA, guide' },
      { key: 'mba-settings', href: '/mba/parametres', label: 'MBA, paramètres' },
    ] },
    { key: 'agents', href: '/agents', label: 'Other AI agent' },
  ] },
  { key: 'analytics', label: 'Analytics', children: [
    // Quantitatif est passé de PAGE à GROUPE : quatre sous-onglets, donc un troisième niveau de plus.
    { key: 'quantitatif', label: 'Quantitatif', children: [
      { key: 'quanti-messages', href: '/dashboard', label: 'Messages & contacts' },
      { key: 'quanti-couts', href: '/dashboard/couts', label: 'Coûts' },
      { key: 'quanti-funnel', href: '/dashboard/funnel', label: 'Funnel' },
      { key: 'quanti-erreurs', href: '/dashboard/erreurs', label: 'Erreurs' },
    ] },
    { key: 'dashboard-quali', href: '/dashboard/quali', label: 'Qualitatif' },
  ] },
];

describe('cheminDeNav', () => {
  it('une page de TROISIÈME niveau rend ses deux ancêtres, dans l’ordre', () => {
    // C'est le cas qui a motivé le module : avec l'ancienne table plate, « MBA, guide » n'avait qu'un
    // ancêtre connu et le sous-menu « MBA » restait fermé sur la page où l'on venait d'arriver.
    expect(cheminDeNav(NAV, 'mba-guide')).toEqual(['ia', 'mba']);
    expect(cheminDeNav(NAV, 'mba-settings')).toEqual(['ia', 'mba']);
  });

  it('une page de DEUXIÈME niveau n’a qu’un ancêtre', () => {
    expect(cheminDeNav(NAV, 'agents')).toEqual(['ia']);
    expect(cheminDeNav(NAV, 'dashboard-quali')).toEqual(['analytics']);
  });

  /**
   * U1 : les quatre sous-onglets du Quantitatif.
   *
   * 🔴 Ce que ce test protège : une chaîne d'ancêtres fausse ne casse RIEN de visible tout de suite, elle
   * laisse juste la page active invisible dans un menu replié. C'est la raison d'être du module, et le
   * découpage du Quantitatif en quatre vient d'ajouter quatre pages à ce risque.
   */
  it('🔴 les QUATRE sous-onglets du Quantitatif rendent leurs deux ancêtres', () => {
    for (const cle of ['quanti-messages', 'quanti-couts', 'quanti-funnel', 'quanti-erreurs']) {
      expect(cheminDeNav(NAV, cle), `chaîne d’ancêtres de ${cle}`).toEqual(['analytics', 'quantitatif']);
    }
  });

  it('une entrée de PREMIER niveau n’a aucun ancêtre (et ce n’est pas un échec)', () => {
    // Vide ici veut dire « rien à déplier », et le surlignage retombe alors sur la page elle-même.
    expect(cheminDeNav(NAV, 'accueil')).toEqual([]);
  });

  it('une clé inconnue rend une chaîne vide plutôt que de casser la barre', () => {
    // Une page dont l'onglet n'est pas déclaré dans la nav existe (écrans d'exploitation). Le bon
    // comportement est de n'ouvrir aucun menu, pas de faire tomber toute la coquille applicative.
    expect(cheminDeNav(NAV, 'page-jamais-declaree')).toEqual([]);
  });

  it('le nom d’un GROUPE n’est pas sa propre chaîne : un groupe ne s’ouvre pas lui-même', () => {
    // `openGroups` est alimenté par ce retour. Si un groupe se rendait comme son propre ancêtre, cliquer
    // pour le refermer le rouvrirait au rendu suivant.
    expect(cheminDeNav(NAV, 'ia')).toEqual([]);
    expect(cheminDeNav(NAV, 'mba')).toEqual(['ia']);
  });
});

describe('contientLaCle', () => {
  const items: NavEntree[] = [{ key: 'a', label: 'A', children: [{ key: 'b', label: 'B', children: [{ key: 'c', href: '/c', label: 'C' }] }] }];

  it('descend à toutes les profondeurs', () => {
    for (const k of ['a', 'b', 'c']) expect(contientLaCle(items, k), k).toBe(true);
  });

  it('ne trouve pas ce qui n’y est pas', () => {
    expect(contientLaCle(items, 'z')).toBe(false);
    expect(contientLaCle([], 'a')).toBe(false);
  });
});

/**
 * L'onglet qui contient une page.
 *
 * Ce qu'on garde ici, ce n'est pas « la fonction rend une chaîne », c'est ce qu'une déduction fausse produit
 * à l'écran : la page s'affiche sous le mauvais onglet, donc avec le mauvais menu, et l'utilisateur ne
 * retrouve plus l'entrée par laquelle il vient d'arriver.
 */
describe('ongletDeLaPage', () => {
  const arbres: Record<Onglet, NavEntree[]> = {
    console: [
      { key: 'accueil', href: '/accueil', label: 'Accueil' },
      { key: 'contenu', label: 'Contenu', children: [{ key: 'templates', href: '/templates', label: 'Templates' }] },
    ],
    inbox: [{ key: 'inbox', href: '/inbox', label: 'Inbox' }],
    perf: [
      { key: 'quantitatif', label: 'Quantitatif', children: [{ key: 'quanti-couts', href: '/dashboard/couts', label: 'Coûts' }] },
    ],
  };

  it('trouve une page de PREMIER niveau', () => {
    expect(ongletDeLaPage(arbres, 'accueil')).toBe('console');
    expect(ongletDeLaPage(arbres, 'inbox')).toBe('inbox');
  });

  it('🔴 trouve une page ENFOUIE dans un groupe, à n’importe quelle profondeur', () => {
    // C'est le cas qui compte : la moitié des pages de la console vivent sous deux niveaux de groupe, et
    // c'est là qu'une recherche naïve « sur le premier niveau » les perdrait toutes.
    expect(ongletDeLaPage(arbres, 'templates')).toBe('console');
    expect(ongletDeLaPage(arbres, 'quanti-couts')).toBe('perf');
  });

  it('🔴 une clé INCONNUE tombe sur « console », elle ne fait pas disparaître la barre', () => {
    // Même parti pris que `cheminDeNav`, qui rend une chaîne vide plutôt que de jeter : une page dont
    // l'onglet n'a pas été déclaré doit s'afficher dans un onglet plausible.
    expect(ongletDeLaPage(arbres, 'page-inventee')).toBe('console');
  });

  it('un GROUPE est trouvé comme ses enfants : c’est une clé de la nav comme une autre', () => {
    expect(ongletDeLaPage(arbres, 'contenu')).toBe('console');
  });
});
