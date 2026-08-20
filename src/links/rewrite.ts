import { isSendableButtonUrl } from '../meta/button-url';
import type { CreateTemplateInput, TemplateButton } from '../meta/templates';

/**
 * Substitution des liens d'un template AVANT sa soumission à Meta.
 *
 * Tout est PUR ici : repérer les boutons traçables, et rendre une COPIE du template dont les URL sont
 * remplacées. L'allocation des codes et l'écriture en base restent à l'appelant, ce qui rend la règle
 * vérifiable sans base ni réseau.
 */

/** Un bouton URL traçable, repéré à sa position DANS LA NUMÉROTATION DE META. */
export interface CibleBouton {
  /** Index de la carte de carousel, ou null pour un bouton du template lui-même. */
  cardIndex: number | null;
  /** Index dans TOUS les boutons (non-URL compris) : c'est celui que Meta utilise. */
  buttonIndex: number;
  url: string;
}

/** Clé d'un bouton dans la table de substitution. */
export const cleBouton = (cardIndex: number | null, buttonIndex: number): string => `${cardIndex ?? -1}:${buttonIndex}`;

/** L'adresse publique d'un code. `base` sans slash final. */
export const lienDe = (base: string, code: string): string => `${base.replace(/\/+$/, '')}/r/${code}`;

/**
 * Les boutons URL qu'on sait tracer, dans l'ordre du template puis des cartes.
 *
 * Deux exclusions, chacune pour une raison précise :
 *  - une URL contenant déjà une VARIABLE (`{{1}}`) est laissée telle quelle : personne ne sait fournir sa
 *    valeur à l'envoi (aucun chemin d'envoi ne produit de composant `sub_type: 'url'`), et la tracer
 *    fabriquerait un lien cassé ;
 *  - une URL que Meta refuserait de toute façon n'est pas tracée : on ne veut pas d'une ligne en base qui
 *    décrit un template qui n'existera jamais.
 */
export function boutonsTracables(input: CreateTemplateInput): CibleBouton[] {
  const out: CibleBouton[] = [];
  const scan = (boutons: readonly TemplateButton[] | undefined, cardIndex: number | null): void => {
    (boutons ?? []).forEach((b, i) => {
      if (b.type !== 'URL') return;
      const url = (b.url ?? '').trim();
      if (url === '' || url.includes('{{')) return;
      if (!isSendableButtonUrl(url)) return;
      out.push({ cardIndex, buttonIndex: i, url });
    });
  };
  scan(input.buttons, null);
  (input.carousel?.cards ?? []).forEach((carte, ci) => scan(carte.buttons, ci));
  return out;
}

/**
 * Rend une COPIE du template dont les boutons listés dans `liens` portent l'adresse de redirection.
 *
 * Une copie et non une mutation : l'appelant garde l'original sous la main, ce dont il a besoin pour
 * soumettre le template NON tracé si l'allocation échoue en cours de route.
 */
export function appliquerLiens(input: CreateTemplateInput, liens: ReadonlyMap<string, string>): CreateTemplateInput {
  if (liens.size === 0) return input;
  const remplace = (boutons: readonly TemplateButton[] | undefined, cardIndex: number | null): TemplateButton[] | undefined => {
    if (!boutons) return undefined;
    return boutons.map((b, i) => {
      const lien = liens.get(cleBouton(cardIndex, i));
      return b.type === 'URL' && lien ? { ...b, url: lien } : b;
    });
  };
  const boutons = remplace(input.buttons, null);
  const cartes = input.carousel?.cards.map((carte, ci) => {
    const b = remplace(carte.buttons, ci);
    return b ? { ...carte, buttons: b } : carte;
  });
  return {
    ...input,
    ...(boutons ? { buttons: boutons } : {}),
    ...(cartes ? { carousel: { cards: cartes } } : {}),
  };
}

/**
 * L'inverse, pour l'AFFICHAGE : remontrer à l'utilisateur le lien qu'il a saisi, là où Meta nous rend le
 * nôtre. Sans ça, la console afficherait `…/r/ab12cd34ef56` dans les quatre écrans qui listent les templates,
 * et la promesse « tu saisis ton lien » serait fausse dès le premier rechargement de la page.
 *
 * L'appariement se fait sur l'URL DE REDIRECTION, pas sur la position : un template édité hors console peut
 * avoir vu ses boutons réordonnés, et un appariement par index remettrait alors la mauvaise destination.
 */
export function rehabillerBoutons<T extends { type: string; url?: string }>(
  boutons: readonly T[] | undefined,
  destinationParLien: ReadonlyMap<string, string>,
): T[] | undefined {
  if (!boutons) return undefined;
  if (destinationParLien.size === 0) return [...boutons];
  return boutons.map((b) => {
    if (b.type !== 'URL' || !b.url) return b;
    const origine = destinationParLien.get(b.url.trim());
    return origine ? { ...b, url: origine } : b;
  });
}
