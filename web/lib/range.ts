/**
 * Calcul des plages de dates des ecrans Analytics.
 *
 * Module PUR (aucun import du tout) : il est partage par les pages quantitatif et qualitatif, et il est
 * testable depuis la suite de tests racine, qui compile SANS la lib DOM. C'est pour cette raison que le type
 * de plage est redefini ici au lieu d'importer `StatsRange` de `./api` : meme en import de TYPE, tsc chargerait
 * `api.ts` -> `session.ts` -> `window`, et la suite racine ne compilerait plus. La forme est identique, donc
 * `DateRange` reste assignable a `StatsRange` par structure.
 *
 * Tout est raisonne en Europe/Paris, pas en UTC : a 00h30 heure de Paris en ete, UTC est encore la VEILLE.
 * Un `new Date().toISOString().slice(0,10)` afficherait donc « aujourd'hui » avec un jour de retard pendant
 * deux heures chaque nuit, et la periode « 7 derniers jours » raterait la journee en cours.
 */

/** Plage de dates civiles inclusive, format YYYY-MM-DD. */
export interface DateRange { from: string; to: string }

/** Date du jour a Paris, au format YYYY-MM-DD. `en-CA` est la locale qui rend nativement ce format. */
export function todayParis(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
}

/**
 * Decale une date civile de `delta` jours. Le calcul passe par un minuit UTC des deux cotes : ajouter
 * 86400000 ms a un minuit UTC retombe toujours sur le minuit UTC suivant. Le piege d'heure d'ete (une
 * journee de 23 h ou 25 h) n'existe que si on part d'un minuit LOCAL, ce qu'on ne fait pas ici.
 */
export function addDays(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d) + delta * 86400000).toISOString().slice(0, 10);
}

/** Les `days` derniers jours, journee en cours INCLUSE (d'ou le -(days - 1) et non -days). */
export function presetRange(days: number): DateRange {
  const to = todayParis();
  return { from: addDays(to, -(days - 1)), to };
}

/** Raccourcis proposes dans le bandeau de periode. */
export const PRESETS = [7, 30, 90];

/** Le raccourci qui correspond exactement a cette plage, ou null si la plage a ete saisie a la main. */
export function activePreset(range: DateRange, today: string): number | null {
  if (range.to !== today) return null;
  return PRESETS.find((d) => range.from === addDays(today, -(d - 1))) ?? null;
}
