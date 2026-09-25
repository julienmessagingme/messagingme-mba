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
 * L'adresse d'un code AVEC son suffixe variable, celle qu'on soumet à Meta depuis le 2026-09-02.
 *
 * 🔴 C'EST CE SUFFIXE QUI PERMET DE SAVOIR QUI A CLIQUÉ. Sans lui, le lien est identique pour les 5 000
 * destinataires et l'information « qui » n'existe nulle part au moment du clic. Meta n'accepte une variable
 * dans une URL de bouton qu'À LA FIN, ce qui tombe bien : `/r/<code>/{{1}}` se lit comme un chemin, et la
 * route `/r/:code/:jeton` le résout.
 *
 * ⚠️ Les templates DÉJÀ APPROUVÉS gardent l'ancienne forme, pour toujours : leur URL est figée chez Meta.
 * Leurs clics resteront anonymes, et `/r/:code` ne disparaîtra donc jamais.
 */
export const lienTraceAvecJeton = (base: string, code: string): string => `${lienDe(base, code)}/{{1}}`;

/**
 * Cette adresse de bouton, telle que Meta la rend, est-elle un lien tracé À JETON (la forme que
 * `lienTraceAvecJeton` produit, sur un code de `newTrackingCode`) ?
 *
 * 🔴 C'EST LA SEULE VARIABLE D'ADRESSE QU'UN ENVOI REMPLIT : le suffixe de ce jeton (`suffixesBoutons`). Une
 * autre URL à variable, posée hors de la console, n'a aucun chemin qui fournisse sa valeur, et Meta refuse le
 * message. Le catalogue de l'API publique s'en sert pour ne pas l'annoncer.
 *
 * ⚠️ L'envoi, lui, lit `tracked_links` (les liens CONFIRMÉS et marqués `avec_jeton`), pas cette forme. Les deux ne
 * divergent que pour une adresse étrangère qui imiterait exactement `/r/<code de 12 caractères>/{{1}}`.
 * `tests/v1-catalogues.test.ts` tient la parité avec le producteur, sur des codes tirés par le vrai générateur.
 */
export const estLienTraceAvecJeton = (url: string): boolean => /\/r\/[0-9a-hjkmnp-tv-z]{12}\/\{\{1\}\}$/.test(url.trim());

/**
 * L'adresse d'un code avec le jeton D'UN DESTINATAIRE écrit dedans, celle des messages RCS.
 *
 * 🔴 La différence avec `lienTraceAvecJeton` n'est pas cosmétique, c'est toute la différence entre les deux
 * canaux. Un template WhatsApp est soumis puis figé : son URL ne peut porter qu'un `{{1}}`, rempli à chaque
 * envoi par un composant de bouton, et se tromper fait échouer l'appel (132000). Un message RCS est composé À
 * L'ENVOI : on y écrit le jeton lui-même, sans variable, sans resoumission, sans risque de rejet.
 *
 * Sans jeton (contact inconnu de la base, lecture en échec), on rend l'adresse nue : le lien fonctionne et le
 * clic est compté, il n'est simplement rattaché à personne. Dégrader la mesure, jamais l'envoi.
 */
export const lienPourContact = (base: string, code: string, jeton?: string): string =>
  (jeton ? `${lienDe(base, code)}/${jeton}` : lienDe(base, code));

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
