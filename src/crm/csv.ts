import Papa from 'papaparse';

export interface ParsedCsv {
  headers: string[];
  rows: Array<Record<string, string>>;
}

/**
 * Parse un CSV (papaparse) : 1re ligne = en-têtes. Gère guillemets, virgules dans
 * les champs quotés, BOM, lignes vides. Toutes les valeurs sont ramenées à des strings
 * trimmées.
 */
export function parseCsv(text: string): ParsedCsv {
  const res = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim(),
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
