import type { Locale } from './locale';

/** Formatage partagé (dashboard, campagnes, graphes). LOCALE REQUISE sur tout ce qui varie selon la langue
 *  (pas de défaut : tsc force chaque appelant). Les tags BCP47 vivent ICI (et dans day.ts), jamais dans les composants. */

/**
 * Coût estimé : 4 décimales sous 1 (on affiche alors un tarif au message), 2 sinon.
 *
 * La DEVISE vient de Meta (champ `currency` du WABA, rendu sur le même appel que `pricing_analytics`) et n'est
 * jamais devinée : absente, on rend le nombre nu plutôt qu'un « € » qui serait faux hors zone euro. Elle n'est
 * pas non plus écrite en dur, la console n'étant pas réservée à des comptes français.
 *
 * ⚠️ `Intl.NumberFormat` LÈVE sur un code de devise invalide. La valeur venant d'une API externe, le format est
 * vérifié avant, et un code fantaisiste retombe sur le nombre nu au lieu de casser l'écran.
 */
export function fmtCost(n: number, locale: Locale, devise?: string | null): string {
  /**
   * ⚠️ QUATRE DECIMALES SOUS L'EURO, PARCE QUE C'EST UN TARIF AU MESSAGE ET PAS UN TOTAL : un coût par clic
   * de 0,0425 € arrondi au centime rendrait « 0,04 € », et la différence se compte en dizaines d'euros sur
   * une campagne de dix mille envois.
   *
   * 🔴 SAUF ZERO, ET C'EST LA CORRECTION DU 2026-09-17. « 0,0000 € » se lit comme un artefact d'arrondi,
   * pas comme un montant : zéro est exact, il n'a aucune précision à préserver. Vu à l'écran sur la ligne
   * « Messages de service » de la carte des coûts, où la franchise rend un coût nul en face de trois autres
   * postes à deux décimales. La justification des quatre décimales ne l'a jamais couvert : elle parle d'un
   * TARIF, et zéro n'en est pas un.
   */
  const decimales = n !== 0 && Math.abs(n) < 1 ? 4 : 2;
  /**
   * ⚠️ ET LE ZERO NEGATIF DEVIENT ZERO. `Intl` rend « -0,00 € » pour `-0`, qui est atteignable par arrondi
   * (`Math.round(-0.0001 * 100) / 100` vaut `-0`) et qui se lit comme une erreur de calcul. `n === 0` est
   * vrai pour `-0` en JavaScript, donc la branche des décimales le traite déjà comme un zéro : il ne restait
   * que l'affichage. Trouvé par le test de la correction du 2026-09-17, pas à l'écran.
   */
  const valeur = n === 0 ? 0 : n;
  const tag = locale === 'en' ? 'en-GB' : 'fr-FR';
  const options: Intl.NumberFormatOptions = { minimumFractionDigits: decimales, maximumFractionDigits: decimales };
  if (devise && /^[A-Za-z]{3}$/.test(devise)) {
    return new Intl.NumberFormat(tag, { ...options, style: 'currency', currency: devise.toUpperCase() }).format(valeur);
  }
  return new Intl.NumberFormat(tag, options).format(valeur);
}

/** Nombre entier lisible : « 1 000 » (fr) / « 1,000 » (en). */
export function fmtNum(n: number, locale: Locale): string {
  return n.toLocaleString(locale === 'en' ? 'en-GB' : 'fr-FR');
}

/**
 * Note de 0 a 10 avec UNE decimale : « 6,8 » (fr) / « 6.8 » (en).
 *
 * Elle existe pour la moyenne du nuage qualitatif, qui est la seule valeur decimale de la console a ne pas
 * etre un cout. `toFixed(1)` rendrait un point decimal dans les deux langues, a cote de nombres formates
 * par `fmtNum` : deux conventions dans la meme phrase.
 */
export function fmtNote(n: number, locale: Locale): string {
  return n.toLocaleString(locale === 'en' ? 'en-GB' : 'fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
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
