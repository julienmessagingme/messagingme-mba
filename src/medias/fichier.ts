import { typeImage, type MimeImage } from '../rcs/image';

/**
 * RECONNAÎTRE UN FICHIER DE LA MÉDIATHÈQUE À SES OCTETS (spec `docs/superpowers/specs/2026-10-14-medias-message-rapide-design.md`,
 * § 3.1). 🔴 Le type annoncé par le navigateur ne compte jamais : la signature tranche, comme pour les images
 * (`src/rcs/image.ts`). Une vidéo MP4 et un PDF s'ajoutent aux trois images, et rien d'autre (ni 3GP, ni Office).
 */
export type MimeFichier = MimeImage | 'video/mp4' | 'application/pdf';

const ascii = (b: Buffer, debut: number, fin: number): string => b.toString('latin1', debut, fin);

/**
 * 16 Mo pour une vidéo ou un PDF : le plafond vidéo de Meta, la même valeur que l'en-tête vidéo des templates
 * (`src/http/media.ts`). Un PDF de 100 Mo, que Meta accepterait, est pénible sur un téléphone et transite en mémoire.
 */
export const TAILLE_VIDEO_PDF_MAX = 16 * 1024 * 1024;

/** L'extension d'un type : celle de l'adresse `/m/` et celle de la clé d'objet au bucket. */
export const EXTENSION: Record<MimeFichier, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'video/mp4': 'mp4', 'application/pdf': 'pdf',
};

/** L'adresse d'un fichier de la médiathèque : l'extension, celle du type RÉEL, est portée par le chemin. */
export function urlFichier(racine: string, code: string, mime: MimeFichier): string {
  return `${racine.replace(/\/+$/, '')}/m/${code}.${EXTENSION[mime]}`;
}

/**
 * Le nom d'origine d'un fichier, tel qu'il sera gardé (médiathèque) puis montré au contact (le nom d'un PDF) : sans chemin
 * Windows ni Unix, sans caractère de contrôle, borné à 120 caractères. null si rien ne reste. Le nom vient d'un navigateur.
 */
export function nomDeFichier(brut: unknown): string | null {
  if (typeof brut !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const sansControle = brut.replace(/[\u0000-\u001f\u007f]/g, '');
  const base = sansControle.split(/[\\/]/).pop() ?? '';
  // Borné en CARACTÈRES (points de code), jamais en unités UTF-16 : couper un émoji en deux laisserait une moitié que la
  // base écrit en « � », sous les yeux du contact.
  const n = Array.from(base.trim()).slice(0, 120).join('');
  return n === '' ? null : n;
}

/**
 * La marche à suivre d'une vidéo refusée. 🔴 Elle mène au MP4, jamais à un réglage de l'iPhone : « Le plus compatible »
 * filme en H.264 mais dans un MOV, que WhatsApp n'accepte pas non plus (relecture du lot C, n° 3).
 */
const CONVERTIR_EN_MP4 = 'Convertissez-la en MP4 H.264 (profil Main) avec votre logiciel de montage ou un convertisseur, puis déposez le fichier .mp4.';

/** Le refus d'une vidéo MOV (QuickTime), le format des vidéos d'iPhone, quel que soit son encodage. */
export const REFUS_MOV = `Cette vidéo est au format MOV (celui de l’iPhone), que WhatsApp n’accepte pas. ${CONVERTIR_EN_MP4}`;

/** Un fichier QuickTime (MOV), reconnu à sa marque : il n'est pas accepté, mais son refus doit le NOMMER. */
export function estQuickTime(octets: Buffer): boolean {
  return octets.length >= 12 && ascii(octets, 4, 8) === 'ftyp' && ascii(octets, 8, 12) === 'qt  ';
}

/** Le type réel du fichier, ou null s'il n'est pas l'un de ceux que la médiathèque accepte. */
export function typeFichier(octets: Buffer): MimeFichier | null {
  const image = typeImage(octets);
  if (image) return image;
  if (octets.length >= 12 && ascii(octets, 4, 8) === 'ftyp') {
    const marque = ascii(octets, 8, 12);
    // Un MOV (QuickTime) renommé en .mp4, ou un 3GP : Meta ne les livre pas comme un MP4.
    if (marque === 'qt  ' || marque.startsWith('3g')) return null;
    return 'video/mp4';
  }
  if (octets.length >= 5 && ascii(octets, 0, 5) === '%PDF-') return 'application/pdf';
  return null;
}

/**
 * Le genre d'un fichier d'après l'extension de son adresse (`/m/<code>.<ext>`) : le champ `imageUrl` d'un bloc porte aussi
 * une vidéo ou un PDF, et seule l'extension le dit sans lire la base (spec médias, § 3.3). null = extension inconnue,
 * traitée comme avant (une image).
 */
export function genreParAdresse(url: string): 'image' | 'video' | 'document' | null {
  let chemin: string;
  try {
    chemin = new URL(url).pathname;
  } catch {
    return null;
  }
  const ext = /\.([a-z0-9]+)$/i.exec(chemin)?.[1]?.toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg' || ext === 'png' || ext === 'gif') return 'image';
  if (ext === 'mp4') return 'video';
  if (ext === 'pdf') return 'document';
  return null;
}

interface Boite {
  type: string;
  /** Début du contenu, après l'en-tête. */
  debut: number;
  fin: number;
}

/** Les boîtes MP4 d'une plage, ou null dès qu'une taille sort de la plage : un fichier abîmé n'est jamais lu de travers. */
function boites(b: Buffer, debut: number, fin: number, tolerant = false): Boite[] | null {
  // `tolerant` (premier niveau seulement) : une traîne qui ne forme pas une boîte, ajoutée par certains téléphones après
  // la dernière, arrête la lecture sans la rendre illisible. Les boîtes déjà lues restent.
  const casse = (liste: Boite[]): Boite[] | null => (tolerant ? liste : null);
  const liste: Boite[] = [];
  let p = debut;
  while (p + 8 <= fin) {
    let taille = b.readUInt32BE(p);
    let entete = 8;
    if (taille === 1) {
      if (p + 16 > fin) return casse(liste);
      const grande = b.readBigUInt64BE(p + 8);
      if (grande > BigInt(fin - p)) return casse(liste);
      taille = Number(grande);
      entete = 16;
    } else if (taille === 0) {
      taille = fin - p;
    }
    if (taille < entete || p + taille > fin) return casse(liste);
    liste.push({ type: ascii(b, p + 4, p + 8), debut: p + entete, fin: p + taille });
    p += taille;
  }
  return liste;
}

const fille = (b: Buffer, parent: Boite | undefined, type: string): Boite | undefined =>
  parent ? boites(b, parent.debut, parent.fin)?.find((x) => x.type === type) : undefined;

interface Piste {
  genre: string;
  codec: string;
  /** `AVCProfileIndication` de la boîte `avcC` (100 et plus = High), si la piste en porte une. */
  profil: number | null;
  imagesB: boolean;
}

function lirePiste(b: Buffer, trak: Boite): Piste | null {
  const mdia = fille(b, trak, 'mdia');
  const hdlr = fille(b, mdia, 'hdlr');
  const stbl = fille(b, fille(b, mdia, 'minf'), 'stbl');
  const stsd = fille(b, stbl, 'stsd');
  // hdlr : version et drapeaux (4), pre_defined (4), puis le genre de la piste. stsd : version et drapeaux (4), nombre
  // d'entrées (4), puis la première entrée, une boîte dont le type EST le codec.
  if (!hdlr || !stbl || !stsd || hdlr.fin - hdlr.debut < 12) return null;
  const entree = boites(b, stsd.debut + 8, stsd.fin)?.[0];
  if (!entree) return null;
  let profil: number | null = null;
  // Une entrée visuelle porte 78 octets de champs fixes avant ses boîtes filles, dont `avcC`.
  if (entree.fin - entree.debut > 78) {
    const avcC = boites(b, entree.debut + 78, entree.fin)?.find((x) => x.type === 'avcC');
    if (avcC && avcC.fin - avcC.debut >= 2) profil = b[avcC.debut + 1]!;
  }
  return {
    genre: ascii(b, hdlr.debut + 8, hdlr.debut + 12),
    codec: entree.type,
    profil,
    imagesB: (boites(b, stbl.debut, stbl.fin) ?? []).some((x) => x.type === 'ctts'),
  };
}

/**
 * Ce que WhatsApp livre, et ce qu'Android lit : null si la vidéo passe, sinon la raison du refus, qui dit quoi faire.
 * Meta : « Only H.264 video codec and AAC audio codec supported. Single audio stream or no audio stream only », et
 * « videos encoded with the H.264 "High" profile and B-frames are not supported by Android WhatsApp clients ». Sans ce
 * contrôle, Meta accepte le téléversement et le message ne se livre pas, ou ne se lit pas. Ne lève jamais.
 */
export function verifierVideo(octets: Buffer): string | null {
  const illisible = 'Fichier vidéo illisible : réexportez-le en MP4 (H.264, son AAC).';
  const moov = boites(octets, 0, octets.length, true)?.find((x) => x.type === 'moov');
  if (!moov) return illisible;
  const dansMoov = boites(octets, moov.debut, moov.fin);
  const traks = dansMoov?.filter((x) => x.type === 'trak');
  // Un MP4 FRAGMENTÉ (`mvex`) porte ses décalages de composition dans les fragments, pas dans `ctts` : ses images B ne
  // se voient pas ici, donc son profil High est refusé par prudence (relecture du lot C, n° 4).
  const fragmente = (dansMoov ?? []).some((x) => x.type === 'mvex');
  if (!traks) return illisible;
  const pistes: Piste[] = [];
  for (const t of traks) {
    const p = lirePiste(octets, t);
    if (p) pistes.push(p);
  }
  const videos = pistes.filter((p) => p.genre === 'vide');
  const sons = pistes.filter((p) => p.genre === 'soun');
  if (videos.length === 0) return 'Ce fichier ne contient pas de piste vidéo lisible.';
  for (const v of videos) {
    if (v.codec === 'hvc1' || v.codec === 'hev1') {
      return `Cette vidéo est encodée en HEVC (H.265), que WhatsApp ne livre pas. ${CONVERTIR_EN_MP4}`;
    }
    if (v.codec !== 'avc1' && v.codec !== 'avc3') {
      return `Cette vidéo est encodée en « ${v.codec.trim()} », que WhatsApp ne livre pas. Exportez-la en MP4 H.264.`;
    }
    if (v.profil !== null && v.profil >= 100 && (v.imagesB || fragmente)) {
      return 'Cette vidéo est en H.264 profil High avec images B, que WhatsApp ne lit pas sur Android. Exportez-la en profil Main ou Baseline.';
    }
  }
  if (sons.length > 1) return 'Cette vidéo porte plusieurs pistes son : WhatsApp n’en accepte qu’une. Exportez-la avec une seule piste son.';
  if (sons.length === 1 && sons[0]!.codec !== 'mp4a') return 'Le son de cette vidéo n’est pas en AAC : WhatsApp la refuse. Exportez-la avec un son AAC.';
  return null;
}
