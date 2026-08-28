import type { JournalAppels } from './catalog';

/**
 * Un journal d'appels qui n'écrit RIEN.
 *
 * 🔴 IL EXISTE POUR UNE RAISON DE SCHÉMA, PAS DE CONFORT. `agent_tool_calls.session_id` référence
 * `agent_sessions` et n'est pas nullable (migration 0086) : le bac à sable de la console n'ouvre aucune
 * session, donc chaque essai violerait la clé étrangère. Le tronc commun, lui, exige un journal et le
 * journalise en best-effort ; lui donner celui-ci est la seule façon honnête de dire « ici, on ne trace pas ».
 *
 * ⚠️ CONSÉQUENCE ASSUMÉE : le coût d'un essai n'entre pas dans le grand livre du tenant. La route rend
 * l'`usage` de chaque essai pour que l'écran le montre, et la surface est réservée aux administrateurs, un
 * clic à la fois. Le jour où le bac à sable devient rejouable en série (la suite de tests du cadrage §5.2),
 * il faudra une vraie ligne de facturation, et donc une session de bac à sable en base.
 */
export const JOURNAL_MUET: JournalAppels = {
  ouvrir: async () => '',
  clore: async () => {},
};
