/**
 * Une URL de bouton est-elle envoyable à Meta ? Fonction PURE, sans IO.
 *
 * Meta refuse une URL qu'il ne sait pas parser, avec un message illisible qui désigne un chemin JSON
 * (« components[1]['cards'][1]['components'][2]['buttons'][1]['url'] is not a valid URI »). Le cas le plus
 * fréquent est une adresse saisie sans `https://`. On le dit dans le formulaire, avant tout appel.
 *
 * Règle : schéma http ou https, un hôte non vide qui contient un point, et aucune espace.
 *
 * ⚠️ Cette règle est DUPLIQUÉE dans `src/meta/button-url.ts` : les deux builds (Next et API) ne partagent
 * aucun module. `tests/web-button-url-parity.test.ts` casse dès qu'elles divergent.
 */
export function isSendableButtonUrl(raw: string): boolean {
  const url = raw.trim();
  if (url === '' || /\s/.test(url)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return parsed.hostname.includes('.') && !parsed.hostname.startsWith('.') && !parsed.hostname.endsWith('.');
}
