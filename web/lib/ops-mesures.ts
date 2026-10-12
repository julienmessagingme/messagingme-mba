import type { MesureStockage, TacheFondRow } from './api';
import type { Locale } from './locale';

/**
 * La lecture des tâches de fond et du stockage sur `/ops` : ce qui passe en rouge. À part des composants pour se
 * tester sans navigateur. Les deux seuils ont leur pendant serveur, tenus égaux par `tests/mesure-taches.test.ts`.
 */

/** Une passe plus longue passe en rouge (`SEUIL_TACHE_LENTE_MS`, `src/ops/mesure-taches.ts`) : déclencheur de l'audit. */
export const SEUIL_TACHE_LENTE_MS = 5 * 60_000;

/** Au-delà, il est temps de sortir les fichiers de la base (`SEUIL_FICHIERS_EN_BASE_OCTETS`, `src/ops/stockage.pg.ts`). */
export const SEUIL_FICHIERS_EN_BASE_OCTETS = 500 * 1024 * 1024;

/**
 * Le budget d'équipe Vercel (lot 14) : orange à 80 %, rouge à 95 %, les seuils des alertes Telegram du worker
 * (`SEUILS_POURCENT`, `src/agent/llm/consommation-equipe.ts`).
 */
export const SEUIL_VERCEL_ORANGE_POURCENT = 80;
export const SEUIL_VERCEL_ROUGE_POURCENT = 95;

/** La teinte de la jauge : `null` sous le premier seuil. Sans budget d'équipe, rouge : rien ne borne la dépense. */
export function teinteVercel(part: number | null): 'danger' | 'alerte' | null {
  if (part === null) return 'danger';
  if (part * 100 >= SEUIL_VERCEL_ROUGE_POURCENT) return 'danger';
  if (part * 100 >= SEUIL_VERCEL_ORANGE_POURCENT) return 'alerte';
  return null;
}

/** Des dollars de la passerelle d'IA, deux décimales : « 7,96 $ » (fr), « 7.96 $ » (en). */
export function fmtDollars(n: number, locale: Locale): string {
  return `${n.toLocaleString(locale === 'en' ? 'en-GB' : 'fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;
}

/** Une tâche à regarder : une passe a dépassé le seuil, a échoué, ou un tour a été sauté (passe trop longue ou bloquée). */
export function tacheEnAlerte(t: TacheFondRow): boolean {
  return t.maxMs >= SEUIL_TACHE_LENTE_MS || t.echecs > 0 || t.sautees > 0;
}

/** Les octets de fichiers en base, toutes familles confondues : c'est ce total que le seuil regarde. */
export function fichiersEnBase(m: MesureStockage): number {
  return m.familles.reduce((s, f) => s + f.octets, 0);
}

/** Des octets lisibles : « 980 o », « 12,4 Ko », « 9,8 Mo », « 1,2 Go ». */
export function fmtOctets(n: number, locale: string): string {
  const unites = locale.startsWith('en') ? ['B', 'KB', 'MB', 'GB'] : ['o', 'Ko', 'Mo', 'Go'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < unites.length - 1) { v /= 1024; i += 1; }
  const chiffres = i === 0 || v >= 100 ? 0 : 1;
  return `${v.toLocaleString(locale, { minimumFractionDigits: chiffres, maximumFractionDigits: chiffres })} ${unites[i]}`;
}
