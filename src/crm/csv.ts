import Papa from 'papaparse';

export interface ParsedCsv {
  headers: string[];
  rows: Array<Record<string, string>>;
}

/** Les séparateurs essayés, dans l'ordre : le point-virgule d'abord, c'est celui d'Excel en français. */
const SEPARATEURS = [';', '\t', ',', '|'];
/** Les premières lignes lues pour reconnaître un tableau (lignes vides comprises, c'est ainsi que papaparse compte). */
const APERCU = 50;

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
 * trimmées. Le séparateur est celui de `separateurCsv` ; des rangées inégales, où il n'en trouve pas, retombent sur
 * la devinette de papaparse.
 */
export function parseCsv(text: string): ParsedCsv {
  const res = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim(),
    delimiter: separateurCsv(text) ?? undefined,
  });
  const headers = (res.meta.fields ?? []).map((h) => h.trim()).filter((h) => h.length > 0);
  const rows = (res.data ?? []).map((r) => {
    const o: Record<string, string> = {};
    for (const h of headers) {
      const v = r[h];
      o[h] = v === undefined || v === null ? '' : String(v).trim();
    }
    return o;
  });
  return { headers, rows };
}
