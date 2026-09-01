/**
 * Le modèle de la barre de navigation, et la seule fonction qui sache où se trouve une page dedans.
 *
 * Pourquoi un module à part : la barre a désormais TROIS niveaux (« AI Agent » > « MBA » > « MBA, guide »).
 * Tant qu'elle en avait deux, l'appartenance d'une page à son groupe se lisait dans une table plate écrite à
 * la main dans `AppShell`. À trois niveaux ça ne suffit plus, parce qu'une page a maintenant une CHAÎNE
 * d'ancêtres et que deux choses en dépendent : le groupe à surligner (le premier), et les groupes à déplier
 * (tous). Une chaîne fausse ne casse rien de visible tout de suite, elle laisse juste la page active
 * invisible dans un menu replié, ce qui se remarque tard. D'où le calcul unique, ici, testé.
 */

export interface NavEntree {
  key: string;
  /** Une entrée porte SOIT un lien, SOIT des enfants. Un groupe n'est pas cliquable comme destination. */
  href?: string;
  label: string;
  /** Tracé de l'icône. Seul le premier niveau en porte une. */
  d?: string;
  children?: NavEntree[];
  badge?: number;
}

/**
 * La chaîne des groupes qui MÈNENT à `key`, du plus haut au plus bas (`['ia', 'mba']` pour « MBA, guide »).
 *
 * Vide si la clé est une entrée de premier niveau, ou si elle est inconnue : l'appelant traite les deux de
 * la même façon (aucun groupe à ouvrir), et c'est voulu. Une clé inconnue est une page dont l'onglet n'a pas
 * été déclaré dans la nav ; le bon comportement est alors de n'ouvrir aucun menu, pas de planter la barre.
 */
export function cheminDeNav(items: NavEntree[], key: string): string[] {
  for (const item of items) {
    if (item.key === key) return [];
    if (!item.children) continue;
    if (item.children.some((c) => c.key === key)) return [item.key];
    const dessous = cheminDeNav(item.children, key);
    // `dessous` vide veut dire « pas trouvé » OU « trouvé au premier niveau de ce sous-arbre » ; le cas
    // « trouvé » est déjà pris par le `some` juste au-dessus, donc ici un tableau vide est bien un échec.
    if (dessous.length > 0) return [item.key, ...dessous];
  }
  return [];
}
