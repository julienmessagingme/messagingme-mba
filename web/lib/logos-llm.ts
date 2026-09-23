/**
 * LE LOGO D'UN MODÈLE, dérivé du PRÉFIXE de son identifiant (`anthropic/claude-haiku-4.5` -> `anthropic`).
 *
 * 🔴 IL NE SE DEVINE PAS DU NOM LISIBLE. Le catalogue rend un `nom` maison (« Claude Haiku 4.5 ») qui ne
 * contient pas toujours le fournisseur, et un agent peut porter un modèle « en place, hors liste » que le
 * catalogue ne décrit plus du tout. Le seul porteur fiable du fournisseur est l'identifiant lui-même.
 *
 * ⚠️ `null` EST UN CAS NORMAL, pas une panne : un fournisseur qui entre au catalogue sans que son fichier
 * soit ajouté, ou un identifiant sans préfixe. L'appelant retombe alors sur la pastille typographique.
 */
/**
 * LES FOURNISSEURS DONT NOUS AVONS LE FICHIER, et rien de plus.
 *
 * 🔴 UN ENSEMBLE, PAS UNE TABLE DE NOMS DE MARQUE. Elle associait « anthropic » à « Anthropic », et cette
 * valeur n'était lue par personne : l'`alt` est VIDE, délibérément (la raison est écrite plus bas). Le piège
 * n'était pas le coût, c'était la LECTURE : le prochain à passer y aurait vu le texte alternatif qui restait
 * à brancher, l'aurait branché, et aurait cassé le nom accessible du bouton d'ouverture d'une fiche, que
 * deux tests protègent (`tests/web-logos-llm.test.ts` et `web/e2e/agents-entete.spec.ts`). Un ensemble ne
 * peut pas suggérer ça.
 */
const LOGOS: ReadonlySet<string> = new Set(['openai', 'anthropic', 'google', 'mistral', 'zai']);

/** Le fournisseur d'un identifiant de modèle, ou `null` s'il n'en porte pas. */
export function fournisseurDuModele(modele: string): string | null {
  const i = modele.indexOf('/');
  if (i <= 0) return null;
  return modele.slice(0, i).toLowerCase();
}

export function logoDuModele(modele: string): { src: string; alt: string } | null {
  const f = fournisseurDuModele(modele);
  if (f === null || !LOGOS.has(f)) return null;
  /**
   * ⚠️ `alt` VIDE, ET CE N'EST PAS UN OUBLI. Ce logo est DÉCORATIF : le nom du modèle est écrit juste à
   * côté, en toutes lettres. Un `alt` renseigné entrerait dans le nom accessible du bouton qui porte
   * l'image, et `web/e2e/agents-modele.spec.ts:51` ouvre justement la fiche par
   * `getByRole('button', { name: /Conseiller séjours/ })`. Un `alt="Anthropic"` ferait échouer ce test, et
   * avec lui tout le fichier, son clic vivant dans un helper commun.
   *
   * ⚠️ EN PNG, PAS EN SVG MONOCHROME. Ces marques sont MULTICOLORES (un dégradé pour Gemini, une grille de
   * couleurs pour Mistral, un orange propre à Anthropic) : un SVG en `currentColor` les rendrait toutes
   * grises, ce qui serait faux pour chacune.
   */
  return { src: `/llm/${f}.png`, alt: '' };
}

/** Le repli quand aucun logo ne convient : deux ou trois lettres, jamais un nom tronqué au hasard. */
export function pastilleDuModele(modele: string): string {
  const f = fournisseurDuModele(modele);
  if (f === null) return modele.slice(0, 2).toUpperCase();
  return f.slice(0, 2).toUpperCase();
}
