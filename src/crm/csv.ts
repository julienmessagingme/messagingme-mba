import Papa from 'papaparse';

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
 * Un CSV refusé avant d'être lu. `statusCode` le fait rendre en 400 par le gestionnaire d'erreurs de `src/server.ts`,
 * avec ce message, par toutes les routes qui lisent un CSV : aucune ne peut l'oublier.
 */
export class CsvTropDeColonnes extends Error {
  readonly statusCode = 400;
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
 * `CsvTropDeColonnes` (400) sur un en-tête de plus de `COLONNES_MAX` colonnes.
 */
export function parseCsv(text: string): ParsedCsv {
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
    throw new CsvTropDeColonnes(`La première ligne compte ${colonnes} colonnes, ${COLONNES_MAX} au plus (le maximum d'Excel) : vérifiez qu'elle porte bien les en-têtes du fichier.`);
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
