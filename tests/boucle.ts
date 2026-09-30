import { threadId } from 'node:worker_threads';

/**
 * Ce que la boucle d'événements perd pendant `f` : le plus long retard d'un minuteur de 10 ms, avec la durée de `f`
 * et son résultat. Une lecture faite dans le fil principal porte ce retard à sa propre durée ; faite dans un worker,
 * elle le laisse à quelques millisecondes.
 */
export async function retardPendant<T>(f: () => Promise<T>): Promise<{ retard: number; duree: number; resultat: T }> {
  let retard = 0;
  let dernier = performance.now();
  const minuteur = setInterval(() => {
    const t = performance.now();
    retard = Math.max(retard, t - dernier);
    dernier = t;
  }, 10);
  const debut = performance.now();
  try {
    const resultat = await f();
    const duree = performance.now() - debut;
    // 🔴 Un tour de minuteur AVANT de lire le retard : la promesse se résout en microtâche, juste après un éventuel
    // blocage, donc avant que le minuteur en retard ait pu le constater. Sans ce tour, un blocage d'une seconde
    // passait inaperçu (vu en écrivant ce test : 17 ms mesurés pour 1,7 s de blocage réel).
    await new Promise((fin) => setTimeout(fin, 25));
    return { retard, duree, resultat };
  } finally {
    clearInterval(minuteur);
  }
}

/** Guillemets mal placés puis une traîne d'espaces : papaparse y passe un temps en N x K (relevé le 2026-09-30). */
export const csvLent = (n: number, k: number): string => `"${'a"'.repeat(n)}${' '.repeat(k)}\nx`;

// Les sondes que les tests du lecteur (`tests/lib-hors-boucle.test.ts`) font tourner DANS le worker.

/** Le fil qui lit : deux lectures sur un même worker rendent le même. */
export const fil = (): number => threadId;

/** Une lecture qui dure sans occuper le processeur. */
export const attendre = (ms: number): Promise<number> => new Promise((fin) => setTimeout(() => fin(ms), ms));

/** Un compteur partagé qui bat toutes les 10 ms tant que le worker vit : sa mort se voit à l'arrêt du compteur. */
export function battre(pouls: Int32Array): void {
  setInterval(() => Atomics.add(pouls, 0, 1), 10);
}
