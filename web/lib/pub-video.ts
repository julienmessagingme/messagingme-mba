/**
 * LA VIDÉO D'UNE PUBLICITÉ, VUE DE L'ÉCRAN : ce qu'on refuse AVANT d'envoyer quoi que ce soit, et le conseil de
 * cadrage. Fonctions pures, sans DOM : la lecture de la durée (un `<video>`) vit dans le formulaire, qui passe ici
 * ce qu'elle a lu.
 *
 * 🔴 LES BORNES DOIVENT ÉGALER CELLES DU SERVEUR (`src/pubs/video.ts`), et c'est un test de parité qui le tient
 * (`tests/web-pubs-parity.test.ts`). L'écran refuse avant d'envoyer cent mégaoctets pour rien ; le serveur refuse
 * en dernier ressort, et lui seul protège.
 */

/** 100 Mo : décision de Julien du 2026-09-28. */
export const TAILLE_VIDEO_MAX = 100 * 1024 * 1024;

/** 60 secondes : même décision. */
export const DUREE_VIDEO_MAX_S = 60;

export const TYPES_VIDEO = ['video/mp4', 'video/quicktime'] as const;
export type TypeVideo = (typeof TYPES_VIDEO)[number];

/** Pourquoi une vidéo est refusée avant l'envoi. `null` = elle peut partir. */
export type RefusVideo = 'type' | 'taille' | 'duree' | 'duree_illisible' | null;

/**
 * Le type d'une vidéo choisie, lu sur ce que le navigateur annonce, et à défaut sur l'extension : certains
 * systèmes n'annoncent aucun type pour un `.mov`. Ce n'est pas une garde (le serveur lit la signature des
 * octets), c'est ce qui évite d'envoyer cent mégaoctets d'autre chose.
 */
export function typeVideoDe(f: { type: string; name: string }): TypeVideo | null {
  if ((TYPES_VIDEO as readonly string[]).includes(f.type)) return f.type as TypeVideo;
  if (f.type !== '') return null;
  const ext = f.name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'mp4' || ext === 'm4v') return 'video/mp4';
  if (ext === 'mov') return 'video/quicktime';
  return null;
}

/**
 * La durée dépasse-t-elle la borne ? ARRONDIE à la seconde, comme au serveur (`dureeTropLongue`) : un téléphone
 * qui filme « 60 secondes » produit souvent 60,03 s, et le refuser serait refuser la vidéo que la règle autorise.
 */
export function dureeTropLongue(secondes: number): boolean {
  return Math.round(secondes) > DUREE_VIDEO_MAX_S;
}

/**
 * Ce qu'on refuse avant d'envoyer. L'ordre compte : le type d'abord (un fichier qui n'est pas une vidéo n'a pas de
 * durée), puis la taille (connue sans rien lire), puis la durée.
 *
 * 🔴 UNE DURÉE ILLISIBLE EST UN REFUS, PAS UN FEU VERT. La règle des 60 secondes n'a qu'un contrôle sûr, celui-ci :
 * le serveur ne lit la durée que si le fichier la porte au début, et Meta, lui, accepte bien plus long. Laisser
 * passer une vidéo dont le navigateur ne sait pas lire la durée, ce serait laisser passer la vidéo de trois minutes
 * que la règle interdit. L'écran conseille alors d'exporter en MP4 (H.264), que tout navigateur lit.
 */
export function refusVideo(f: { type: string; name: string; size: number }, duree: number | null): RefusVideo {
  if (typeVideoDe(f) === null) return 'type';
  if (f.size > TAILLE_VIDEO_MAX) return 'taille';
  if (duree === null || !Number.isFinite(duree) || duree <= 0) return 'duree_illisible';
  if (dureeTropLongue(duree)) return 'duree';
  return null;
}

/**
 * Le cadrage d'une vidéo, pour le conseil (jamais un refus : Meta place la publicité lui-même). Vertical 9:16 pour
 * les stories, les Reels et le statut WhatsApp ; 4:5 pour le fil. Une tolérance de 3 % absorbe les dimensions
 * impaires qu'imposent les encodeurs (1080 x 1918, par exemple).
 */
export function cadrageDe(largeur: number, hauteur: number): 'vertical' | 'fil' | 'autre' | null {
  if (!(largeur > 0) || !(hauteur > 0)) return null;
  const r = largeur / hauteur;
  const proche = (cible: number): boolean => Math.abs(r - cible) / cible <= 0.03;
  if (proche(9 / 16)) return 'vertical';
  if (proche(4 / 5)) return 'fil';
  return 'autre';
}

/**
 * Ce que Meta demande ensuite : le morceau de `debut` inclus à `fin` exclu, `'fini'` quand les deux décalages sont
 * égaux (tout est reçu, c'est son signal documenté), ou `null` quand la demande est impossible (au-delà du fichier)
 * ou n'AVANCE plus (un début qui ne dépasse pas le précédent) : boucler là-dessus renverrait indéfiniment le même
 * morceau, sur le plafond de requêtes de la personne.
 */
export function morceauSuivant(
  precedent: { debut: number; fin: number } | null,
  suivant: { debut: number; fin: number },
  taille: number,
): { debut: number; fin: number } | 'fini' | null {
  // Une réponse sans décalages entiers n'est pas une réponse : sans cette ligne, deux `undefined` égaux
  // passeraient pour « tout est reçu », et l'écran clorait un dépôt incomplet.
  if (!Number.isInteger(suivant.debut) || !Number.isInteger(suivant.fin)) return null;
  if (suivant.debut === suivant.fin) return 'fini';
  if (suivant.debut < 0 || suivant.fin > taille || suivant.fin < suivant.debut) return null;
  if (precedent !== null && suivant.debut <= precedent.debut) return null;
  return suivant;
}
