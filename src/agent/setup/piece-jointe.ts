import { unzipSync } from 'fflate';
import Papa from 'papaparse';
import { MAX_CORPS, MAX_FICHES_PAR_PAGE, MAX_TITRE, type FicheExtraite } from '../scrape';
import { CORPS_MAX } from '../resolvers/connaissance';

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

/** Le texte, si les octets sont de l'UTF-8 : relus puis réencodés, ils redonnent exactement les mêmes octets. */
function utf8(bytes: Buffer): string | null {
  const texte = bytes.toString('utf8');
  return Buffer.from(texte, 'utf8').equals(bytes) ? texte : null;
}

/**
 * Windows-1252, l'encodage d'un « CSV (séparateur: point-virgule) » enregistré par Excel sous Windows en
 * français : du latin1, sauf de 0x80 à 0x9F. Table écrite à la main plutôt que `TextDecoder`, qui ne connaît ce
 * jeu que si Node embarque l'ICU complet. Les cinq octets que Windows-1252 ne définit pas restent des caractères
 * de contrôle, que `CONTROLE` refuse.
 */
const CP1252_80_9F = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
];
function windows1252(bytes: Buffer): string {
  return bytes.toString('latin1').replace(/[\x80-\x9f]/g, (c) => String.fromCharCode(CP1252_80_9F[c.charCodeAt(0) - 0x80]!));
}

/** Un caractère de contrôle autre que la tabulation et les fins de ligne : du binaire, pas du texte. */
const CONTROLE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/;

/**
 * Fins de ligne Windows ramenées à `\n`, bords coupés, BOM d'Excel compris : le texte tel que le découpage le lit.
 * Les tabulations des bords restent : dans un TSV, ce sont des cellules vides (la case d'angle d'une grille).
 */
const normaliser = (texte: string): string => texte.replace(/\r\n?/g, '\n').replace(/^[^\S\t]+|[^\S\t]+$/g, '');

/** Les séparateurs essayés, dans l'ordre : le point-virgule d'abord, c'est celui d'Excel en français. */
const SEPARATEURS = [';', '\t', ',', '|'];
/** Les premières lignes lues pour reconnaître un tableau (lignes vides comprises, c'est ainsi que papaparse compte). */
const APERCU = 50;

/**
 * Le séparateur d'un CSV, ou `null` si le texte n'en a pas la forme : ses premières rangées, deux au moins, ont
 * toutes le même nombre de colonnes, deux au moins, sans guillemet mal fermé. Chaque séparateur est essayé plutôt
 * que deviné par papaparse, qui choisit la virgule dès que les réponses d'une FAQ en point-virgule en portent deux.
 */
function separateurCsv(texte: string): string | null {
  return SEPARATEURS.find((sep) => {
    const { data, errors } = Papa.parse<string[]>(texte, { delimiter: sep, preview: APERCU, skipEmptyLines: 'greedy' });
    const colonnes = data[0]?.length ?? 0;
    return errors.length === 0 && data.length >= 2 && colonnes >= 2 && data.every((r) => r.length === colonnes);
  }) ?? null;
}

/**
 * Un CSV lu, chaque rangée réécrite en une ligne ; `null` si le texte n'en est pas un. L'en-tête va jusqu'à la
 * première rangée qui a deux cellules remplies : un titre posé au-dessus du tableau doit suivre les noms de
 * colonnes dans chaque fiche. Il laisse aux rangées au moins la moitié d'une fiche, sinon ce n'est pas un tableau
 * qu'on sait découper. La lecture s'arrête quand il y a de quoi remplir toutes les fiches permises : au-delà, un
 * fichier de 8 Mo ne coûterait que du temps et de la mémoire, la suite n'étant pas écrite.
 */
function lireCsv(texte: string): { entete: string; rangees: string[] } | null {
  const sep = separateurCsv(texte);
  if (sep === null) return null;
  // Une ligne ordinaire revient à l'identique : un champ ne prend des guillemets que s'il porte le séparateur ou un
  // saut de ligne, ou s'il commence par un guillemet (`Papa.unparse` en met aussi autour d'une espace en bord).
  const ligne = (r: string[]): string =>
    r.map((v) => (v.includes(sep) || v.includes('\n') || v.startsWith('"') ? `"${v.replace(/"/g, '""')}"` : v)).join(sep);
  const lues: string[][] = [];
  let caracteres = 0;
  Papa.parse<string[]>(texte, {
    delimiter: sep,
    skipEmptyLines: 'greedy',
    step: ({ data }, parser) => {
      lues.push(data);
      caracteres += data.join(sep).length + 1;
      if (caracteres > MAX_FICHES_PAR_PAGE * CORPS_MAX) parser.abort();
    },
  });
  const debut = lues.findIndex((r) => r.filter((v) => v.trim() !== '').length >= 2);
  const entete = lues.slice(0, debut + 1).map(ligne).join('\n');
  const rangees = lues.slice(debut + 1).map(ligne);
  return debut < 0 || rangees.length === 0 || entete.length > CORPS_MAX / 2 ? null : { entete, rangees };
}

/**
 * Une rangée en morceaux de `taille` au plus : sur une espace ou un saut de ligne quand il y en a un dans le dernier
 * quart, comme le texte libre, et jamais entre les deux moitiés d'un emoji (une moitié seule ne passe pas en base).
 * Rien n'est retiré : les morceaux mis bout à bout redonnent la rangée.
 */
function couper(rangee: string, taille: number): string[] {
  const morceaux: string[] = [];
  let reste = rangee;
  while (reste.length > taille) {
    let coupe = Math.max(reste.lastIndexOf(' ', taille), reste.lastIndexOf('\n', taille));
    if (coupe <= taille * 0.75) coupe = taille;
    const avant = reste.charCodeAt(coupe - 1);
    if (avant >= 0xd800 && avant <= 0xdbff) coupe -= 1;
    morceaux.push(reste.slice(0, coupe));
    reste = reste.slice(coupe);
  }
  morceaux.push(reste);
  return morceaux;
}

/**
 * Un CSV en fiches : des rangées ENTIÈRES, l'en-tête en tête de chaque fiche, sans quoi une fiche du milieu ne
 * dirait plus ce que valent ses colonnes. 🔴 Une fiche ne dépasse pas ce que l'agent en lit (`CORPS_MAX`, et non
 * `MAX_CORPS`) : la recherche lit la fiche entière, l'agent seulement son début, donc une rangée plus bas serait
 * trouvée puis cachée à celui qui doit répondre. Une rangée plus longue qu'une fiche est coupée, jamais tronquée.
 */
function csvEnFiches({ entete, rangees }: { entete: string; rangees: string[] }, titreDefaut: string): FicheExtraite[] {
  const place = CORPS_MAX - entete.length - 1;
  const corps: string[] = [];
  for (const morceau of rangees.flatMap((r) => couper(r, place))) {
    const derniere = corps.length - 1;
    if (derniere >= 0 && corps[derniere]!.length + 1 + morceau.length <= CORPS_MAX) corps[derniere] += `\n${morceau}`;
    else corps.push(`${entete}\n${morceau}`);
  }
  return corps.slice(0, MAX_FICHES_PAR_PAGE).map((c, i) => ({
    titre: (i === 0 ? titreDefaut : `${titreDefaut} (suite ${i + 1})`).slice(0, MAX_TITRE),
    corps: c,
  }));
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
 * du texte. Seule exception, un CSV en Windows-1252 (l'export d'Excel) : n'importe quelle suite d'octets se lit
 * dans cet encodage, donc il n'est accepté que sans caractère de contrôle ET avec la forme régulière d'un CSV.
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
  if (bytes.length > 0 && !bytes.includes(0)) {
    if (utf8(bytes) !== null) return { nature: 'texte', mime: 'text/plain' };
    const texte = windows1252(bytes);
    if (!CONTROLE.test(texte) && separateurCsv(normaliser(texte)) !== null) return { nature: 'texte', mime: 'text/plain' };
  }
  return null;
}

/**
 * Le texte d'un document, `null` si illisible. Une image rend `null` : c'est un modèle vision qui la lit,
 * dans la route.
 */
export async function extraireTexte(bytes: Buffer, nature: NaturePieceJointe): Promise<string | null> {
  // `reconnaitre` n'a laissé passer, hors UTF-8, qu'un CSV en Windows-1252.
  if (nature === 'texte') return normaliser(utf8(bytes) ?? windows1252(bytes));
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
 * modifiable telle quelle à l'écran. Un fichier TEXTE qui a la forme d'un CSV est découpé par rangées
 * (`csvEnFiches`) ; un PDF, un Word ou le texte lu dans une image jamais, même quand ils en ont la forme.
 */
export function texteEnFiches(texte: string, titreDefaut: string, nature: NaturePieceJointe): FicheExtraite[] {
  const csv = nature === 'texte' ? lireCsv(texte) : null;
  if (csv !== null) return csvEnFiches(csv, titreDefaut);

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
