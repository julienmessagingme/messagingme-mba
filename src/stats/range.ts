/**
 * Plage de dates des stats (Analytics). Les bornes sont des dates civiles Europe/Paris (YYYY-MM-DD),
 * `to` INCLUS. Le passage aux instants UTC (bornes SQL / epoch pricing) se fait via `zonedMidnightEpochSec`
 * pour rester correct au changement d'heure (Paris = UTC+1 hiver / UTC+2 été) — jamais de `date*86400` naïf.
 */
export interface DateRange {
  from: string; // YYYY-MM-DD (Europe/Paris)
  to: string; // YYYY-MM-DD (Europe/Paris), inclus
}

export const STATS_TZ = 'Europe/Paris';
const MAX_SPAN_DAYS = 366; // couvre une année bissextile complète
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** true si `s` est une date YYYY-MM-DD valide (round-trip strict : rejette 2026-02-31). */
export function isValidDateStr(s: unknown): s is string {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Date du jour en Europe/Paris (YYYY-MM-DD). en-CA -> format ISO. */
export function todayParis(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: STATS_TZ });
}

/** Ajoute `delta` jours (calendaires) à une date YYYY-MM-DD. Arithmétique UTC pure (pas de dérive DST). */
export function addDays(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d) + delta * 86400000).toISOString().slice(0, 10);
}

/** Nombre de jours INCLUSIF entre from et to (from==to -> 1). Suppose from<=to. */
export function inclusiveDays(from: string, to: string): number {
  const [ya, ma, da] = from.split('-').map(Number) as [number, number, number];
  const [yb, mb, db] = to.split('-').map(Number) as [number, number, number];
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / 86400000) + 1;
}

/**
 * Instant Unix (secondes) de minuit Europe/Paris du jour `dateStr`. DST-safe : on lit le wall-clock que
 * l'instant minuit-UTC projette en Paris, et on corrige de l'offset observé. Pas de dépendance externe.
 */
export function zonedMidnightEpochSec(dateStr: string, tz: string = STATS_TZ): number {
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number];
  const asUTC = Date.UTC(y, m - 1, d); // minuit UTC du jour
  const wall = new Date(asUTC).toLocaleString('sv-SE', { timeZone: tz }); // "YYYY-MM-DD HH:MM:SS" en tz
  const wallMs = Date.parse(wall.replace(' ', 'T') + 'Z'); // ce wall-clock lu comme UTC
  // offset = asUTC - wallMs (négatif à l'est de UTC) ; minuit Paris = asUTC + offset.
  return Math.floor((2 * asUTC - wallMs) / 1000);
}

/** Bornes epoch (s) d'une plage pour Meta pricing_analytics : [minuit Paris de from, minuit Paris de to+1). */
export function rangeToUnix(range: DateRange): { startTs: number; endTs: number } {
  return { startTs: zonedMidnightEpochSec(range.from), endTs: zonedMidnightEpochSec(addDays(range.to, 1)) };
}

/**
 * Parse la plage depuis la query. from+to (YYYY-MM-DD, Paris) -> plage validée (from<=to, to non futur,
 * span <= 366j), sinon 400 (message). Aucun des deux -> repli `days` (défaut 30, clamp 1..366) finissant
 * aujourd'hui Paris. Un seul des deux -> 400 (from et to vont ensemble). Rétro-compat : `?days=30` inchangé.
 */
export function parseRange(query: Record<string, unknown>): { range: DateRange } | { error: string } {
  const from = query.from;
  const to = query.to;
  const hasFrom = from !== undefined && from !== '';
  const hasTo = to !== undefined && to !== '';

  if (hasFrom || hasTo) {
    if (!hasFrom || !hasTo) return { error: 'from et to doivent être fournis ensemble' };
    if (!isValidDateStr(from) || !isValidDateStr(to)) return { error: 'from/to invalides (format attendu YYYY-MM-DD)' };
    if (from > to) return { error: 'from doit être antérieur ou égal à to' };
    if (to > todayParis()) return { error: 'to ne peut pas être dans le futur' };
    if (inclusiveDays(from, to) > MAX_SPAN_DAYS) return { error: `plage limitée à ${MAX_SPAN_DAYS} jours` };
    return { range: { from, to } };
  }

  const raw = query.days !== undefined ? Number(query.days) : 30;
  const days = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), MAX_SPAN_DAYS) : 30;
  const to2 = todayParis();
  return { range: { from: addDays(to2, -(days - 1)), to: to2 } };
}
