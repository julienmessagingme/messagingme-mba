/** Formatage partagé (dashboard, campagnes, graphes). */

/** Coût estimé : 4 décimales sous 1 (tarifs au message), 2 sinon. Nombre nu (devise = « devise du compte »). */
export function fmtCost(n: number): string {
  return n.toFixed(n < 1 ? 4 : 2);
}

/** Nombre entier lisible (séparateurs FR). */
export function fmtNum(n: number): string {
  return n.toLocaleString('fr-FR');
}

/** Pourcentage borné (num/den) affiché sans décimale ; '—' si dénominateur nul. */
export function fmtPct(num: number, den: number): string {
  if (den <= 0) return '—';
  return `${Math.round((num / den) * 100)} %`;
}

/**
 * Débit d'envoi (throughput.level Meta) -> valeur chiffrée en clair (messages/seconde), pas le libellé brut
 * « STANDARD ». Palier standard = 80 msg/s, palier élevé = 1 000 msg/s (barèmes Meta Cloud API). Toute autre
 * valeur retombe sur le brut (NOT_APPLICABLE reste explicité). Fonction pure -> testable en isolation.
 */
export function throughputLabel(level: string): string {
  const map: Record<string, string> = {
    STANDARD: '80 messages / seconde',
    HIGH: '1 000 messages / seconde',
    NOT_APPLICABLE: 'Non applicable',
  };
  return map[level.toUpperCase()] ?? level;
}

/**
 * Palier de messagerie Meta (messaging_limit_tier) -> cap en clair (nombre de clients contactables par 24 h).
 * C'est le PLAFOND de conversations business ouvertes/jour, distinct du débit (throughputLabel). Fonction pure.
 */
export function tierLabel(tier: string): string {
  const map: Record<string, string> = {
    TIER_50: '50 clients / 24 h',
    TIER_250: '250 clients / 24 h',
    TIER_1K: '1 000 clients / 24 h',
    TIER_10K: '10 000 clients / 24 h',
    TIER_100K: '100 000 clients / 24 h',
    TIER_UNLIMITED: 'Illimité',
    UNLIMITED: 'Illimité',
  };
  return map[tier.toUpperCase()] ?? tier;
}
