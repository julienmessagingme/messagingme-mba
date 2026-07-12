import type { DailyPoint, CostVolumeRow } from './store.pg';

/** Coût estimé par jour et catégorie, sur la plage. `hasRates=false` si Meta n'a fourni aucun tarif. */
export interface CostSeries {
  /** point.count = coût estimé marketing du jour (devise du compte). */
  marketing: DailyPoint[];
  utility: DailyPoint[];
  total: number;
  hasRates: boolean;
}

/** Tarif Meta par message pour chaque catégorie (null = indisponible -> coût non estimable). */
export interface CategoryRates {
  marketing: number | null;
  utility: number | null;
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

/** Énumère les jours 'YYYY-MM-DD' de from à to INCLUS (arithmétique UTC pure, borne 366 jours). */
export function enumerateDays(from: string, to: string): string[] {
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number];
  const end = Date.UTC(ty, tm - 1, td);
  const days: string[] = [];
  let t = Date.UTC(fy, fm - 1, fd);
  for (let i = 0; t <= end && i <= 366; i++, t += 86_400_000) days.push(new Date(t).toISOString().slice(0, 10));
  return days;
}

/**
 * Combine un volume d'envois par (jour, catégorie) et les tarifs Meta -> série de coût estimé/jour,
 * dense sur [from, to] (0 pour les jours sans envoi). Une catégorie sans tarif connu ne contribue pas
 * au coût (jamais de coût inventé). Pur -> testable sans DB ni réseau.
 */
export function estimateCostSeries(from: string, to: string, rows: CostVolumeRow[], rates: CategoryRates): CostSeries {
  const days = enumerateDays(from, to);
  const mktByDay = new Map<string, number>();
  const utilByDay = new Map<string, number>();
  for (const r of rows) {
    const bucket = r.category === 'marketing' ? mktByDay : r.category === 'utility' ? utilByDay : null;
    const rate = r.category === 'marketing' ? rates.marketing : r.category === 'utility' ? rates.utility : null;
    if (!bucket || rate == null) continue;
    bucket.set(r.date, (bucket.get(r.date) ?? 0) + r.count * rate);
  }
  const marketing = days.map((d) => ({ date: d, count: round2(mktByDay.get(d) ?? 0) }));
  const utility = days.map((d) => ({ date: d, count: round2(utilByDay.get(d) ?? 0) }));
  const total = round2([...mktByDay.values(), ...utilByDay.values()].reduce((a, b) => a + b, 0));
  return { marketing, utility, total, hasRates: rates.marketing != null || rates.utility != null };
}
