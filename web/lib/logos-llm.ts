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
const LOGOS: ReadonlyMap<string, string> = new Map([
  ['openai', 'OpenAI'],
  ['anthropic', 'Anthropic'],
  ['google', 'Google'],
  ['mistral', 'Mistral AI'],
  ['zai', 'Z.ai'],
]);

/** Le fournisseur d'un identifiant de modèle, ou `null` s'il n'en porte pas. */
export function fournisseurDuModele(modele: string): string | null {
  const i = modele.indexOf('/');
  if (i <= 0) return null;
  return modele.slice(0, i).toLowerCase();
}

export function logoDuModele(modele: string): { src: string; alt: string } | null {
  const f = fournisseurDuModele(modele);
  if (f === null) return null;
  const marque = LOGOS.get(f);
  if (marque === undefined) return null;
  /**
   * ⚠️ `alt` VIDE, ET CE N'EST PAS UN OUBLI. Ce logo est DÉCORATIF : le nom du modèle est écrit juste à
   * côté, en toutes lettres. Un `alt` renseigné entrerait dans le nom accessible du bouton qui porte
   * l'image, et `web/e2e/agents-modele.spec.ts:51` ouvre justement la fiche par
   * `getByRole('button', { name: /Conseiller séjours/ })`. Un `alt="Anthropic"` ferait échouer ce test, et
   * avec lui tout le fichier, son clic vivant dans un helper commun.
   */
  return { src: `/llm/${f}.svg`, alt: '' };
}

/** Le repli quand aucun logo ne convient : deux ou trois lettres, jamais un nom tronqué au hasard. */
export function pastilleDuModele(modele: string): string {
  const f = fournisseurDuModele(modele);
  if (f === null) return modele.slice(0, 2).toUpperCase();
  return f.slice(0, 2).toUpperCase();
}
