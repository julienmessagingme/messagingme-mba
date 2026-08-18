const COMBINING = /[̀-ͯ]/g;

/**
 * Normalise un texte pour COMPARAISON : minuscules, sans accents, espaces resserrés, sans bords.
 *
 * Partagé par la recherche de blocs et l'appariement des libellés de champ de formulaire, qui en portaient
 * chacun une copie caractère pour caractère (constante `COMBINING` comprise). Deux normalisations qui
 * divergent, ce sont deux écrans qui ne trouvent pas les mêmes résultats sur la même saisie.
 */
export function normalizeText(s: string): string {
  return s.normalize('NFD').replace(COMBINING, '').toLowerCase().replace(/\s+/g, ' ').trim();
}
