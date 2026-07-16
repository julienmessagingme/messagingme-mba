/**
 * Whitelist serveur des codes de langue autorisés pour un template WhatsApp (validation de la route POST create).
 * Sous-ensemble utile des locales Meta « Supported languages ».
 *
 * ⚠️ GARDER SYNCHRONISÉ avec `web/lib/languages.ts` (META_TEMPLATE_LANGUAGES) : ce sont les MÊMES codes (le front
 *  y ajoute juste un libellé lisible par code). N'appliquer la whitelist qu'à la CRÉATION (à l'édition, la langue
 *  est immuable et n'est pas re-soumise à validation : d'anciens templates ont pu être créés à la main hors liste).
 */
export const TEMPLATE_LANGUAGE_CODES: readonly string[] = [
  'fr', 'en', 'en_US', 'en_GB', 'es', 'es_ES', 'es_MX', 'es_AR', 'pt_BR', 'pt_PT',
  'de', 'it', 'nl', 'ar', 'ca', 'cs', 'da', 'de_AT', 'el', 'fi', 'he', 'hi', 'hu',
  'id', 'ja', 'ko', 'ms', 'nb', 'pl', 'ro', 'ru', 'sv', 'th', 'tr', 'uk', 'vi',
  'zh_CN', 'zh_HK', 'zh_TW',
];

export function isValidTemplateLanguage(code: string): boolean {
  return TEMPLATE_LANGUAGE_CODES.includes(code);
}
