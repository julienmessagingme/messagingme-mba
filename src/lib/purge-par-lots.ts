/**
 * Enchaîne les lots d'une purge bornée par passage (`passe` efface au plus `taille` lignes et rend le nombre effacé)
 * tant que le lot précédent était plein, et s'arrête au premier lot incomplet ou une fois `budgetMs` écoulé : chaque
 * lot reste une instruction courte (verrou, WAL), et le balayage suivant reprend où celui-ci s'est arrêté. Un lot qui
 * échoue remonte son échec à la tâche, qui alerte. Rend le total effacé.
 */
export async function purgerJusquAEpuisement(
  passe: () => Promise<number>,
  o: { taille: number; budgetMs: number; maintenant?: () => number },
): Promise<number> {
  const maintenant = o.maintenant ?? (() => Date.now());
  const debut = maintenant();
  let total = 0;
  for (;;) {
    const n = await passe();
    total += n;
    if (n < o.taille || maintenant() - debut >= o.budgetMs) return total;
  }
}
