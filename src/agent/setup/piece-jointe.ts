import { unzipSync } from 'fflate';
import { MAX_CORPS, MAX_FICHES_PAR_PAGE, MAX_TITRE, type FicheExtraite } from '../scrape';

/**
 * Une pièce jointe de la conversation de construction, transformée en texte puis en fiches de connaissance.
 * Module pur : la lecture d'une image par un modèle vision est faite par la route, qui a le client LLM.
 *
 * 🔴 Le type est décidé par la signature du fichier, jamais par ce que le navigateur déclare : ce texte finit
 * dans le prompt d'un agent qui parle à de vrais contacts. Et le texte est découpé, jamais avalé d'un bloc
 * (même raison que `scrape.ts` : un document entier en une fiche rendrait la garde anti-hallucination
 * inopérante).
 */

export type NaturePieceJointe = 'texte' | 'pdf' | 'docx' | 'image';

export interface PieceJointeReconnue {
  nature: NaturePieceJointe;
  /** Le MIME réel, celui de la signature. Pour une image, c'est lui qu'on renvoie au modèle vision. */
  mime: string;
}

/** Plafonds, les nôtres : les octets traversent notre API, l'extraction tourne dans le process, et une
 *  image part chez un fournisseur qui la facture. */
export const TAILLE_DOCUMENT_MAX = 8 * 1024 * 1024;
export const TAILLE_IMAGE_MAX = 5 * 1024 * 1024;

/** Sous ce seuil, un morceau n'a qu'un titre et une bribe : du bruit pour la recherche. Même seuil que le
 *  découpage d'une page web. */
const MIN_CORPS = 40;

/**
 * Une ligne qui se comporte comme un titre : courte, sans ponctuation finale de phrase, et pas une simple
 * énumération. Heuristique assumée : un document mal découpé se corrige à la main dans l'écran.
 */
function ressembleAUnTitre(ligne: string): boolean {
  const l = ligne.trim();
  if (l.length === 0 || l.length > 90) return false;
  if (/[.;:,]$/.test(l)) return false;
  if (/^[-*•\d]/.test(l) && !/^\d+[.)]\s+\S/.test(l)) return false; // puce ou tiret : c'est du contenu
  return true;
}

const SIGNATURES: ReadonlyArray<{ nature: NaturePieceJointe; mime: string; octets: readonly number[] }> = [
  { nature: 'pdf', mime: 'application/pdf', octets: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // « %PDF- »
  { nature: 'image', mime: 'image/jpeg', octets: [0xff, 0xd8, 0xff] },
  { nature: 'image', mime: 'image/png', octets: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { nature: 'image', mime: 'image/gif', octets: [0x47, 0x49, 0x46, 0x38] },
];

/** `PK\x03\x04` : une archive ZIP. Un `.docx` en est une ; on ne le conclut qu'après avoir trouvé son
 *  `word/document.xml`, sans quoi n'importe quel zip passerait pour un document Word. */
const ZIP = [0x50, 0x4b, 0x03, 0x04];

/**
 * 🔴 Ce qu'un `.docx` a le droit de peser une fois décompressé : un ZIP a un taux de compression non borné,
 * et décompresser sans borne laisserait un fichier téléversé arrêter l'API. Le chiffre est celui que
 * l'archive déclare (non prouvé, mais il permet de refuser avant d'allouer) ; une archive qui ment fait
 * échouer `fflate`, et l'exception est attrapée plus bas.
 */
const MAX_DOCX_DECOMPRESSE = 64 * 1024 * 1024;
/** `RIFF????WEBP`. Accepté ici et pas dans `src/rcs/image.ts` : ici la liste est celle qu'un modèle vision
 *  sait lire, et une capture d'écran moderne est souvent en webp. */
const WEBP_RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP_TAG = [0x57, 0x45, 0x42, 0x50];

function commencePar(bytes: Buffer, octets: readonly number[], decalage = 0): boolean {
  return bytes.length >= decalage + octets.length && octets.every((o, i) => bytes[decalage + i] === o);
}

/**
 * Le texte d'un fichier `.docx`, lu dans son `word/document.xml` : décompression (`fflate`) puis contenu des
 * nœuds `<w:t>`, un saut de ligne par paragraphe. Pas de bibliothèque de traitement de texte.
 */
function texteDocx(bytes: Buffer): string | null {
  let fichiers: Record<string, Uint8Array>;
  try {
    fichiers = unzipSync(new Uint8Array(bytes), {
      filter: (f) => f.name === 'word/document.xml' && f.originalSize <= MAX_DOCX_DECOMPRESSE,
    });
  } catch {
    return null; // archive illisible : ce n'est pas un document Word exploitable
  }
  const doc = fichiers['word/document.xml'];
  if (!doc) return null;
  const xml = Buffer.from(doc).toString('utf8');
  return xml
    // Sauts de paragraphe et de ligne deviennent des retours à la ligne : sans eux, le découpage par titre
    // n'aurait rien à voir.
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:br\b[^>]*\/?>/g, '\n')
    .replace(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g, (_b, t: string) => t)
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n[ \n]*/g, '\n')
    .trim();
}

/**
 * La nature réelle du fichier, ou `null` s'il n'est pas d'un type accepté. Le texte brut, sans signature,
 * est reconnu en dernier et seulement en UTF-8 valide sans octet nul : un binaire inconnu ne passe pas pour
 * du texte.
 */
export function reconnaitre(bytes: Buffer): PieceJointeReconnue | null {
  for (const s of SIGNATURES) {
    if (commencePar(bytes, s.octets)) return { nature: s.nature, mime: s.mime };
  }
  if (commencePar(bytes, WEBP_RIFF) && commencePar(bytes, WEBP_TAG, 8)) {
    return { nature: 'image', mime: 'image/webp' };
  }
  if (commencePar(bytes, ZIP)) {
    return texteDocx(bytes) === null
      ? null
      : { nature: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  }
  if (bytes.length > 0 && !bytes.includes(0) && Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) {
    return { nature: 'texte', mime: 'text/plain' };
  }
  return null;
}

/**
 * Le texte d'un document, `null` si illisible. Une image rend `null` : c'est un modèle vision qui la lit,
 * dans la route.
 */
export async function extraireTexte(bytes: Buffer, nature: NaturePieceJointe): Promise<string | null> {
  if (nature === 'texte') return bytes.toString('utf8').replace(/\r\n?/g, '\n').trim();
  if (nature === 'docx') return texteDocx(bytes);
  if (nature === 'pdf') {
    try {
      // Import dynamique : `unpdf` embarque pdf.js, que l'API entière paierait au démarrage pour une route rare.
      const { extractText } = await import('unpdf');
      const { text } = await extractText(new Uint8Array(bytes), { mergePages: true });
      const brut = Array.isArray(text) ? text.join('\n') : String(text);
      return brut.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/ *\n[ \n]*/g, '\n').trim();
    } catch {
      return null; // PDF chiffré, corrompu, ou uniquement composé d'images scannées
    }
  }
  return null;
}

/**
 * Un texte découpé en fiches : par titres quand le document en a, sinon en tranches numérotées, jamais en une
 * fiche unique. Les plafonds sont ceux de l'import de page web, importés pour qu'une fiche produite ici reste
 * modifiable telle quelle à l'écran.
 */
export function texteEnFiches(texte: string, titreDefaut: string): FicheExtraite[] {
  // Les sections, une par titre. Le texte qui précède le premier titre prend le titre par défaut.
  const sections: Array<{ titre: string; lignes: string[] }> = [{ titre: titreDefaut, lignes: [] }];
  const courante = (): { titre: string; lignes: string[] } => sections[sections.length - 1]!;
  const contenuDe = (s: { lignes: string[] }): string => s.lignes.join('\n').trim();

  for (const brute of texte.split('\n')) {
    const ligne = brute.trim();
    if (ligne === '') { courante().lignes.push(''); continue; }
    if (ressembleAUnTitre(ligne)) {
      // Un titre qui suit du contenu ouvre une section ; deux titres de suite n'en ouvrent qu'une (le second
      // remplace le premier, qui n'a rien sous lui).
      if (contenuDe(courante()).length >= MIN_CORPS) sections.push({ titre: ligne, lignes: [] });
      else courante().titre = ligne;
      continue;
    }
    courante().lignes.push(ligne);
  }

  // Chaque section devient une ou plusieurs fiches : découpée, jamais tronquée, sinon le reste serait perdu
  // en silence et le client croirait son document importé.
  const fiches: FicheExtraite[] = [];
  for (const s of sections) {
    let reste = contenuDe(s);
    if (reste.length < MIN_CORPS) continue;
    let tranche = 0;
    while (reste.length > 0 && fiches.length < MAX_FICHES_PAR_PAGE) {
      let coupe = Math.min(MAX_CORPS, reste.length);
      if (coupe < reste.length) {
        // Coupe sur une frontière de mot ou de ligne quand il y en a une dans le dernier quart.
        const frontiere = Math.max(reste.lastIndexOf('\n', coupe), reste.lastIndexOf(' ', coupe));
        if (frontiere > coupe * 0.75) coupe = frontiere;
      }
      const corps = reste.slice(0, coupe).trim();
      reste = reste.slice(coupe).trim();
      if (corps.length === 0) break;
      tranche += 1;
      fiches.push({
        titre: (tranche === 1 ? s.titre : `${s.titre} (suite ${tranche})`).slice(0, MAX_TITRE),
        corps,
      });
    }
  }
  return fiches;
}
