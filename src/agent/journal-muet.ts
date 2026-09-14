import type { JournalAppels } from './catalog';

/**
 * Un journal d'appels qui n'écrit RIEN.
 *
 * 🔴 SA JUSTIFICATION D'ORIGINE A CESSÉ D'ÊTRE VRAIE LE 2026-09-14, ET ELLE EST GARDÉE ICI PARCE QU'ELLE
 * EXPLIQUE L'HISTOIRE. Elle disait : « `agent_tool_calls.session_id` référence `agent_sessions` et n'est pas
 * nullable (migration 0086), donc le bac à sable, qui n'ouvre aucune session, violerait la clé étrangère ».
 * La migration 0142 a relâché cette contrainte, pour que le bloc « Appel HTTP » d'un scénario et la poussée
 * d'un opt-out puissent enfin journaliser. Le verrou de schéma n'existe donc plus.
 *
 * ⚠️ CE MODULE RESTE, ET C'EST DÉSORMAIS UN CHOIX PRODUIT, PAS UNE CONTRAINTE. Faire écrire le bac à sable
 * ferait entrer les essais d'un administrateur dans le journal des erreurs que le client consulte : un
 * réglage qu'on met au point en cassant des choses exprès y apparaîtrait comme une panne. Le jour où on le
 * voudra, il n'y a plus rien à migrer, il suffit de lui passer un vrai journal avec sa propre `source`.
 *
 * ⚠️ CONSÉQUENCE ASSUMÉE, INCHANGÉE : le coût d'un essai n'entre pas dans le grand livre du tenant. La route
 * rend l'`usage` de chaque essai pour que l'écran le montre, et la surface est réservée aux administrateurs,
 * un clic à la fois.
 */
export const JOURNAL_MUET: JournalAppels = {
  ouvrir: async () => '',
  clore: async () => {},
};
