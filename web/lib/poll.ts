'use client';

/**
 * Répétition périodique DÉSYNCHRONISÉE (AUDIT-SCALE-2026-08-25.md, R7, correctif 4).
 *
 * `setInterval` fait battre tous les onglets ensemble : les vingt-cinq personnes d'un même client qui ouvrent
 * la console le matin, ou qui la rechargent après un déploiement, tapent la base à la même seconde, puis
 * toutes les 4, 15 et 30 secondes, pour toujours. Le nombre de requêtes ne change pas, leur RÉPARTITION si :
 * une pointe de vingt-cinq requêtes simultanées devient un flot régulier, et c'est la pointe qui sature.
 *
 * Chaque attente vaut `periodeMs` +/- 20 %, retirée à neuf après chaque exécution : deux onglets partis
 * ensemble s'écartent au lieu de rester en phase.
 *
 * Rend la fonction d'arrêt, à appeler dans le nettoyage de l'effet (comme `clearInterval`).
 */
export function repeterAvecGigue(action: () => void, periodeMs: number): () => void {
  let vivant = true;
  let id: ReturnType<typeof setTimeout>;
  const programmer = (): void => {
    id = setTimeout(() => {
      if (!vivant) return;
      action();
      programmer();
    }, periodeMs * (0.8 + Math.random() * 0.4));
  };
  programmer();
  return () => {
    vivant = false;
    clearTimeout(id);
  };
}
