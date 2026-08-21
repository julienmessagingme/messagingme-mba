/**
 * Type de langue UI, dans un fichier .ts PUR (sans JSX) : importable par les libs (day.ts, format.ts) ET par
 * le tsc RACINE (qui type-check tests/ sans --jsx : importer un type depuis i18n.tsx y échoue en TS6142).
 * i18n.tsx le ré-exporte pour que les composants continuent d'importer { Locale } depuis '@/lib/i18n'.
 */
export type Locale = 'fr' | 'en';

/**
 * Clé de persistance de la langue. Ici et pas dans `i18n.tsx` parce que `http.ts` en a besoin AUSSI : il
 * jette des messages destinés à l'écran depuis des fonctions ordinaires, où le contexte React est hors
 * d'atteinte. Deux copies du littéral finiraient par diverger, et la traduction s'arrêterait sans bruit.
 */
export const LOCALE_STORAGE_KEY = 'mba_locale';
