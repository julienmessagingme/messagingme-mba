/**
 * CSV côté client : génération pour l'export (F5, historique mini-CRM) et découpe de la tête d'un fichier
 * avant l'aperçu d'import. Pas de dépendance : on construit le CSV en mémoire et on le télécharge. Choix
 * assumé (le wrapper `request()` fait toujours res.json(), donc le serveur renvoie du JSON, pas un CSV brut ;
 * c'est le front qui met en forme). Format RFC 4180 (séparateur virgule, CRLF, guillemets).
 */

/**
 * Taille de la TÊTE de fichier envoyée à l'aperçu d'import (AUDIT-SCALE-2026-08-25.md, R9, correctif 1).
 *
 * L'aperçu n'a besoin que des en-têtes et de quatre lignes d'exemple, et il envoyait pourtant le fichier
 * ENTIER. C'était le premier mur : au-delà d'environ 14 000 lignes, CHOISIR le fichier échouait sur le
 * plafond de corps de l'API, avant même d'avoir importé quoi que ce soit.
 *
 * 512 000 caractères, soit près de 8 000 lignes d'un CSV courant : sous ce seuil le nombre de lignes affiché
 * reste EXACT, ce qui couvre l'écrasante majorité des fichiers. Au-dessus il devient une estimation, et c'est
 * un bien meilleur marché qu'un refus.
 */
export const TETE_APERCU_CARACTERES = 512_000;

/**
 * Début du CSV, coupé sur une fin de ligne : sans ça, l'analyse recevrait une dernière ligne tronquée et
 * pourrait la présenter comme un exemple. Fichier plus court que le seuil -> rendu tel quel (donc analyse
 * complète, et nombre de lignes exact).
 */
export function teteCsv(texte: string): string {
  if (texte.length <= TETE_APERCU_CARACTERES) return texte;
  const tranche = texte.slice(0, TETE_APERCU_CARACTERES);
  const coupe = tranche.lastIndexOf('\n');
  return coupe > 0 ? tranche.slice(0, coupe) : tranche;
}

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
