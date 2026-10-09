/**
 * LA VIDÉO D'UNE PUBLICITÉ, VUE DE L'ÉCRAN : ce qu'on refuse AVANT d'envoyer quoi que ce soit, et le conseil de
 * cadrage. Fonctions pures, sans DOM : la durée se lit dans le fichier (`dureeDuFichier`, qui reçoit de quoi en lire
 * des morceaux), et le décodeur du navigateur (un `<video>`, dans le formulaire) n'est plus que son repli.
 *
 * 🔴 LES BORNES SONT CELLES DU SERVEUR, partagées (`./partage/pub-video`). L'écran refuse avant d'envoyer cent
 * mégaoctets pour rien ; le serveur refuse en dernier ressort, et lui seul protège.
 */

import {
  TAILLE_VIDEO_PUB_MAX as TAILLE_VIDEO_MAX, DUREE_VIDEO_PUB_MAX_S as DUREE_VIDEO_MAX_S, TYPES_VIDEO_PUB as TYPES_VIDEO,
  dureeTropLongue, dureeDeLaTete, nomDe, u32, u64,
} from './partage/pub-video';

/** Partagés avec le serveur (`./partage/pub-video`), sous leurs noms d'écran. */
export { TAILLE_VIDEO_MAX, DUREE_VIDEO_MAX_S, TYPES_VIDEO, dureeTropLongue, dureeDeLaTete };
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

/* ── La durée lue dans le fichier, sans le décoder ───────────────────────────────────────────────── */

/**
 * 🔴 POURQUOI L'ÉCRAN LIT LA DURÉE DANS LE FICHIER, ET PAS PAR LE DÉCODEUR DU NAVIGATEUR. Un MOV d'iPhone en HEVC
 * est parfaitement conforme, mais Chrome sous Windows ne sait pas le décoder : un `<video>` n'en donnait aucune
 * durée, et `refusVideo` refusait donc la vidéo (« durée illisible ») alors que la règle des 60 secondes pouvait être
 * tenue. La durée vit dans la boîte `mvhd` du conteneur, lisible sans décoder une seule image. Le décodeur reste le
 * repli quand `mvhd` est illisible.
 *
 * Le parseur (`dureeDeLaTete`) est celui du serveur, partagé (`./partage/pub-video`).
 */

/**
 * La durée retenue pour le contrôle : celle du conteneur (`mvhd`) quand elle est une vraie durée, sinon celle du
 * décodeur.
 *
 * 🔴 UN `mvhd` À ZÉRO N'EST PAS UNE DURÉE. Un MP4 FRAGMENTÉ (MediaRecorder de Chrome, OBS) porte `duration = 0` dans
 * `mvhd` : sa durée vit dans les fragments. `0 ?? décodeur` valait 0, et `refusVideo` refusait la vidéo pour « durée
 * illisible » alors que le navigateur, lui, savait la lire. Seule une durée finie et positive l'emporte.
 */
export function dureeRetenue(conteneur: number | null, decodeur: number | null): number | null {
  return conteneur !== null && Number.isFinite(conteneur) && conteneur > 0 ? conteneur : decodeur;
}

/**
 * Combien d'octets on lit au début de `moov` : son en-tête (16 au plus) et un `mvhd` de version 1 jusqu'à sa durée
 * (40). Large, pour ne pas dépendre de ces comptes au plus juste.
 */
const TETE_MOOV_OCTETS = 512;

/** Combien de boîtes de premier niveau on traverse au plus : un fichier réel en a moins de dix. */
const BOITES_MAX = 64;

/**
 * La durée d'un fichier, où que soit `moov` : au début (« fast start »), ou à la FIN, derrière `mdat`, le cas des
 * fichiers qui sortent d'un téléphone sans réexport. On saute de boîte en boîte en ne lisant que leurs EN-TÊTES
 * (seize octets chacun), jamais les mégaoctets de `mdat`, puis on lit la tête de `moov` et on la confie à
 * `dureeDeLaTete`, le parseur du serveur. `null` quand le fichier ne la porte pas lisiblement : l'appelant retombe
 * alors sur le décodeur du navigateur.
 *
 * `lire(debut, fin)` rend les octets du fichier de `debut` inclus à `fin` exclu (`File.slice` dans la console).
 */
export async function dureeDuFichier(
  lire: (debut: number, fin: number) => Promise<Uint8Array>,
  taille: number,
): Promise<number | null> {
  let i = 0;
  for (let n = 0; n < BOITES_MAX && i + 8 <= taille; n += 1) {
    const entete = await lire(i, Math.min(i + 16, taille));
    if (entete.length < 8) return null;
    let tailleBoite = u32(entete, 0);
    let longueurEntete = 8;
    if (tailleBoite === 1) {
      if (entete.length < 16) return null;
      tailleBoite = u64(entete, 8);
      longueurEntete = 16;
    }
    // `0` : la boîte court jusqu'à la fin du fichier.
    if (tailleBoite === 0) tailleBoite = taille - i;
    if (nomDe(entete, 4) === 'moov') return dureeDeLaTete(await lire(i, Math.min(i + TETE_MOOV_OCTETS, taille)));
    if (tailleBoite < longueurEntete) return null; // boîte incohérente : on ne devine pas
    i += tailleBoite;
  }
  return null;
}
