/**
 * LES PIÈCES JOINTES REÇUES, côté écran (2026-09-19) : ce qu'on affiche, ce qu'on télécharge, et sous quel nom.
 *
 * Module PUR : aucune IO, aucune dépendance React/navigateur, aucun alias `@/` -> testable depuis la suite
 * racine (`tests/web-piece-jointe.test.ts`), comme `inbox-rangement.ts`.
 */

/**
 * Le délai de WhatsApp sur un média reçu, tel que l'ÉCRAN l'annonce.
 *
 * ⚠️ UNE COPIE, ET ELLE EST GARDÉE : la valeur qui décide vit côté serveur (`DUREE_MEDIA_RECU_JOURS`,
 * `src/inbox/media-entrant.ts`), et le test racine exige que les deux soient égales. Sans lui, le serveur
 * pourrait passer à dix jours pendant que l'écran continuerait d'en annoncer sept.
 */
export const DUREE_MEDIA_RECU_JOURS_AFFICHEE = 7;

/** Ce que la bulle fait d'une pièce jointe : la montrer, ou proposer de la télécharger. */
export type NaturePieceJointe = 'image' | 'document' | 'video';

/**
 * La nature d'une pièce jointe d'après le TYPE du message WhatsApp. `null` = pas une pièce jointe que cette
 * bulle sait traiter (le vocal a son propre composant, le texte n'en est pas une).
 *
 * ⚠️ Le sticker est une image : WhatsApp l'envoie en `image/webp`, et le montrer comme un fichier à
 * télécharger serait absurde.
 */
export function natureDePieceJointe(type: string | null | undefined): NaturePieceJointe | null {
  if (type === 'image' || type === 'sticker') return 'image';
  if (type === 'document') return 'document';
  if (type === 'video') return 'video';
  return null;
}

/**
 * Les SEULS types que l'écran accepte de rendre dans une balise `<img>`.
 *
 * 🔴 MÊME FRONTIÈRE QUE LE SERVEUR (`MIMES_AFFICHABLES`), tenue à l'écran pour la même raison : un fichier
 * reçu porte le type que son EXPÉDITEUR annonce. Le SVG n'y est pas, parce qu'il peut porter du script.
 * Tout le reste, même annoncé comme photo, devient un téléchargement.
 */
export const TYPES_IMAGE_AFFICHABLES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/** Ce blob peut-il être montré dans une `<img>` ? On lit son type, sans ses paramètres. */
export function imageAffichable(typeDuBlob: string | null | undefined): boolean {
  const t = (typeDuBlob ?? '').split(';')[0]!.trim().toLowerCase();
  return TYPES_IMAGE_AFFICHABLES.has(t);
}

/**
 * La LÉGENDE à afficher sous la pièce jointe, ou `null`.
 *
 * Le serveur range dans `body` la légende de l'expéditeur, SINON un libellé de type (`[image]`,
 * `[document]`). Ce libellé servait à l'aperçu de la liste ; sous une photo affichée, il ne dirait rien
 * qu'on ne voie déjà.
 */
export function legendeDePieceJointe(texte: string | null | undefined, type: string | null | undefined): string | null {
  const t = (texte ?? '').trim();
  if (t === '' || t === `[${type ?? ''}]`) return null;
  return t;
}

/**
 * Le nom sous lequel le fichier s'enregistre. Celui que WhatsApp annonce pour un document ; sinon un nom
 * neutre avec l'extension déduite du type, pour qu'une vidéo s'ouvre avec le bon lecteur.
 */
export function nomDeTelechargement(nom: string | null | undefined, nature: NaturePieceJointe, idMessage: string): string {
  const propre = (nom ?? '').trim();
  if (propre !== '') return propre;
  const extension = nature === 'video' ? '.mp4' : nature === 'image' ? '.jpg' : '';
  return `piece-jointe-${idMessage.slice(0, 8)}${extension}`;
}
