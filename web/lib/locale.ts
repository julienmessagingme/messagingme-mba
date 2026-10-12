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

/**
 * La langue portée par l'adresse (`?lang=en`), ou `null` (lot 18) : la page anglaise de la vitrine envoie vers
 * l'inscription et la doc avec ce paramètre, sinon le visiteur arriverait sur une console en français. L'adresse
 * l'emporte sur le choix mémorisé (le lien dit ce que le visiteur vient de choisir). Une valeur inconnue ne dit rien.
 */
export function langueDeLAdresse(recherche: string): Locale | null {
  const l = new URLSearchParams(recherche).get('lang')?.toLowerCase();
  return l === 'fr' || l === 'en' ? l : null;
}
