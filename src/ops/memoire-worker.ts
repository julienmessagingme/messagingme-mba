import { readFile } from 'node:fs/promises';

/**
 * LA MÉMOIRE D'UN WORKER, LUE PAR LUI-MÊME (refonte de /ops, lot 2). Cockpit voit la machine entière, pas chaque
 * conteneur : chaque worker lit donc son propre groupe de contrôle (cgroup v2, vérifié sur `mm-workers` le
 * 2026-10-28 : `memory.max` à 1073741824 pour le principal comme pour l'analyse).
 *
 * L'usage retenu est celui de `docker stats` : `memory.current` moins `inactive_file`, le cache de fichiers que le
 * noyau rend sans tuer personne (mesuré le même jour : 134 Mo sur les deux, au mégaoctet près). Hors d'un conteneur
 * (un poste, les tests), les fichiers manquent : la mémoire du processus seul, sans limite.
 */
export interface MemoireConteneur {
  utiliseOctets: number;
  /** `null` : aucune limite (`max`) ou hors d'un conteneur. */
  limiteOctets: number | null;
}

const CGROUP = '/sys/fs/cgroup';

/** Lit les trois fichiers ; pur sur leur contenu, testé sans conteneur. */
export function interpreterCgroup(current: string, stat: string, max: string): MemoireConteneur | null {
  const courant = Number(current.trim());
  if (!Number.isFinite(courant) || courant < 0) return null;
  const inactif = Number(/^inactive_file (\d+)$/m.exec(stat)?.[1] ?? 0);
  const limite = max.trim() === 'max' ? null : Number(max.trim());
  return {
    utiliseOctets: Math.max(0, courant - (Number.isFinite(inactif) ? inactif : 0)),
    limiteOctets: limite !== null && Number.isFinite(limite) && limite > 0 ? limite : null,
  };
}

export async function lireMemoireConteneur(
  lire: (chemin: string) => Promise<string> = (chemin) => readFile(chemin, 'utf8'),
  rss: () => number = () => process.memoryUsage().rss,
): Promise<MemoireConteneur> {
  try {
    const [current, stat, max] = await Promise.all([
      lire(`${CGROUP}/memory.current`), lire(`${CGROUP}/memory.stat`), lire(`${CGROUP}/memory.max`),
    ]);
    const lue = interpreterCgroup(current, stat, max);
    if (lue) return lue;
  } catch { /* hors d'un conteneur : le processus seul */ }
  return { utiliseOctets: rss(), limiteOctets: null };
}
