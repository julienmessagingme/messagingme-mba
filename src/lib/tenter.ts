import { messageDe } from './erreur';
/**
 * Une étape ISOLÉE : `faire` est attendue, et son échec est journalisé puis AVALÉ, pour qu'une étape secondaire
 * n'emporte pas le travail principal (un webhook partagé rejoué puis mis en DLQ, un tour d'agent perdu, une
 * écriture déjà faite annoncée en échec).
 *
 * ⚠️ LA LIGNE DE JOURNAL EST CELLE DES `try/catch` QU'ELLE REMPLACE, au caractère près :
 * `console.error(echec, message)`. Ce n'est pas `journaliser` (du JSON) : changer de format ici changerait ce
 * qu'on cherche dans les journaux de production.
 */
export async function tenter(echec: string, faire: () => Promise<unknown>): Promise<void> {
  try {
    await faire();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(echec, messageDe(err));
  }
}
