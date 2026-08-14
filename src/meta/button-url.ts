/**
 * Une URL de bouton est-elle envoyable à Meta ? Fonction PURE, sans IO.
 *
 * Meta refuse une URL qu'il ne sait pas parser, avec un message illisible qui désigne un chemin JSON
 * (« components[1]['cards'][1]['components'][2]['buttons'][1]['url'] is not a valid URI »). Le cas le plus
 * fréquent est une adresse saisie sans `https://`. On tranche AVANT l'appel : mieux vaut refuser en nommant
 * le bouton fautif que de renvoyer à l'opérateur un chemin de tableau.
 *
 * Règle : schéma http ou https, un hôte non vide qui contient un point (`https://exemple` sans domaine de
 * premier niveau n'est pas une adresse publique atteignable), et aucune espace.
 *
 * ⚠️ Cette règle est DUPLIQUÉE dans `web/lib/button-url.ts` : les deux builds (API et Next) ne partagent
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
