/**
 * Helpers de date fuseau Europe/Paris pour les séparateurs de jour dans l'inbox.
 * Purs, sans dépendance. Le jour est calculé DANS le fuseau Paris (pas en UTC ni local machine).
 */
const TZ = 'Europe/Paris';

/** Clé de jour Paris (YYYY-MM-DD) d'un instant ISO. Deux messages du même jour Paris partagent la clé. */
export function dayKey(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });
}

/** Libellé de séparateur : « Aujourd'hui » / « Hier » / « 12 juillet 2026 » (fuseau Paris). */
export function dayLabel(iso: string): string {
  const key = dayKey(iso);
  const todayKey = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  // Hier = jour calendaire précédent, calculé sur les composantes de date (robuste au passage heure d'été).
  const [y, m, d] = todayKey.split('-').map(Number) as [number, number, number];
  const yestKey = new Date(Date.UTC(y, m - 1, d) - 86_400_000).toISOString().slice(0, 10);
  if (key === todayKey) return "Aujourd'hui";
  if (key === yestKey) return 'Hier';
  return new Date(iso).toLocaleDateString('fr-FR', { timeZone: TZ, day: 'numeric', month: 'long', year: 'numeric' });
}

/** Heure HH:MM (fuseau Paris) d'un message, affichée sous la bulle. */
export function hourMin(iso: string): string {
  return new Date(iso).toLocaleTimeString('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
}
