/**
 * Modèle d'un message RCS, côté écran. Module PUR : aucun import de `api.ts`, donc aucune dépendance au
 * navigateur.
 *
 * Pourquoi ces types ne vivent pas dans `api.ts` avec le reste : `web/lib/rcs.ts` (la bascule TEXTE/CARTE) est
 * testé depuis la suite RACINE, qui compile en environnement Node. Un import qui remonte jusqu'à `api.ts`
 * tirerait `http.ts` et son `window`, et ferait échouer la compilation des tests. Même raison que
 * `web/lib/flow-mapping.ts`. `api.ts` les RÉ-EXPORTE, donc tous les écrans continuent de les importer de là.
 */

/** Suggestion RCS : bouton affiché sous le message. Trois formes, comme chez le provider. */
export type RcsSuggestion =
  | { kind: 'reply'; text: string; postbackData: string }
  | { kind: 'openUrl'; text: string; url: string; postbackData: string }
  | { kind: 'dial'; text: string; phoneNumber: string; postbackData: string };

/** Carte : le format à VISUEL, celui qui porte une image au-dessus du texte. Titre optionnel (le provider
 *  exige « un titre OU un média »). */
export interface RcsCard {
  title?: string;
  description?: string;
  mediaUrl?: string;
  /** Hauteur du visuel : SHORT (7:3), MEDIUM (2:1), TALL (16:9, la grande image de campagne). */
  mediaHeight?: 'SHORT' | 'MEDIUM' | 'TALL';
  suggestions?: RcsSuggestion[];
}

/** Message RCS. Union fermée, identique au modèle serveur : ce qui n'est pas ici ne s'envoie pas. */
export type RcsOutbound =
  | { kind: 'text'; text: string; suggestions?: RcsSuggestion[] }
  /** `suggestions` = la rangée de boutons SOUS le message (11 max), distincte des 4 boutons de la carte. */
  | { kind: 'card'; card: RcsCard; suggestions?: RcsSuggestion[] }
  | { kind: 'carousel'; cards: RcsCard[] };
