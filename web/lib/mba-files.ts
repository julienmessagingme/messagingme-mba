/**
 * Ce que l'écran des fichiers de connaissance ajoute aux règles d'acceptation partagées avec le serveur
 * (`./partage/agent-meta` : `extensionCoherente`, `tailleFichierOk`, `MAX_FICHIER`). Refuser tout de suite un fichier
 * que Meta rejettera évite de faire monter 27 Mo de base64 pour rien.
 */

/** Extensions à proposer dans le sélecteur de fichier. */
export const MBA_FILE_ACCEPT = '.pdf,.doc,.docx,.png,.jpg,.jpeg,.csv,.xlsx';

/**
 * `.csv` et `.xlsx` ne sont acceptés QUE si l'extraction correspondante est activée sur l'actif WhatsApp, et
 * Meta ne documente ni comment le vérifier ni comment l'activer. Un refus sur ces deux formats mérite donc un
 * message qui dit ce qu'il faut vérifier, au lieu de laisser croire que le fichier est en cause.
 */
export function mbaFileFormatConditionnel(fileName: string): boolean {
  const ext = (fileName.split('.').pop() ?? '').toLowerCase();
  return ext === 'csv' || ext === 'xlsx';
}
