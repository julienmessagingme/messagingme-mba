/**
 * Les bornes d'un widget WhatsApp, lues au même endroit par le serveur (`src/widgets/gestion.ts`, qui tranche) et par la
 * console (`web/components/WidgetFormulaire.tsx` et `web/app/widgets/page.tsx`, qui guident la saisie) : une borne
 * recopiée qui dérive fait promettre à l'écran ce que le serveur refuse.
 */

/** Cinq widgets au plus par espace : un site vitrine, un blog, une page tarifs, et de la marge. */
export const LIMITE_WIDGETS_PAR_ESPACE = 5;
/** Le nom ne sert qu'au client, dans la liste : jamais montré au visiteur. */
export const MAX_NOM_WIDGET = 80;
/** La même borne que la phrase d'un lien de chaîne (`src/http/channels-me.ts`) : les deux vivent dans un `wa.me`. */
export const MAX_PHRASE_WIDGET = 300;
/** Le texte posé à côté de la bulle, dans une pastille de 240 pixels au plus (`src/widgets/script.ts`). */
export const MAX_LIBELLE_WIDGET = 60;
/** Le vert de WhatsApp, défaut de la colonne `couleur` (0200). */
export const COULEUR_PAR_DEFAUT = '#25d366';
/** Les quatre coins où la bulle se pose (la colonne `position`). */
export const POSITIONS_WIDGET = ['bas_droite', 'bas_gauche', 'haut_droite', 'haut_gauche'] as const;
export type PositionWidget = (typeof POSITIONS_WIDGET)[number];
