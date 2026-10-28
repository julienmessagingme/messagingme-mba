import type { DailyPoint, PointCapaciteHeureOps, PointCockpitOps, PointFileHeureOps, PointMemoireHeureOps } from './api';
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
 * Une heure ne compte « à deux copies » qu'à partir de ces minutes-là. Chaque copie écrit sous son propre nom
 * (`API_COPIE=auto`) : pendant un déploiement, l'ancienne et la nouvelle se recouvrent une minute ou deux, et chaque
 * déploiement passerait sinon pour une montée en charge.
 */
export const MINUTES_MONTEE_MIN = 5;

/** Les copies d'une heure, déploiements effacés : un recouvrement de quelques minutes reste une seule copie. */
export function copiesDeLHeure(h: PointCapaciteHeureOps): number {
  return h.minutesDeuxCopiesOuPlus >= MINUTES_MONTEE_MIN ? h.copiesMax : Math.min(1, h.copiesMax);
}

/**
 * Sur les sept derniers jours : combien de fois une 2e copie s'est allumée (une heure à 2 copies ou plus après une heure
 * à une seule, ou sans mesure), et combien d'heures en tout, à la minute près, déploiements effacés
 * (`MINUTES_MONTEE_MIN`). Le seuil de la spec : orange à 3 montées, rouge à 1 h.
 */
export function montees7Jours(heures: PointCapaciteHeureOps[], maintenant = Date.now()): { montees: number; heures: number } {
  const depuis = maintenant - 7 * 24 * 3600 * 1000;
  const recentes = heures.filter((h) => Date.parse(h.heure) >= depuis).sort((a, b) => a.heure.localeCompare(b.heure));
  let montees = 0;
  let minutes = 0;
  let precedente: { heure: number; copies: number } | null = null;
  for (const h of recentes) {
    const t = Date.parse(h.heure);
    const copies = copiesDeLHeure(h);
    // Une heure sans ligne entre deux : la copie d'avant ne la prolonge pas.
    const avant = precedente !== null && t - precedente.heure <= 3600 * 1000 ? precedente.copies : 1;
    if (copies >= 2 && avant < 2) montees += 1;
    if (copies >= 2) minutes += h.minutesDeuxCopiesOuPlus;
    precedente = { heure: t, copies };
  }
  return { montees, heures: Math.round((minutes / 60) * 10) / 10 };
}

/** Une courbe de Cockpit, un point par jour de Paris : le pire de ses heures. Absente ou illisible : aucun point. */
export function cockpitParJour(points: PointCockpitOps[] | null | undefined): DailyPoint[] {
  return parJour(points ?? [], (p) => p.valeur, 'max');
}

/** Les rôles qui ont relevé leur mémoire, dans un ordre stable. */
export function rolesDeMemoire(points: PointMemoireHeureOps[]): string[] {
  return [...new Set(points.map((p) => p.role))].sort();
}

/**
 * La mémoire d'un worker en pourcentage de la limite de son conteneur, le pire de chaque jour. Une heure sans limite
 * (hors d'un conteneur) ne se rapporte à rien : elle ne compte pas.
 */
export function memoireWorkerParJour(points: PointMemoireHeureOps[], role: string): DailyPoint[] {
  return parJour(
    points.filter((p) => p.role === role && p.limiteOctets !== null && p.limiteOctets > 0),
    (p) => Math.round((1000 * p.maxOctets) / (p.limiteOctets as number)) / 10,
    'max',
  );
}

/**
 * Le premier jour mesuré d'un graphique, jamais avant `defaut` : avant lui, un jour sans mesure se dessinerait à zéro,
 * comme une mesure (Cockpit ne garde que depuis la création des ressources, nos tables depuis leur migration).
 */
export function debutMesure(series: ReadonlyArray<{ points: DailyPoint[] }>, defaut: string): string {
  const dates = series.flatMap((s) => s.points.map((p) => p.date)).sort();
  const premier = dates[0];
  return premier !== undefined && premier > defaut ? premier : defaut;
}
