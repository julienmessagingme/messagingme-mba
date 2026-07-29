// Recherche + filtrage des blocs (Contenu > Blocs). Module PUR (aucune dépendance React/navigateur) -> testable
// depuis la suite racine (tests/web-node-search.test.ts). Filtres CUMULABLES : type (typologie) ET texte
// (mot-clé / contenu). La recherche texte balaie le contenu (summary), le nom du scénario, le code public et le
// type brut, insensible à la casse ET aux accents.

export interface SearchableNode {
  type: string;
  /** Résumé/contenu humain du bloc. */
  summary: string;
  /** Nom du scénario qui porte le bloc. */
  workflowName: string;
  /** Code public (nod_...) ou null. */
  code: string | null;
}

const COMBINING = /[̀-ͯ]/g;

/** Normalise pour comparaison : minuscules, sans accents, espaces resserrés. */
export function normalizeSearch(s: string): string {
  return s.normalize('NFD').replace(COMBINING, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Filtre une liste de blocs par type (typologie) ET par texte libre (mot-clé/contenu), cumulatifs. `type='all'`
 * = pas de filtre de type ; `query=''` = pas de filtre texte. Générique -> renvoie le même type d'item que l'entrée.
 */
export function filterNodes<T extends SearchableNode>(items: T[], type: string, query: string): T[] {
  const q = normalizeSearch(query);
  return items.filter((n) => {
    if (type !== 'all' && n.type !== type) return false;
    if (q === '') return true;
    const hay = normalizeSearch([n.type, n.summary, n.workflowName, n.code ?? ''].join(' '));
    return hay.includes(q);
  });
}
