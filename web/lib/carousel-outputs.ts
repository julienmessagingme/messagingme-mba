import { carouselButtonHandle } from './carousel-handle';

/**
 * Module PUR : aucune IO, aucune dépendance React/navigateur (types STRUCTURAUX locaux, comme
 * `campaign-eligibility.ts`) -> testable depuis la suite racine. Importer `./api` ici tirerait `session.ts`
 * (et `window`) dans la compilation racine : à ne pas faire.
 */

/** Ce qu'on lit d'un template pour en déduire les sorties. Structurel : tout objet compatible convient. */
export interface CarouselTemplateLike {
  carousel?: {
    cards: Array<{
      mediaUrl?: string;
      mediaFormat?: 'IMAGE' | 'VIDEO';
      body?: string;
      buttons?: Array<{ type: 'QUICK_REPLY' | 'URL' | 'FLOW'; text?: string; url?: string }>;
    }>;
  };
}

/** Une sortie de bloc issue d'un bouton de carte : ce qu'on affiche, et le nom du fil à relier. */
export interface CarouselOutput {
  type: 'QUICK_REPLY' | 'URL' | 'FLOW';
  text: string;
  /** Nom de la sortie, identique au payload posé à l'envoi. C'est lui qui relie le tap à la branche. */
  handle: string;
  /** Index de la carte (0-based), pour l'étiquette « C1 », « C2 »… */
  cardIndex: number;
}

/**
 * Les sorties d'un bloc « envoi de template » quand le template est un CAROUSEL : un bouton de carte = une
 * sortie.
 *
 * Un carousel n'a aucun bouton de premier niveau, donc le bloc n'affichait AUCUNE sortie et il était
 * impossible de brancher quoi que ce soit après lui.
 *
 * Les boutons lien sont CONSERVÉS dans la liste (affichés grisés, non reliables) parce que leur position
 * compte dans l'identifiant : une réponse rapide qui suit un lien porte l'index 1, pas 0.
 * Template non carousel, ou sans carte : liste vide, le bloc retombe sur ses boutons de premier niveau.
 */
export function carouselOutputs(tpl: CarouselTemplateLike | undefined): CarouselOutput[] {
  const cards = tpl?.carousel?.cards;
  if (!Array.isArray(cards)) return [];
  return cards.flatMap((card, cardIndex) =>
    (card.buttons ?? []).map((b, buttonIndex) => ({
      type: b.type,
      text: b.text ?? '',
      handle: carouselButtonHandle(cardIndex, buttonIndex),
      cardIndex,
    })),
  );
}
