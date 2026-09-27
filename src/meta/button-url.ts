/**
 * Une URL de bouton est-elle envoyable à Meta ? Fonction pure.
 * Meta refuse une URL qu'il ne sait pas parser avec un message illisible (un chemin JSON) : on refuse avant
 * l'appel, en nommant le bouton. Règle : http ou https, un hôte qui contient un point, aucune espace.
 * Dupliquée dans `web/lib/button-url.ts` (aucun module partagé) ; `tests/web-button-url-parity.test.ts` tient la parité.
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
