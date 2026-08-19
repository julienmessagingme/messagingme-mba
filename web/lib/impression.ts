/**
 * Export PDF, sans dépendance.
 *
 * On n'assemble pas un PDF : on demande au navigateur d'imprimer UNE zone, et « Enregistrer au format PDF »
 * est dans sa boîte d'impression sur tous les systèmes. Les bibliothèques de rendu (jspdf + html2canvas)
 * pèsent quelques centaines de kilo-octets, produisent une image plutôt qu'un document (texte non
 * sélectionnable, courbes crénelées), et n'apportent rien que la boîte d'impression ne fasse déjà.
 *
 * Le CSS qui masque le reste de la page vit dans `globals.css`, sous `@media print` UNIQUEMENT : à l'écran,
 * une zone restée marquée ne change donc strictement rien à ce qui s'affiche.
 */

/** Classe posée sur la zone à imprimer, le temps de l'impression. */
export const CLASSE_ZONE = 'zone-impression';

/** Le strict nécessaire pour marquer un élément : permet de vérifier la préparation sans DOM. */
export interface ZoneMarquable {
  classList: { add(classe: string): void; remove(classe: string): void };
}
export interface CorpsMarquable {
  dataset: Record<string, string | undefined>;
}

/**
 * Marque la zone et le corps du document, et rend la fonction qui remet EXACTEMENT l'état d'avant.
 *
 * Séparée de l'impression elle-même parce que c'est la RESTAURATION qui est risquée, pas l'ouverture de la
 * boîte : une zone restée marquée s'imprimerait avec la suivante. La restauration est idempotente (elle est
 * appelée par `afterprint`, qui n'est pas garanti d'être émis une seule fois).
 */
export function preparerImpression(zone: ZoneMarquable, corps: CorpsMarquable): () => void {
  zone.classList.add(CLASSE_ZONE);
  corps.dataset.impression = 'on';
  return () => {
    zone.classList.remove(CLASSE_ZONE);
    delete corps.dataset.impression;
  };
}

/**
 * Ouvre la boîte d'impression du navigateur sur cette seule zone (« Enregistrer au format PDF »).
 * No-op hors navigateur (SSR) ou si l'id ne désigne rien.
 */
export function imprimerZone(zoneId: string): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const zone = document.getElementById(zoneId);
  if (!zone) return;
  // Une zone restée marquée (impression précédente sans `afterprint`) s'imprimerait AVEC celle-ci.
  for (const reste of Array.from(document.getElementsByClassName(CLASSE_ZONE))) reste.classList.remove(CLASSE_ZONE);
  const restaurer = preparerImpression(zone, document.body);
  window.addEventListener('afterprint', restaurer, { once: true });
  window.print();
}
