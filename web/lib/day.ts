import type { Locale } from './locale';

/**
 * Helpers de date fuseau Europe/Paris (séparateurs de jour inbox, dates courtes). Purs, sans dépendance.
 * Le jour est calculé DANS le fuseau Paris (pas en UTC ni local machine). LOCALE REQUISE sur tout ce qui
 * s'AFFICHE (pas de défaut : tsc force chaque appelant à la fournir -> aucun oubli possible). Les tags BCP47
 * vivent ICI (et dans format.ts), jamais dans les composants.
 */
const TZ = 'Europe/Paris';

/** Tag BCP47 d'affichage : en-GB pour l'anglais (24 h, jour/mois), fr-FR sinon. */
function tag(locale: Locale): string {
  return locale === 'en' ? 'en-GB' : 'fr-FR';
}

/** Clé de jour Paris (YYYY-MM-DD) d'un instant ISO. CLÉ de tri/groupe, PAS un affichage : indépendante de la
 *  langue (en-CA = format ISO), ne PAS localiser. */
export function dayKey(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });
}

/** Libellé de séparateur : « Aujourd'hui/Today » / « Hier/Yesterday » / « 12 juillet 2026 / 12 July 2026 ». */
export function dayLabel(iso: string, locale: Locale): string {
  const key = dayKey(iso);
  const todayKey = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  // Hier = jour calendaire précédent, calculé sur les composantes de date (robuste au passage heure d'été).
  const [y, m, d] = todayKey.split('-').map(Number) as [number, number, number];
  const yestKey = new Date(Date.UTC(y, m - 1, d) - 86_400_000).toISOString().slice(0, 10);
  if (key === todayKey) return locale === 'en' ? 'Today' : "Aujourd'hui";
  if (key === yestKey) return locale === 'en' ? 'Yesterday' : 'Hier';
  return new Date(iso).toLocaleDateString(tag(locale), { timeZone: TZ, day: 'numeric', month: 'long', year: 'numeric' });
}

/** Heure HH:MM (fuseau Paris) d'un message, affichée sous la bulle et dans la liste. */
export function hourMin(iso: string, locale: Locale): string {
  return new Date(iso).toLocaleTimeString(tag(locale), { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
}

/** Date courte localisée (fuseau Paris), options Intl optionnelles (ex. { day:'2-digit', month:'2-digit', year:'2-digit' }). */
export function formatDate(iso: string, locale: Locale, opts?: Intl.DateTimeFormatOptions): string {
  return new Date(iso).toLocaleDateString(tag(locale), { timeZone: TZ, ...opts });
}
