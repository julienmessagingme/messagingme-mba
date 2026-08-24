/**
 * Reconnaissance d'une image à partir de ses OCTETS, pour le visuel d'un message RCS.
 *
 * Module PUR. Il existe parce que ces fichiers finissent servis sur une URL PUBLIQUE, que n'importe qui peut
 * ouvrir dans un navigateur : le type déclaré par le téléversement ne prouve rien, et servir un fichier
 * pour ce qu'il prétend être est la façon classique de transformer un hébergeur d'images en hébergeur de
 * pages. On lit donc la signature réelle du fichier, et c'est ELLE qui décide du `Content-Type` rendu.
 *
 * Trois formats seulement, ceux que l'opérateur accepte pour l'image d'une carte (spec smsmode : extension
 * `jpeg`, `jpg`, `gif` ou `png`). Pas de SVG : c'est du XML exécutable, donc une surface de script, et le
 * provider n'en veut pas non plus.
 */

export type MimeImage = 'image/jpeg' | 'image/png' | 'image/gif';

/**
 * Plafond de poids. C'EST NOTRE limite, pas celle du fournisseur : un visuel de message doit s'afficher sur
 * un téléphone en réseau mobile, et les octets vivent dans notre base. 2 Mo laisse largement la place à une
 * image de campagne bien exportée, et refuse une photo brute d'appareil sans la redimensionner en douce.
 */
export const TAILLE_IMAGE_MAX = 2 * 1024 * 1024;

const SIGNATURES: ReadonlyArray<{ mime: MimeImage; octets: readonly number[] }> = [
  { mime: 'image/jpeg', octets: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', octets: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/gif', octets: [0x47, 0x49, 0x46, 0x38] }, // « GIF8 », couvre 87a et 89a
];

/** Type RÉEL du fichier d'après sa signature, ou null si ce n'est pas une image acceptée. */
export function typeImage(bytes: Buffer): MimeImage | null {
  for (const { mime, octets } of SIGNATURES) {
    if (bytes.length >= octets.length && octets.every((o, i) => bytes[i] === o)) return mime;
  }
  return null;
}

/**
 * Extension à mettre dans l'URL publique.
 *
 * 🔴 Ce n'est PAS cosmétique. Le fournisseur exige une adresse qui se TERMINE par `.jpg`, `.jpeg`, `.png` ou
 * `.gif` ; une URL sans extension est refusée à l'envoi, quelle qu'en soit l'en-tête de réponse.
 */
export function extensionDe(mime: MimeImage): 'jpg' | 'png' | 'gif' {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/png') return 'png';
  return 'gif';
}

/** Le MIME correspondant à une extension d'URL, ou null. Sert à refuser une extension qui ne colle pas au
 *  fichier stocké plutôt qu'à servir un PNG sous une adresse en `.jpg`. */
export function mimeDeExtension(ext: string): MimeImage | null {
  const e = ext.toLowerCase();
  if (e === 'jpg' || e === 'jpeg') return 'image/jpeg';
  if (e === 'png') return 'image/png';
  if (e === 'gif') return 'image/gif';
  return null;
}

/** Data URL `data:<mime>;base64,<...>` -> octets, ou null si la forme n'est pas celle attendue. Ne lève
 *  jamais : le corps vient d'un navigateur, donc d'un client qu'on ne contrôle pas. */
export function octetsDepuisDataUrl(dataUrl: string): Buffer | null {
  const m = /^data:[a-z]+\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl.trim());
  if (!m) return null;
  try {
    const bytes = Buffer.from(m[1]!, 'base64');
    return bytes.length > 0 ? bytes : null;
  } catch {
    return null;
  }
}

/** URL publique d'un visuel. L'extension est portée par le CHEMIN, pas par une requête : c'est ce que le
 *  fournisseur regarde. */
export function urlImageRcs(appUrl: string, code: string, mime: MimeImage): string {
  return `${appUrl.replace(/\/+$/, '')}/m/${code}.${extensionDe(mime)}`;
}
