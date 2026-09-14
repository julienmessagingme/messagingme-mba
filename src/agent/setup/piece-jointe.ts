import { unzipSync } from 'fflate';
import { MAX_CORPS, MAX_FICHES_PAR_PAGE, MAX_TITRE, type FicheExtraite } from '../scrape';

/**
 * Une pièce jointe de la conversation de construction, transformée en TEXTE puis en fiches de connaissance.
 *
 * Julien, 2026-08-31 : « il faut aussi qu'on puisse rajouter des pièces jointes (images, documents, …) dans
 * la conversation (notamment pour rajouter des base de connaissance) ». Un client arrive avec ses procédures
 * déjà écrites ; les retaper fiche par fiche est exactement le travail qu'on lui promet d'éviter.
 *
 * 🔴 LE TYPE EST DÉCIDÉ PAR LA SIGNATURE DU FICHIER, jamais par ce que le navigateur déclare. Même doctrine
 * que `src/rcs/image.ts`, et elle mord autant ici : ce texte finit dans la base de connaissance, donc dans le
 * prompt d'un agent qui parle à de vrais contacts. Un fichier qui ment sur sa nature est refusé.
 *
 * 🔴 ET LE TEXTE EST DÉCOUPÉ, jamais avalé d'un bloc. C'est la leçon déjà écrite dans `scrape.ts` : la
 * recherche de connaissance mesure « combien de termes de la question se retrouvent dans la fiche », donc un
 * document entier dans une seule fiche contient à peu près tous les mots du métier, devient pertinent pour
 * n'importe quelle question, et rend la garde anti-hallucination inopérante SANS qu'aucun test ne le voie.
 * Un PDF de quarante pages est le pire cas possible de ce défaut.
 *
 * Ce module est PUR et sans réseau : la lecture d'une image par un modèle vision est faite par la route, qui
 * a le client LLM. Ici on ne fait que reconnaître, extraire et découper.
 */

export type NaturePieceJointe = 'texte' | 'pdf' | 'docx' | 'image';

export interface PieceJointeReconnue {
  nature: NaturePieceJointe;
  /** Le MIME RÉEL, celui de la signature. Pour une image, c'est lui qu'on renvoie au modèle vision. */
  mime: string;
}

/**
 * Plafonds. Ce sont les NÔTRES : les octets traversent notre API, l'extraction tourne dans le process, et une
 * image part chez un fournisseur qui la facture. Un document de 8 Mo est déjà un très gros manuel.
 */
export const TAILLE_DOCUMENT_MAX = 8 * 1024 * 1024;
export const TAILLE_IMAGE_MAX = 5 * 1024 * 1024;

/** Sous ce seuil, un morceau n'a qu'un titre et une bribe : il ferait du bruit dans la recherche sans jamais
 *  répondre à quoi que ce soit. Même seuil que le découpage d'une page web, et pour la même raison. */
const MIN_CORPS = 40;

/**
 * Une ligne qui se comporte comme un TITRE : courte, sans ponctuation finale de phrase, et pas une simple
 * énumération. Heuristique assumée, dans l'esprit de `scrape.ts` (« on ne cherche pas à faire un lecteur
 * HTML ») : un document mal découpé se corrige à la main dans l'onglet Base de connaissance, ce qui est
 * exactement la promesse faite au client.
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
 * 🔴 CE QU'UN `.docx` A LE DROIT DE PESER UNE FOIS DÉCOMPRESSÉ, ET C'EST UNE GARDE DE DISPONIBILITÉ.
 *
 * Un ZIP est un format à TAUX DE COMPRESSION NON BORNÉ : quelques méga d'archive peuvent déclarer plusieurs
 * gigaoctets à l'intérieur. Décompresser sans regarder ce chiffre revient à laisser un fichier téléversé
 * décider de la mémoire du process, c'est-à-dire à offrir un arrêt de l'API à qui joint un document.
 *
 * ⚠️ LE CHIFFRE EST CELUI QUE L'ARCHIVE DÉCLARE, donc il est fourni par celui qui l'envoie : il ne prouve
 * rien, mais il permet de REFUSER avant d'allouer. Une archive qui ment en annonçant petit fait échouer
 * l'inflation dans `fflate`, qui écrit dans un tampon de la taille annoncée : l'exception est attrapée juste
 * en dessous, et le fichier n'est alors pas reconnu comme un document Word.
 *
 * 64 Mo : un `word/document.xml` est du XML, très compressible ; un manuel de plusieurs centaines de pages
 * reste largement sous ce seuil.
 */
const MAX_DOCX_DECOMPRESSE = 64 * 1024 * 1024;
/** `RIFF????WEBP`. Accepté ICI et pas dans `src/rcs/image.ts` : là-bas la liste est celle que l'opérateur RCS
 *  accepte, ici c'est celle qu'un modèle vision sait lire, et une capture d'écran moderne est souvent en webp. */
const WEBP_RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP_TAG = [0x57, 0x45, 0x42, 0x50];

function commencePar(bytes: Buffer, octets: readonly number[], decalage = 0): boolean {
  return bytes.length >= decalage + octets.length && octets.every((o, i) => bytes[decalage + i] === o);
}

/**
 * Le texte d'un fichier `.docx`, lu dans son `word/document.xml`.
 *
 * Un `.docx` est une archive ZIP contenant du XML ; on décompresse (`fflate`, sans dépendance transitive) et
 * on relève le contenu des nœuds `<w:t>`, avec un saut de ligne par paragraphe. Pas de bibliothèque de
 * traitement de texte : même arbitrage que `scrape.ts` pour le HTML, et le même repli (ce qui est mal découpé
 * se corrige à la main).
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
    // Un saut de paragraphe ET un saut de ligne explicite deviennent des retours à la ligne : sans eux, tout
    // le document arriverait en une seule phrase, et le découpage par titre n'aurait plus rien à voir.
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
 * La nature RÉELLE du fichier, ou `null` s'il n'est pas d'un type accepté.
 *
 * Le texte brut n'a pas de signature : il est reconnu en dernier, et seulement s'il est de l'UTF-8 valide sans
 * octet nul. C'est ce qui empêche un binaire inconnu de passer pour un fichier texte et d'injecter des
 * caractères de contrôle dans la base de connaissance.
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
 * Le texte d'un document. `null` = illisible.
 *
 * ⚠️ Une IMAGE ne passe pas par ici : elle n'a pas de texte à extraire, c'est un modèle vision qui la lit, et
 * ça se fait dans la route (seule à disposer du client LLM). Appeler cette fonction sur une image rend `null`,
 * ce qui est le comportement voulu plutôt qu'une exception.
 */
export async function extraireTexte(bytes: Buffer, nature: NaturePieceJointe): Promise<string | null> {
  if (nature === 'texte') return bytes.toString('utf8').replace(/\r\n?/g, '\n').trim();
  if (nature === 'docx') return texteDocx(bytes);
  if (nature === 'pdf') {
    try {
      // Import DYNAMIQUE : `unpdf` embarque une construction de pdf.js, et la charger au démarrage du
      // process ferait payer ce poids à l'API entière pour une route qu'on appelle quelques fois par client.
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
 * Un texte découpé en fiches de connaissance.
 *
 * Le découpage suit les TITRES quand le document en a, et retombe sur des tranches numérotées quand il n'en a
 * pas (un PDF exporté sans structure, par exemple). Dans les deux cas on ne rend jamais une fiche unique
 * portant tout le document : voir l'en-tête de ce fichier, c'est une décision de justesse de la recherche, pas
 * de confort de lecture.
 *
 * Les plafonds sont ceux de l'import de page web, importés et non recopiés : deux limites différentes feraient
 * qu'une fiche produite ici ne serait plus modifiable telle quelle dans l'écran.
 */
export function texteEnFiches(texte: string, titreDefaut: string): FicheExtraite[] {
  // Premier temps : les SECTIONS, une par titre rencontré. Le texte qui précède le premier titre n'est pas
  // jeté, il prend le titre par défaut (même règle que pour le chapeau d'une page web).
  const sections: Array<{ titre: string; lignes: string[] }> = [{ titre: titreDefaut, lignes: [] }];
  const courante = (): { titre: string; lignes: string[] } => sections[sections.length - 1]!;
  const contenuDe = (s: { lignes: string[] }): string => s.lignes.join('\n').trim();

  for (const brute of texte.split('\n')) {
    const ligne = brute.trim();
    if (ligne === '') { courante().lignes.push(''); continue; }
    if (ressembleAUnTitre(ligne)) {
      // Un titre qui suit du contenu OUVRE une section. Deux titres de suite (un sur-titre puis son
      // sous-titre) n'en ouvrent qu'une : le second remplace le premier, qui n'a rien sous lui.
      if (contenuDe(courante()).length >= MIN_CORPS) sections.push({ titre: ligne, lignes: [] });
      else courante().titre = ligne;
      continue;
    }
    courante().lignes.push(ligne);
  }

  // Second temps : chaque section devient une ou PLUSIEURS fiches. Une section plus longue que le plafond est
  // DÉCOUPÉE, jamais tronquée : couper rendrait une fiche au plafond et perdrait tout le reste en silence,
  // ce qui est le mode de panne le plus vicieux ici (le client croit son document importé).
  const fiches: FicheExtraite[] = [];
  for (const s of sections) {
    let reste = contenuDe(s);
    if (reste.length < MIN_CORPS) continue;
    let tranche = 0;
    while (reste.length > 0 && fiches.length < MAX_FICHES_PAR_PAGE) {
      let coupe = Math.min(MAX_CORPS, reste.length);
      if (coupe < reste.length) {
        // On coupe sur une frontière de mot ou de ligne quand il y en a une dans le dernier quart : couper au
        // milieu d'un mot rendrait la fiche illisible dans l'écran d'édition.
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
