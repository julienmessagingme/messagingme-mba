import Papa from 'papaparse';
import { horsBoucle } from '../lib/hors-boucle';

export interface ParsedCsv {
  headers: string[];
  rows: Array<Record<string, string>>;
}

/** Les séparateurs essayés, dans l'ordre : le point-virgule d'abord, c'est celui d'Excel en français. */
const SEPARATEURS = [';', '\t', ',', '|'];
/** Les premières lignes lues pour reconnaître un tableau (lignes vides comprises, c'est ainsi que papaparse compte). */
const APERCU = 50;
/** Le plus d'en-têtes que `parseCsv` accepte : 16 384 est le maximum d'Excel (colonne XFD), un fichier réel en est loin. */
const COLONNES_MAX = 16_384;
/**
 * Le plus de lignes que `parseCsv` accepte, lignes vides comprises : 1 048 576 est le maximum d'Excel, et un export
 * dont la plage descend au bas de la feuille l'atteint. Le corps de 8 Mo de l'import, où un saut de ligne pèse deux
 * octets, porte au plus 762 600 lignes de numéros seuls.
 */
const LIGNES_MAX = 1_048_576;

/**
 * Un CSV refusé avant d'être lu. `statusCode` le fait rendre en 400 par le gestionnaire d'erreurs de `src/server.ts`,
 * avec ce message, par toutes les routes qui lisent un CSV : aucune ne peut l'oublier.
 */
export class CsvTropGros extends Error {
  readonly statusCode = 400;
}

/** Les `fin` de `texte`, comptées jusqu'à LIGNES_MAX + 1 au plus : au-delà, le texte est refusé de toute façon. */
function finsDeLigne(texte: string, fin: '\n' | '\r'): number {
  let n = 0;
  for (let i = texte.indexOf(fin); i !== -1 && n <= LIGNES_MAX; i = texte.indexOf(fin, i + 1)) n += 1;
  return n;
}

/**
 * Le séparateur d'un CSV, ou `null` si le texte n'en a pas la forme : ses premières rangées, deux au moins, ont
 * toutes le même nombre de colonnes, deux au moins, sans guillemet mal fermé. Chaque séparateur est essayé plutôt
 * que deviné par papaparse, qui choisit la virgule dès que les réponses d'une FAQ en point-virgule en portent deux.
 * 🔴 Les trois lecteurs d'un CSV reçu d'un client passent par ici (contacts, FAQ de l'agent de Meta, connaissance
 * d'un agent) : une seconde règle lirait le même fichier autrement selon l'écran où il est déposé. Sans tableau
 * régulier, chacun garde son repli : `parseCsv` la devinette de papaparse, la connaissance le texte libre.
 */
export function separateurCsv(texte: string): string | null {
  return SEPARATEURS.find((sep) => {
    const { data, errors } = Papa.parse<string[]>(texte, { delimiter: sep, preview: APERCU, skipEmptyLines: 'greedy' });
    const colonnes = data[0]?.length ?? 0;
    return errors.length === 0 && data.length >= 2 && colonnes >= 2 && data.every((r) => r.length === colonnes);
  }) ?? null;
}

/**
 * Parse un CSV (papaparse) : 1re ligne = en-têtes. Gère guillemets, virgules dans
 * les champs quotés, BOM, lignes vides. Toutes les valeurs sont ramenées à des strings
 * trimmées ; une cellule absente (rangée plus courte que l'en-tête) reste absente. Le séparateur est celui de
 * `separateurCsv` ; des rangées inégales, où il n'en trouve pas, retombent sur la devinette de papaparse. Lève
 * `CsvTropGros` (400) au-delà de `LIGNES_MAX` lignes ou de `COLONNES_MAX` colonnes d'en-tête.
 */
export function parseCsv(text: string): ParsedCsv {
  // 🔴 Les lignes se comptent AVANT tout : papaparse fait un objet, et une erreur « Too few fields » pour une rangée
  // courte, par rangée. 8 Mo de lignes d'un caractère en portent près de 3 millions, soit 4 à 6 s de boucle
  // d'événements et plus d'un Go de tas (mesuré le 2026-09-30). `\n` et `\r` se comptent à part, et le plus grand
  // l'emporte : papaparse prend l'un, l'autre ou les deux pour fin de ligne, et `\r\n` n'en fait qu'une.
  if (Math.max(finsDeLigne(text, '\n'), finsDeLigne(text, '\r')) > LIGNES_MAX) {
    throw new CsvTropGros(`Le fichier compte plus de ${LIGNES_MAX} lignes (lignes vides comprises), le maximum d'Excel : découpez-le en plusieurs fichiers plus petits.`);
  }
  // Le séparateur se fixe UNE fois, avec les réglages de la lecture : faute de séparateur trouvé, la devinette de
  // papaparse coûte 2 s environ sur 8 Mo, et ni le contrôle ni la lecture ne doivent la refaire.
  const delimiter = separateurCsv(text) ?? Papa.parse(text, { skipEmptyLines: 'greedy', preview: 1, fastMode: false }).meta.delimiter;
  // 🔴 L'en-tête se compte AVANT la lecture : papaparse traite chaque en-tête (doublons renommés compris), et une ligne
  // unique de 8 Mo en porte 4 millions, soit 6 à 13 s de boucle d'événements prises à tous les espaces (mesuré le
  // 2026-09-30). L'en-tête est la première rangée non vide, OU la première rangée tout court quand elle n'est faite que
  // de séparateurs : papaparse renomme ses doublons (`_1`, `_2`...) avant de sauter les vides. D'où la plus large des
  // rangées jusqu'à la première non vide, lue en mode normal (le mode rapide découpe tout le texte avant de la rendre).
  let colonnes = 0;
  Papa.parse<string[]>(text, {
    delimiter,
    fastMode: false,
    step: ({ data }, parser) => {
      colonnes = Math.max(colonnes, data.length);
      if (data.join('').trim() !== '') parser.abort();
    },
  });
  if (colonnes > COLONNES_MAX) {
    throw new CsvTropGros(`La première ligne compte ${colonnes} colonnes, ${COLONNES_MAX} au plus (le maximum d'Excel) : vérifiez qu'elle porte bien les en-têtes du fichier.`);
  }
  const res = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim(),
    delimiter,
  });
  const headers = (res.meta.fields ?? []).map((h) => h.trim()).filter((h) => h.length > 0);
  // 🔴 Seules les cellules PRÉSENTES se recopient : compléter chaque rangée jusqu'à la largeur de l'en-tête coûtait
  // en-têtes x rangées, 10 s et 900 Mo de tas pour un fichier de 34 Ko (1 000 rangées d'un caractère sous 16 384
  // colonnes). Ses lecteurs lisent une cellule absente comme vide, et `noUncheckedIndexedAccess` y oblige le prochain.
  const retenus = new Set(headers);
  const rows = (res.data ?? []).map((r) => {
    const o: Record<string, string> = {};
    for (const [h, v] of Object.entries(r)) {
      if (retenus.has(h) && v !== undefined && v !== null) o[h] = String(v).trim();
    }
    return o;
  });
  return { headers, rows };
}

/** Une rangée indexée par numéro de colonne : le nom de l'en-tête n'est pas répété à chaque rangée. */
type RangeeCompacte = Record<number, string>;

/**
 * `parseCsv` sous la forme qui voyage du worker au fil principal : les rangées indexées par numéro de colonne.
 * Relevé par la relecture du 2026-09-30 : rendues par nom, 16 384 noms de 200 caractères répétés sur 140 rangées
 * pesaient 473 Mo de JSON, et le fil principal payait 1,8 s et 1,4 Go pour les relire.
 */
export function parseCsvCompact(text: string): { headers: string[]; rows: RangeeCompacte[] } {
  const { headers, rows } = parseCsv(text);
  const colonne = new Map<string, number>();
  headers.forEach((h, i) => { if (!colonne.has(h)) colonne.set(h, i); });
  return {
    headers,
    rows: rows.map((r) => {
      const o: RangeeCompacte = {};
      for (const [h, v] of Object.entries(r)) o[colonne.get(h)!] = v;
      return o;
    }),
  };
}

/**
 * `parseCsv` hors de la boucle d'événements (`src/lib/hors-boucle.ts`) : ce que l'import appelle. Les bornes
 * ci-dessus ferment des formes, cette lecture borne le TEMPS : sous elles, des fichiers de quelques centaines de Ko
 * tenaient encore la boucle des minutes (relevé le 2026-09-30). Le fil principal ne paie plus que la relecture des
 * cellules présentes.
 */
export async function parseCsvHorsBoucle(text: string): Promise<ParsedCsv> {
  const { headers, rows } = await horsBoucle<{ headers: string[]; rows: RangeeCompacte[] }>(new URL(import.meta.url), 'parseCsvCompact', [text]);
  return {
    headers,
    rows: rows.map((r) => {
      const o: Record<string, string> = {};
      for (const [i, v] of Object.entries(r)) o[headers[Number(i)]!] = v;
      return o;
    }),
  };
}

/** Ce que l'aperçu d'un import montre, et rien de plus : l'en-tête, quatre rangées d'exemple, le compte. */
export interface ApercuCsv {
  headers: string[];
  sampleRows: Array<Record<string, string>>;
  rowCount: number;
}

export function apercuCsv(text: string): ApercuCsv {
  const { headers, rows } = parseCsv(text);
  return { headers, sampleRows: rows.slice(0, 4), rowCount: rows.length };
}

/** `apercuCsv` hors de la boucle d'événements : l'aperçu ne rapporte au fil principal que ce qu'il montre. */
export function apercuCsvHorsBoucle(text: string): Promise<ApercuCsv> {
  return horsBoucle<ApercuCsv>(new URL(import.meta.url), 'apercuCsv', [text]);
}
