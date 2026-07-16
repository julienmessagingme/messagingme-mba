import type { Locale } from './locale';

/** Formatage partagé (dashboard, campagnes, graphes). LOCALE REQUISE sur tout ce qui varie selon la langue
 *  (pas de défaut : tsc force chaque appelant). Les tags BCP47 vivent ICI (et dans day.ts), jamais dans les composants. */

/** Coût estimé : 4 décimales sous 1 (tarifs au message), 2 sinon. Nombre nu (devise = « devise du compte »).
 *  Indépendant de la langue (point décimal technique). */
export function fmtCost(n: number): string {
  return n.toFixed(n < 1 ? 4 : 2);
}

/** Nombre entier lisible : « 1 000 » (fr) / « 1,000 » (en). */
export function fmtNum(n: number, locale: Locale): string {
  return n.toLocaleString(locale === 'en' ? 'en-GB' : 'fr-FR');
}

/** Pourcentage borné (num/den) sans décimale : « 42 % » (fr, espace) / « 42% » (en) ; '—' si dénominateur nul. */
export function fmtPct(num: number, den: number, locale: Locale): string {
  if (den <= 0) return '—';
  const p = Math.round((num / den) * 100);
  return locale === 'en' ? `${p}%` : `${p} %`;
}

/**
 * Débit d'envoi (throughput.level Meta) -> valeur chiffrée en clair (messages/seconde), pas le libellé brut
 * « STANDARD ». Palier standard = 80 msg/s, palier élevé = 1 000 msg/s (barèmes Meta Cloud API). Toute autre
 * valeur retombe sur le brut (NOT_APPLICABLE reste explicité). Fonction pure -> testable en isolation.
 */
export function throughputLabel(level: string, locale: Locale): string {
  const fr: Record<string, string> = {
    STANDARD: '80 messages / seconde',
    HIGH: '1 000 messages / seconde',
    NOT_APPLICABLE: 'Non applicable',
  };
  const en: Record<string, string> = {
    STANDARD: '80 messages / second',
    HIGH: '1,000 messages / second',
    NOT_APPLICABLE: 'Not applicable',
  };
  return (locale === 'en' ? en : fr)[level.toUpperCase()] ?? level;
}

/**
 * Palier de messagerie Meta (messaging_limit_tier) -> cap en clair (nombre de clients contactables par 24 h).
 * C'est le PLAFOND de conversations business ouvertes/jour, distinct du débit (throughputLabel). Fonction pure.
 */
export function tierLabel(tier: string, locale: Locale): string {
  const fr: Record<string, string> = {
    TIER_50: '50 clients / 24 h',
    TIER_250: '250 clients / 24 h',
    TIER_1K: '1 000 clients / 24 h',
    TIER_10K: '10 000 clients / 24 h',
    TIER_100K: '100 000 clients / 24 h',
    TIER_UNLIMITED: 'Illimité',
    UNLIMITED: 'Illimité',
  };
  const en: Record<string, string> = {
    TIER_50: '50 customers / 24 h',
    TIER_250: '250 customers / 24 h',
    TIER_1K: '1,000 customers / 24 h',
    TIER_10K: '10,000 customers / 24 h',
    TIER_100K: '100,000 customers / 24 h',
    TIER_UNLIMITED: 'Unlimited',
    UNLIMITED: 'Unlimited',
  };
  return (locale === 'en' ? en : fr)[tier.toUpperCase()] ?? tier;
}
