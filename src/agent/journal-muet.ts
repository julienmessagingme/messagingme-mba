import type { JournalAppels } from './catalog';

/**
 * Un journal d'appels qui n'écrit rien, pour le bac à sable.
 *
 * Un choix produit, pas une contrainte de schéma : les essais d'un administrateur n'ont pas à apparaître comme
 * des pannes dans le journal des erreurs que le client consulte. Conséquence : le coût d'un essai n'entre pas
 * dans le grand livre du tenant (la route rend l'`usage` de chaque essai pour que l'écran le montre).
 */
export const JOURNAL_MUET: JournalAppels = {
  ouvrir: async () => '',
  clore: async () => {},
};
