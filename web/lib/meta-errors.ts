// Traduction des codes d'erreur Meta (WhatsApp Cloud API) en message clair pour l'utilisateur.
// Les erreurs remontent sous la forme "131042 Business eligibility payment issue" (code + texte
// Meta) : on extrait le code numérique et on affiche une explication, sinon le texte brut.
//
// ⚠️ Module `.ts` PUR : `useT()` est un hook, inappelable ici. Les messages portent donc leurs DEUX langues
// en paires `[fr, en]` (convention du dépôt, cf. `ACTIONS_JOURNAL` dans `journal.ts` et `NODE_META`), et la
// langue arrive en paramètre REQUIS. Ces textes sortaient en français sur une console en anglais.

import type { Locale } from './locale';

const CODES: Record<string, [string, string]> = {
  '131042': [
    "Éligibilité / facturation Meta. Le marketing via MM Lite exige un onboarding au niveau Business Manager. On envoie désormais par l'endpoint standard ; si ça persiste, vérifie le moyen de paiement du WABA.",
    'Meta eligibility / billing. Marketing through MM Lite requires Business Manager onboarding. We now send through the standard endpoint; if it persists, check the payment method on the WABA.',
  ],
  '131047': [
    "Fenêtre de service 24 h fermée : il faut passer par un template (pas un message libre).",
    'The 24-hour service window is closed: you must use a template (not a free-form message).',
  ],
  '131026': [
    "Message non délivrable : le numéro n'a pas WhatsApp, ou ne peut pas recevoir ce message.",
    'Message not deliverable: the number has no WhatsApp, or cannot receive this message.',
  ],
  '131049': [
    "Meta a limité cet envoi pour préserver la qualité (trop de marketing vers cet utilisateur récemment).",
    'Meta throttled this send to protect quality (too much marketing to this user recently).',
  ],
  '130472': [
    "Numéro inclus dans une expérimentation Meta de limitation marketing : message non envoyé.",
    'Number included in a Meta marketing-limit experiment: message not sent.',
  ],
  '131045': [
    "Numéro expéditeur non enregistré / problème de certificat côté Meta.",
    'Sender number not registered / certificate problem on Meta side.',
  ],
  '131009': [
    "Meta a refusé une valeur envoyée avec le template (variable, image d'en-tête ou de carte, jeton de formulaire). Vérifie la valeur puis renvoie.",
    'Meta rejected a value sent with the template (variable, header or card image, form token). Check the value then send again.',
  ],
  '132000': [
    "Template : le nombre de variables fournies ne correspond pas au template.",
    'Template: the number of variables provided does not match the template.',
  ],
  '132001': [
    "Template introuvable ou non approuvé pour cette langue.",
    'Template not found or not approved for this language.',
  ],
  '132005': [
    "Template : le texte traduit dépasse la limite de caractères.",
    'Template: the translated text exceeds the character limit.',
  ],
  '132007': [
    "Template : contenu refusé par une politique Meta.",
    'Template: content rejected by a Meta policy.',
  ],
  // Meta dit « les paramètres ne correspondent pas à la structure du template ». Ne PAS restreindre ça à
  // « une variable » : ce code tombe aussi sur un carousel, une image d'en-tête ou un bouton mal formé, et un
  // libellé trop étroit envoie chercher une variable sur un template qui n'en a aucune.
  '132012': [
    "Template : ce qui a été envoyé ne correspond pas à sa structure (variables, image d'en-tête, carousel ou boutons). Vérifie le template côté Meta.",
    'Template: what was sent does not match its structure (variables, header image, carousel or buttons). Check the template on Meta.',
  ],
  '132015': [
    "Template en pause (qualité trop basse).",
    'Template paused (quality too low).',
  ],
  '132016': [
    "Template désactivé (qualité trop basse).",
    'Template disabled (quality too low).',
  ],
  '133010': [
    "Numéro non enregistré sur la plateforme.",
    'Number not registered on the platform.',
  ],
  '190': [
    "Token d'accès Meta expiré ou invalide.",
    'Meta access token expired or invalid.',
  ],
  '100': [
    "Paramètre invalide dans l'appel Meta.",
    'Invalid parameter in the Meta call.',
  ],
  '368': [
    "Compte temporairement restreint par Meta (violation de politique).",
    'Account temporarily restricted by Meta (policy violation).',
  ],
  '80007': [
    "Limite de débit atteinte : réessaie un peu plus tard.",
    'Rate limit reached: try again a little later.',
  ],
  '131000': [
    "Erreur temporaire côté Meta : réessaie.",
    'Temporary error on Meta side: try again.',
  ],
  '131016': [
    "Service Meta momentanément indisponible : réessaie.",
    'Meta service momentarily unavailable: try again.',
  ],
};

/** Les codes répertoriés. Exporté pour que le test itère la VRAIE table et pas une copie qui dériverait. */
export const CODES_CONNUS: readonly string[] = Object.keys(CODES);

/** Le message d'un code, dans la langue voulue. `undefined` si le code n'est pas répertorié. */
function messageDe(code: string, locale: Locale): string | undefined {
  const paire = CODES[code];
  if (!paire) return undefined;
  return locale === 'en' ? paire[1] : paire[0];
}

/**
 * Rend une erreur Meta lisible. Extrait le 1er code numérique (2 à 6 chiffres) et renvoie
 * l'explication + le code entre parenthèses. Inconnu -> texte brut inchangé. null -> null.
 */
export function explainMetaError(raw: string | null | undefined, locale: Locale): string | null {
  if (!raw) return null;
  const code = raw.match(/\b(\d{2,6})\b/)?.[1];
  const friendly = code ? messageDe(code, locale) : undefined;
  return friendly ? `${friendly} (code ${code})` : raw;
}

/** Libellé d'un code d'erreur Meta NUMÉRIQUE (breakdown analytics). Inconnu -> « Erreur Meta ». */
export function metaCodeLabel(code: number, locale: Locale): string {
  return messageDe(String(code), locale)
    ?? (locale === 'en' ? 'Meta error (code not listed)' : 'Erreur Meta (code non répertorié)');
}
