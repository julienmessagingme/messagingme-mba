/**
 * Type de langue UI, dans un fichier .ts PUR (sans JSX) : importable par les libs (day.ts, format.ts) ET par
 * le tsc RACINE (qui type-check tests/ sans --jsx : importer un type depuis i18n.tsx y échoue en TS6142).
 * i18n.tsx le ré-exporte pour que les composants continuent d'importer { Locale } depuis '@/lib/i18n'.
 */
export type Locale = 'fr' | 'en';
