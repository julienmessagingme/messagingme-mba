import { normaliserCles, type VerrousCourts } from '../src/db/verrous-courts';

/**
 * Le double en mémoire des verrous courts (`src/db/verrous-courts.ts`), aux MÊMES règles que l'adaptateur
 * Postgres : toutes les clés ou aucune, une clé échue se reprend (libre dès que l'heure atteint l'échéance, comme
 * `expire_le <= now()`), et on ne relâche que ce qui porte encore son jeton. Deux « copies » de l'API qui
 * partagent ce double partagent donc leurs verrous, comme deux copies qui partagent la base.
 *
 * Vit dans `tests/`, jamais dans `src/` : il y serait importable par le câblage de production, qui retomberait
 * alors sur des verrous par processus sans qu'aucune erreur ne le dise.
 */
export function verrousEnMemoire(maintenant: () => number = Date.now): VerrousCourts & { tenues(): string[] } {
  const lignes = new Map<string, { jeton: string; fin: number }>();
  let prises = 0;
  return {
    // Aucun `await` avant l'écriture : vérifier et retenir est un seul geste, comme l'instruction en base.
    async prendre(demandees) {
      const cles = normaliserCles(demandees);
      const t = maintenant();
      if (cles.some(([c]) => (lignes.get(c)?.fin ?? -Infinity) > t)) return null;
      prises += 1;
      const jeton = `prise-${prises}`;
      for (const [c, duree] of cles) lignes.set(c, { jeton, fin: t + duree });
      return { jeton, cles: cles.map(([c]) => c) };
    },
    async relacher(prise) {
      for (const c of prise.cles) if (lignes.get(c)?.jeton === prise.jeton) lignes.delete(c);
    },
    // Comme l'adaptateur : le jeton seul décide, qu'une clé soit échue ou non ; `false` dès qu'une clé ne le porte plus.
    async prolonger(prise, dureeMs) {
      const t = maintenant();
      let tenues = 0;
      for (const c of prise.cles) {
        const ligne = lignes.get(c);
        if (ligne?.jeton !== prise.jeton) continue;
        ligne.fin = t + dureeMs;
        tenues += 1;
      }
      return tenues === prise.cles.length;
    },
    /** Les clés dont l'échéance court encore : ce qu'un test lit pour dire « rien n'est resté pris ». */
    tenues() {
      const t = maintenant();
      return [...lignes.entries()].filter(([, l]) => l.fin > t).map(([c]) => c).sort();
    },
  };
}
