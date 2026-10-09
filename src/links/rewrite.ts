import { isSendableButtonUrl } from '../../web/lib/partage/button-url';
import type { CreateTemplateInput, TemplateButton } from '../meta/templates';

/**
 * Substitution des liens d'un template avant sa soumission à Meta, en fonctions pures (repérer les boutons
 * traçables, rendre une copie du template). L'allocation et la base restent à l'appelant.
 */

/** Un bouton URL traçable, repéré à sa position dans la numérotation de Meta. */
export interface CibleBouton {
  /** Index de la carte de carousel, ou null pour un bouton du template lui-même. */
  cardIndex: number | null;
  /** Index dans tous les boutons (non-URL compris) : c'est celui que Meta utilise. */
  buttonIndex: number;
  url: string;
}

/** Clé d'un bouton dans la table de substitution. */
export const cleBouton = (cardIndex: number | null, buttonIndex: number): string => `${cardIndex ?? -1}:${buttonIndex}`;

/** L'adresse publique d'un code. `base` sans slash final. */
export const lienDe = (base: string, code: string): string => `${base.replace(/\/+$/, '')}/r/${code}`;

/**
 * L'adresse d'un code avec son suffixe variable, celle qu'on soumet à Meta.
 *
 * Ce suffixe permet de savoir qui a cliqué : sans lui, le lien est le même pour tous les destinataires. Meta
 * n'accepte une variable qu'en fin d'URL de bouton, et la route `/r/:code/:jeton` la résout.
 * Les templates déjà approuvés sans suffixe restent figés chez Meta : `/r/:code` ne disparaîtra jamais.
 */
export const lienTraceAvecJeton = (base: string, code: string): string => `${lienDe(base, code)}/{{1}}`;

/**
 * Cette adresse de bouton, telle que Meta la rend, est-elle un lien tracé à jeton (forme de
 * `lienTraceAvecJeton` sur un code de `newTrackingCode`) ?
 *
 * C'est la seule variable d'adresse qu'un envoi sait remplir (`suffixesBoutons`) : toute autre URL à variable
 * ferait refuser le message, et le catalogue de l'API publique s'en sert pour ne pas l'annoncer.
 * L'envoi, lui, lit `tracked_links` (liens confirmés `avec_jeton`). Parité tenue par `tests/v1-catalogues.test.ts`.
 */
export const estLienTraceAvecJeton = (url: string): boolean => /\/r\/[0-9a-hjkmnp-tv-z]{12}\/\{\{1\}\}$/.test(url.trim());

/**
 * Le code de cette adresse si elle est l'un de NOS liens tracés (`/r/<code>` ou `/r/<code>/{{1}}`), quel que soit
 * l'hôte, ou `null`. Le ré-habillage ne reconnaît que l'hôte d'aujourd'hui : un template soumis sous un ancien nom
 * (`mba.`, puis `engageme.`) réaffiche donc notre lien brut dans la console, et une édition le renvoie tel quel.
 */
export function codeDuLienTrace(url: string): string | null {
  return /^https?:\/\/[^/?#]+\/r\/([0-9a-hjkmnp-tv-z]{12})(?:\/\{\{1\}\})?$/i.exec(url.trim())?.[1]?.toLowerCase() ?? null;
}

/**
 * L'adresse d'un code avec le jeton d'un destinataire écrit dedans, celle des messages RCS : composés à l'envoi,
 * ils n'ont pas besoin du `{{1}}` de `lienTraceAvecJeton` (ni resoumission, ni risque de 132000).
 * Sans jeton, l'adresse nue : le clic est compté sans être rattaché. Dégrader la mesure, jamais l'envoi.
 */
export const lienPourContact = (base: string, code: string, jeton?: string): string =>
  (jeton ? `${lienDe(base, code)}/${jeton}` : lienDe(base, code));

/**
 * Les boutons URL qu'on sait tracer, dans l'ordre du template puis des cartes. Sont exclues :
 *  - une URL qui porte déjà une variable (`{{1}}`) : aucun chemin d'envoi ne fournit sa valeur, la tracer
 *    fabriquerait un lien cassé ;
 *  - une URL que Meta refuserait : pas de ligne en base pour un template qui n'existera jamais ;
 *  - une URL qui est déjà l'un de NOS liens (`codeDuLienTrace`), réaffichée faute de ré-habillage : la retracer à la
 *    même position donnerait au code sa propre adresse pour destination, une redirection qui boucle.
 */
export function boutonsTracables(input: CreateTemplateInput): CibleBouton[] {
  const out: CibleBouton[] = [];
  const scan = (boutons: readonly TemplateButton[] | undefined, cardIndex: number | null): void => {
    (boutons ?? []).forEach((b, i) => {
      if (b.type !== 'URL') return;
      const url = (b.url ?? '').trim();
      if (url === '' || url.includes('{{')) return;
      if (!isSendableButtonUrl(url)) return;
      if (codeDuLienTrace(url) !== null) return;
      out.push({ cardIndex, buttonIndex: i, url });
    });
  };
  scan(input.buttons, null);
  (input.carousel?.cards ?? []).forEach((carte, ci) => scan(carte.buttons, ci));
  return out;
}

/**
 * Rend une copie du template dont les boutons listés dans `liens` portent l'adresse de redirection. Une copie
 * et non une mutation : l'appelant garde l'original pour le soumettre non tracé si l'allocation échoue.
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
 * L'inverse, pour l'affichage : remontrer le lien saisi là où Meta rend le nôtre (`…/r/ab12cd34ef56`).
 * Appariement sur l'URL de redirection, pas sur la position : un template édité hors console peut avoir vu ses
 * boutons réordonnés.
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
