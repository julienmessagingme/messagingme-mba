/**
 * Génération CSV côté client (F5 : export de l'historique mini-CRM). Pas de dépendance : on construit le CSV en
 * mémoire et on le télécharge. Choix assumé (le wrapper `request()` fait toujours res.json(), donc le serveur renvoie
 * du JSON, pas un CSV brut ; c'est le front qui met en forme). Format RFC 4180 (séparateur virgule, CRLF, guillemets).
 */

/** Échappe une valeur pour une cellule CSV : entoure de guillemets si virgule / guillemet / retour ligne, et double
 *  les guillemets internes. null/undefined -> chaîne vide. */
function cell(v: string | number | null | undefined): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Construit un CSV (ligne d'en-têtes + lignes de données), séparateur virgule, fin de ligne CRLF (RFC 4180). */
export function toCsv(headers: string[], rows: Array<Array<string | number | null | undefined>>): string {
  return [headers, ...rows].map((row) => row.map(cell).join(',')).join('\r\n');
}

/** Déclenche le téléchargement d'un CSV dans le navigateur (Blob + <a download>). Préfixe BOM UTF-8 pour qu'Excel
 *  ouvre correctement les accents. No-op hors navigateur (SSR). */
export function downloadCsv(filename: string, content: string): void {
  if (typeof document === 'undefined') return;
  const blob = new Blob(['﻿' + content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
