/**
 * Codes de langue autorisés à la création d'un template WhatsApp (sous-ensemble des locales Meta).
 * Mêmes codes que `web/lib/languages.ts`, à garder synchronisés. Ne s'applique qu'à la création : à l'édition la
 * langue est immuable, et d'anciens templates ont pu être créés hors liste.
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
