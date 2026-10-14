/**
 * LE NOM D'UNE COPIE DE L'API dans `/ops` et dans ses alertes (`API_COPIE` ; docs/ARCHITECTURE-CIBLE.md §10, étape 7).
 *
 * - vide : `api`, une copie unique (le VPS aujourd'hui) ;
 * - un nom : `api-<nom>`, posé à la main (le second banc de deux copies) ;
 * - `auto` : `api-<fin du nom d'hôte>`. Chez Scaleway, toutes les copies d'un autoscaling reçoivent la MÊME
 *   configuration : un nom fixe les additionnerait dans une seule courbe d'attentes de `/ops` (clé `(process,
 *   minute)`, cumul à l'insertion), et l'on ne saurait plus laquelle sature. Le nom d'hôte, lui, diffère d'une copie à
 *   l'autre ; on en garde la FIN, là où ces plateformes mettent ce qui distingue les copies.
 *
 * Le nom rendu respecte le format de `API_COPIE` (`^[a-z0-9-]{0,20}$`) derrière `api-`.
 */
export function nomDeCopie(copie: string, nomHote: string): string {
  if (copie === '') return 'api';
  if (copie !== 'auto') return `api-${copie}`;
  const propre = nomHote.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  const fin = propre.slice(-20).replace(/^-+|-+$/g, '');
  return fin === '' ? 'api' : `api-${fin}`;
}
