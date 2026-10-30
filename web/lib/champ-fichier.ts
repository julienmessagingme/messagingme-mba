/**
 * LES RÈGLES DU CHAMP DE DÉPÔT DE LA MÉDIATHÈQUE (`ChampImageHebergee`), selon ce qu'il accepte (spec
 * `docs/superpowers/specs/2026-10-14-medias-message-rapide-design.md`, § 3.6). `image` : les trois images de l'opérateur
 * RCS, le défaut de tous les écrans. `image-video-pdf` : le bloc « message rapide », qui part en WhatsApp, donc sans GIF.
 * `tout` : le bouton « Ajouter » de la page Médiathèque (2026-10-30), qui dépose pour tous les écrans à la fois, donc les
 * cinq types que la route accepte (`src/http/rcs-media.ts`), à ses plafonds.
 * Le serveur relit la SIGNATURE de chaque fichier : ces règles évitent seulement d'envoyer pour rien.
 */
export type Accepte = 'image' | 'image-video-pdf' | 'tout';

const MO = 1024 * 1024;
const PLAFONDS: Record<Accepte, Record<string, number>> = {
  image: { 'image/jpeg': 2 * MO, 'image/png': 2 * MO, 'image/gif': 2 * MO },
  'image-video-pdf': { 'image/jpeg': 2 * MO, 'image/png': 2 * MO, 'video/mp4': 16 * MO, 'application/pdf': 16 * MO },
  tout: { 'image/jpeg': 2 * MO, 'image/png': 2 * MO, 'image/gif': 2 * MO, 'video/mp4': 16 * MO, 'application/pdf': 16 * MO },
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
  tout: /\.(jpe?g|png|gif|mp4|pdf)(\?.*)?$/i,
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

type Traduire = (fr: string, en?: string) => string;

/**
 * Ce qui refuse ce fichier AVANT l'envoi (type, poids), dit à l'écran, ou `null`. Le champ d'image et le bouton « Ajouter »
 * de la Médiathèque le lisent tous les deux : deux copies de la règle finiraient par dire deux choses du même fichier.
 * Lu avant la lecture du fichier : inutile d'encoder 16 Mo en base64 pour se les faire refuser ensuite.
 */
export function refusAvantEnvoi(fichier: { type: string; size: number }, accepte: Accepte, t: Traduire): string | null {
  const plafond = plafondPour(fichier.type, accepte);
  if (plafond === 0 && accepte !== 'image' && estMov(fichier.type)) {
    return t(
      'Cette vidéo est au format MOV (celui de l’iPhone), que WhatsApp n’accepte pas. Convertissez-la en MP4 H.264 (profil Main) avec votre logiciel de montage ou un convertisseur, puis déposez le fichier .mp4.',
      'This video is in MOV format (the iPhone one), which WhatsApp does not accept. Convert it to H.264 MP4 (Main profile) with your editing software or a converter, then upload the .mp4 file.',
    );
  }
  if (plafond === 0) {
    if (accepte === 'image') return t('Format non accepté : JPEG, PNG ou GIF.', 'Format not accepted: JPEG, PNG or GIF.');
    if (accepte === 'tout') return t('Format non accepté : image JPEG, PNG ou GIF, vidéo MP4 ou PDF.', 'Format not accepted: JPEG, PNG or GIF image, MP4 video or PDF.');
    return t('Format non accepté : image JPEG ou PNG, vidéo MP4 ou PDF.', 'Format not accepted: JPEG or PNG image, MP4 video or PDF.');
  }
  if (fichier.size > plafond) {
    const mo = Math.round(plafond / MO);
    return t(`Fichier trop lourd : ${mo} Mo maximum.`, `File too large: ${mo} MB maximum.`);
  }
  return null;
}

/**
 * Un fichier DÉJÀ dans la médiathèque peut-il servir à ce champ ? Son type réel (relu par le serveur au dépôt) et son poids
 * sous le plafond du champ : un GIF ne se propose pas au bloc « message rapide », que WhatsApp refuserait.
 */
export function fichierAccepte(f: { mime: string; taille: number }, accepte: Accepte): boolean {
  const plafond = plafondPour(f.mime, accepte);
  return plafond > 0 && f.taille <= plafond;
}
