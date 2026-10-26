/**
 * La géométrie du nuage « satisfaction x urgence », séparée du composant pour être testable.
 *
 * Ce qui vit ici n'est pas du dessin, c'est la LECTURE du graphe : où tombe une note sur son axe, quelle
 * taille donne un paquet de conversations, et quel coin alarme. Trois règles qu'on peut se tromper en
 * écrivant sans que rien ne le signale, parce qu'un nuage faux ressemble à un nuage.
 */

// L'échelle des notes est celle du serveur, lue au même endroit (`web/lib/partage/analyse.ts`) : si elle passe un jour
// à 0-100, l'axe suit, au lieu de rester gradué à 10 avec tous les points écrasés contre son bord droit.
import { NOTE_MAX, NOTE_MIN } from './partage/analyse';

/** Position d'une note sur son axe, en pourcentage de la largeur utile (0 % = borne basse). */
export function positionPct(note: number): number {
  const borne = Math.min(Math.max(note, NOTE_MIN), NOTE_MAX);
  return ((borne - NOTE_MIN) / (NOTE_MAX - NOTE_MIN)) * 100;
}

/**
 * Rayon d'une case du damier, en unités du viewBox.
 *
 * La surface croît comme le NOMBRE de conversations (rayon en racine carrée), pas le rayon : à surface
 * proportionnelle, l'œil compare des quantités ; à rayon proportionnel, une case de 100 paraîtrait dix
 * fois plus grosse qu'elle ne l'est. Le rayon minimum garantit qu'une case à 1 reste cliquable et visible.
 */
export const RAYON_MIN = 3.2;
export const RAYON_MAX = 11;
export function rayonPoint(n: number, nMax: number): number {
  if (n <= 0) return 0;
  if (nMax <= 1) return RAYON_MIN;
  return RAYON_MIN + (RAYON_MAX - RAYON_MIN) * Math.sqrt((n - 1) / (nMax - 1));
}

/**
 * Le coin qui alarme : client sous la moitié de l'échelle en satisfaction ET au-dessus en urgence.
 *
 * ⚠️ Le seuil est la MOITIÉ de l'échelle et rien d'autre, pour que la règle s'explique en une phrase à
 * qui lit le graphe. Ce n'est pas un score de risque : le nuage montre, il ne classe pas.
 */
export const MILIEU_ECHELLE = (NOTE_MIN + NOTE_MAX) / 2;
export function estAlerte(satisfaction: number, urgence: number): boolean {
  return satisfaction < MILIEU_ECHELLE && urgence > MILIEU_ECHELLE;
}
