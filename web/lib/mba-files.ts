/**
 * Règles d'acceptation d'un fichier de connaissance MBA.
 *
 * ⚠️ DUPLIQUÉ du serveur (`src/http/mba.ts`, `EXTENSIONS_FICHIER` et `MAX_FICHIER`), même raison et même filet
 * que `mba-skills.ts` : refuser tout de suite un fichier que Meta rejettera, plutôt que de faire monter
 * 27 Mo de base64 pour rien. `tests/web-mba-parity.test.ts` casse si les listes divergent.
 *
 * La liste vient du SCHÉMA de Meta, pas de sa prose : `.txt` et `.md` en sont absents, même si la description
 * de l'API parle de « text documents ».
 */

/** Type MIME accepté vers l'extension que le nom du fichier doit porter. */
export const MBA_FILE_TYPES: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'text/csv': 'csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

/** `.jpeg` vaut `.jpg`. */
const EQUIVALENTES: Record<string, string[]> = { jpg: ['jpg', 'jpeg'] };

/** Meta accepte 100 Mo, mais le corps transite en base64 (+33 %) : le serveur plafonne à 20 Mo. */
export const MBA_FILE_MAX_BYTES = 20 * 1024 * 1024;

/** Extensions à proposer dans le sélecteur de fichier. */
export const MBA_FILE_ACCEPT = '.pdf,.doc,.docx,.png,.jpg,.jpeg,.csv,.xlsx';

export function mbaFileExtensionOk(fileName: string, mime: string): boolean {
  const attendue = MBA_FILE_TYPES[mime.toLowerCase()];
  if (attendue === undefined) return false;
  const ext = (fileName.split('.').pop() ?? '').toLowerCase();
  return (EQUIVALENTES[attendue] ?? [attendue]).includes(ext);
}

export function mbaFileSizeOk(bytes: number): boolean {
  return bytes > 0 && bytes <= MBA_FILE_MAX_BYTES;
}

/**
 * `.csv` et `.xlsx` ne sont acceptés QUE si l'extraction correspondante est activée sur l'actif WhatsApp, et
 * Meta ne documente ni comment le vérifier ni comment l'activer. Un refus sur ces deux formats mérite donc un
 * message qui dit ce qu'il faut vérifier, au lieu de laisser croire que le fichier est en cause.
 */
export function mbaFileFormatConditionnel(fileName: string): boolean {
  const ext = (fileName.split('.').pop() ?? '').toLowerCase();
  return ext === 'csv' || ext === 'xlsx';
}
