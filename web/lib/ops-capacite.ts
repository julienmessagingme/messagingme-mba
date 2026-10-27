import type { DailyPoint, PointCapaciteHeureOps, PointFileHeureOps } from './api';
import { dayKey } from './day';

/**
 * L'ONGLET CAPACITÉ DE /OPS (refonte, lot 1) : de l'historique heure par heure aux courbes d'un point par jour, et aux
 * deux chiffres qui disent si la 2e copie d'API devient une habitude. Pur, testé dans `ops-capacite.test.ts`.
 */

/** Un point par jour de Paris : le maximum (copies, retard) ou la somme (attentes) des heures du jour. */
export function parJour<T extends { heure: string }>(points: T[], valeur: (p: T) => number, mode: 'max' | 'somme'): DailyPoint[] {
  const jours = new Map<string, number>();
  for (const p of points) {
    const jour = dayKey(p.heure);
    const v = valeur(p);
    const avant = jours.get(jour);
    jours.set(jour, avant === undefined ? v : mode === 'max' ? Math.max(avant, v) : avant + v);
  }
  return [...jours.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count }));
}

/** Le retard d'une file, jour par jour : le pire p95 de bout en bout de ses heures, en secondes. */
export function retardParJour(files: PointFileHeureOps[], file: string): DailyPoint[] {
  return parJour(files.filter((f) => f.file === file), (f) => Math.round(f.boutEnBoutP95Secondes * 10) / 10, 'max');
}

/**
 * Sur les sept derniers jours : combien de fois une 2e copie s'est allumée (une heure à 2 copies ou plus après une heure
 * à une seule), et combien d'heures en tout, à la minute près. Le seuil de la spec : orange à 3 montées, rouge à 1 h.
 */
export function montees7Jours(heures: PointCapaciteHeureOps[], maintenant = Date.now()): { montees: number; heures: number } {
  const depuis = maintenant - 7 * 24 * 3600 * 1000;
  const recentes = heures.filter((h) => Date.parse(h.heure) >= depuis).sort((a, b) => a.heure.localeCompare(b.heure));
  let montees = 0;
  let avant = 1;
  for (const h of recentes) {
    if (h.copiesMax >= 2 && avant < 2) montees += 1;
    avant = h.copiesMax;
  }
  const minutes = recentes.reduce((s, h) => s + h.minutesDeuxCopiesOuPlus, 0);
  return { montees, heures: Math.round((minutes / 60) * 10) / 10 };
}
