import { messageDe } from './erreur';
/**
 * Une étape isolée : `faire` est attendue, et son échec est journalisé puis avalé, pour qu'une étape secondaire
 * n'emporte pas le travail principal (un webhook partagé rejoué puis mis en DLQ, un tour d'agent perdu, une
 * écriture déjà faite annoncée en échec).
 *
 * La ligne de journal reste `console.error(echec, message)` et pas `journaliser` (du JSON) : c'est le format
 * que l'on cherche dans les journaux de production.
 */
export async function tenter(echec: string, faire: () => Promise<unknown>): Promise<void> {
  try {
    await faire();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(echec, messageDe(err));
  }
}
