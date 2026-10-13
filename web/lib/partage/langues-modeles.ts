/**
 * Les langues d'un modèle WhatsApp : celles que la console propose à la création, et les seules que le serveur
 * accepte (`isValidTemplateLanguage`). Sous-ensemble utile des locales Meta « Supported languages » : marchés
 * réellement visés par les clients en tête (fr / en / es / pt / de / it / nl / ar), puis les principales autres.
 * Le `code` est le code Meta EXACT (envoyé tel quel à l'API Graph) ; le `label` est l'autonyme (nom de la langue dans
 * sa langue), lisible en français comme en anglais.
 *
 * Ne s'applique qu'à la création : à l'édition la langue est immuable, et d'anciens modèles ont pu être créés hors
 * liste.
 */
export interface TemplateLanguage {
  code: string;
  label: string;
}

export const META_TEMPLATE_LANGUAGES: readonly TemplateLanguage[] = [
  { code: 'fr', label: 'Français' },
  { code: 'en', label: 'English' },
  { code: 'en_US', label: 'English (US)' },
  { code: 'en_GB', label: 'English (UK)' },
  { code: 'es', label: 'Español' },
  { code: 'es_ES', label: 'Español (España)' },
  { code: 'es_MX', label: 'Español (México)' },
  { code: 'es_AR', label: 'Español (Argentina)' },
  { code: 'pt_BR', label: 'Português (Brasil)' },
  { code: 'pt_PT', label: 'Português (Portugal)' },
  { code: 'de', label: 'Deutsch' },
  { code: 'it', label: 'Italiano' },
  { code: 'nl', label: 'Nederlands' },
  { code: 'ar', label: 'العربية' },
  { code: 'ca', label: 'Català' },
  { code: 'cs', label: 'Čeština' },
  { code: 'da', label: 'Dansk' },
  { code: 'de_AT', label: 'Deutsch (Österreich)' },
  { code: 'el', label: 'Ελληνικά' },
  { code: 'fi', label: 'Suomi' },
  { code: 'he', label: 'עברית' },
  { code: 'hi', label: 'हिन्दी' },
  { code: 'hu', label: 'Magyar' },
  { code: 'id', label: 'Bahasa Indonesia' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'ms', label: 'Bahasa Melayu' },
  { code: 'nb', label: 'Norsk (bokmål)' },
  { code: 'pl', label: 'Polski' },
  { code: 'ro', label: 'Română' },
  { code: 'ru', label: 'Русский' },
  { code: 'sv', label: 'Svenska' },
  { code: 'th', label: 'ไทย' },
  { code: 'tr', label: 'Türkçe' },
  { code: 'uk', label: 'Українська' },
  { code: 'vi', label: 'Tiếng Việt' },
  { code: 'zh_CN', label: '中文 (简体)' },
  { code: 'zh_HK', label: '中文 (香港)' },
  { code: 'zh_TW', label: '中文 (繁體)' },
];

export function isValidTemplateLanguage(code: string): boolean {
  return META_TEMPLATE_LANGUAGES.some((l) => l.code === code);
}
