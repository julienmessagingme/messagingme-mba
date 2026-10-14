/**
 * L'ADRESSE D'UNE IMAGE QUE LA CONSOLE PEUT DESSINER : https seulement. C'est la seule que la CSP de la console laisse
 * charger (`img-src`, `next.config.mjs`), et une page servie en https ne charge pas une image en http.
 *
 * ⚠️ Ne dit rien de ce que le serveur acceptera à l'envoi : c'est l'écran appelant qui le dit (la Chaîne a sa propre
 * règle, plus stricte, `imageAffichable` dans `chaine-apercu.ts`).
 */
export function imageDessinable(url: string): string | null {
  const brut = url.trim();
  return /^https:\/\//i.test(brut) ? brut : null;
}
