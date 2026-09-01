import { describe, it, expect } from 'vitest';
import { cheminDeNav, type NavEntree } from './nav';

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
    { key: 'dashboard', href: '/dashboard', label: 'Quantitatif' },
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
    expect(cheminDeNav(NAV, 'dashboard')).toEqual(['analytics']);
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
