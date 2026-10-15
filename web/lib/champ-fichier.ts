/**
 * LES RÈGLES DU CHAMP DE DÉPÔT DE LA MÉDIATHÈQUE (`ChampImageHebergee`), selon ce qu'il accepte (spec
 * `docs/superpowers/specs/2026-10-14-medias-message-rapide-design.md`, § 3.6). `image` : les trois images de l'opérateur
 * RCS, le défaut de tous les écrans. `image-video-pdf` : le bloc « message rapide », qui part en WhatsApp, donc sans GIF.
 * Le serveur relit la SIGNATURE de chaque fichier : ces règles évitent seulement d'envoyer pour rien.
 */
export type Accepte = 'image' | 'image-video-pdf';

const MO = 1024 * 1024;
const PLAFONDS: Record<Accepte, Record<string, number>> = {
  image: { 'image/jpeg': 2 * MO, 'image/png': 2 * MO, 'image/gif': 2 * MO },
  'image-video-pdf': { 'image/jpeg': 2 * MO, 'image/png': 2 * MO, 'video/mp4': 16 * MO, 'application/pdf': 16 * MO },
};

/** La valeur de l'attribut `accept` du sélecteur de fichier. */
export function typesAcceptes(accepte: Accepte): string {
  return Object.keys(PLAFONDS[accepte]).join(',');
}

/** Une vidéo d'iPhone (QuickTime, `.MOV`) : refusée, mais avec la marche à suivre plutôt qu'un « format non accepté ». */
export function estMov(type: string): boolean {
  return type === 'video/quicktime';
}

/** Le poids maximal d'un fichier de ce type, en octets ; 0 = type refusé par ce champ. */
export function plafondPour(type: string, accepte: Accepte): number {
  return PLAFONDS[accepte][type] ?? 0;
}

const EXTENSIONS: Record<Accepte, RegExp> = {
  image: /\.(jpe?g|png|gif)(\?.*)?$/i,
  'image-video-pdf': /\.(jpe?g|png|mp4|pdf)(\?.*)?$/i,
};

/** Une adresse saisie dont l'extension n'est pas de celles que ce champ accepte (l'envoi serait refusé). */
export function extensionDouteuse(adresse: string, accepte: Accepte): boolean {
  const a = adresse.trim();
  return a !== '' && !EXTENSIONS[accepte].test(a);
}

/** Le genre d'un fichier d'après son adresse : une vidéo ou un PDF n'ont pas de vignette. Inconnu = image, comme avant. */
export function genreDeLAdresse(adresse: string): 'image' | 'video' | 'document' {
  const ext = /\.([a-z0-9]+)(\?.*)?$/i.exec(adresse.trim())?.[1]?.toLowerCase();
  if (ext === 'mp4') return 'video';
  if (ext === 'pdf') return 'document';
  return 'image';
}
