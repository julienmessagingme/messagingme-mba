import { PAGES_COMMENT_FAIRE } from './aide-pages';
import type { Locale } from './locale';

/**
 * La page « Comment faire » du centre d'aide public pour l'écran où se trouve la personne (sa clé de `nav.ts`), dans la
 * langue de la console ; `null` quand l'écran n'en a pas. La correspondance est GÉNÉRÉE depuis les fiches publiques
 * (`aide-pages.ts`, `npm run vitrine:aide`) : un écran gagne son lien quand sa fiche passe `comment_faire: oui`.
 */
export function pageCommentFaire(ecran: string, locale: Locale): string | null {
  return Object.hasOwn(PAGES_COMMENT_FAIRE, ecran) ? PAGES_COMMENT_FAIRE[ecran]![locale] : null;
}
