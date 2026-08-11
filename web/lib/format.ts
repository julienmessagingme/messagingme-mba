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
 * Cap d'envoi 24 h (messaging_limit_tier Meta) -> nombre de clients contactables par 24 h, TOUJOURS affiché
 * (repli honnête si Meta ne l'a pas encore évalué : jamais un faux chiffre). C'est le vrai plafond métier ;
 * le débit brut (80 msg/s, identique pour tous) n'est PLUS affiché. Fonction pure -> testable en isolation.
 */
export function sendingLimitLabel(tier: string | null | undefined, locale: Locale): string {
  if (!tier) return locale === 'en' ? 'Not yet evaluated by Meta' : "Pas encore évalué par Meta";
  return tierLabel(tier, locale);
}

/**
 * Palier de messagerie Meta (messaging_limit_tier) -> cap en clair (nombre de clients contactables par 24 h).
 * Fonction pure. Passer par `sendingLimitLabel` pour l'affichage (gère le repli null).
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

/** Statut d'un signal de compte affiché dans le panneau : `tone` pilote la pastille (vert/ambre/gris). */
export type StatusTone = 'ok' | 'warn' | 'unknown';
export interface StatusBadge { label: string; tone: StatusTone }

/**
 * Onboarding de l'API MM Lite (marketing_messages_lite_api_status). `ONBOARDED` = approuvé (vert). Absence =
 * inconnu/non communiqué (gris), JAMAIS un faux "Non". Fonction pure -> testable.
 */
export function mmLiteBadge(status: string | null | undefined, locale: Locale): StatusBadge {
  if (!status) return { label: locale === 'en' ? 'Not reported' : 'Non communiqué', tone: 'unknown' };
  const up = status.toUpperCase();
  if (up === 'ONBOARDED') return { label: locale === 'en' ? 'Approved' : 'Approuvé', tone: 'ok' };
  const fr: Record<string, string> = { NOT_ONBOARDED: 'Non activé', IN_REVIEW: 'En revue', ONBOARDING: 'En cours' };
  const en: Record<string, string> = { NOT_ONBOARDED: 'Not enabled', IN_REVIEW: 'In review', ONBOARDING: 'In progress' };
  return { label: (locale === 'en' ? en : fr)[up] ?? status, tone: 'warn' };
}

/** Revue du compte WABA (account_review_status : APPROVED / PENDING / REJECTED). Fonction pure. */
export function accountReviewBadge(status: string | null | undefined, locale: Locale): StatusBadge {
  if (!status) return { label: locale === 'en' ? 'Not reported' : 'Non communiqué', tone: 'unknown' };
  const up = status.toUpperCase();
  if (up === 'APPROVED') return { label: locale === 'en' ? 'Approved' : 'Approuvé', tone: 'ok' };
  if (up === 'PENDING') return { label: locale === 'en' ? 'Pending' : 'En attente', tone: 'warn' };
  if (up === 'REJECTED') return { label: locale === 'en' ? 'Rejected' : 'Refusé', tone: 'warn' };
  return { label: status, tone: 'warn' };
}

/** Vérification d'entreprise (business_verification_status : verified / not_verified / pending). Fonction pure. */
export function businessVerificationBadge(status: string | null | undefined, locale: Locale): StatusBadge {
  if (!status) return { label: locale === 'en' ? 'Not reported' : 'Non communiqué', tone: 'unknown' };
  const up = status.toUpperCase();
  if (up === 'VERIFIED') return { label: locale === 'en' ? 'Verified' : 'Vérifiée', tone: 'ok' };
  if (up === 'PENDING' || up === 'PENDING_SUBMISSION') return { label: locale === 'en' ? 'Pending' : 'En attente', tone: 'warn' };
  if (up === 'NOT_VERIFIED') return { label: locale === 'en' ? 'Not verified' : 'Non vérifiée', tone: 'warn' };
  return { label: status, tone: 'warn' };
}

/**
 * Ce qu'une campagne envoie : un template nommé, ou un scénario. Fonction pure. Le libellé n'est JAMAIS vide
 * et ne contient JAMAIS de parenthèses vides : c'est ce qui interdit le retour du « template () » qu'affichait
 * une campagne scénario.
 */
export function campaignSendLabel(
  c: { templateName: string | null; templateLanguage: string | null; workflowName: string | null },
  locale: Locale,
): string {
  const q = (s: string): string => (locale === 'en' ? `“${s}”` : `« ${s} »`);
  const name = c.templateName?.trim();
  if (name) {
    const lang = c.templateLanguage?.trim();
    const head = `Template ${q(name)}`;
    return lang ? `${head} (${lang})` : head;
  }
  const wf = c.workflowName?.trim();
  if (wf) return `${locale === 'en' ? 'Scenario' : 'Scénario'} ${q(wf)}`;
  // Ni template ni scénario : le scénario a été supprimé (on delete set null sur campaigns.workflow_id).
  return locale === 'en' ? 'Deleted scenario' : 'Scénario supprimé';
}
