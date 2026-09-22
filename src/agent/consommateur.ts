/**
 * QUI consomme un outil : un agent IA du client, ou le Meta Business Agent d'un numéro.
 *
 * 🔴 UNE CLÉ TEXTE, ET C'EST UN CHOIX (tranché par Julien le 2026-09-10). Un consommateur n'est pas
 * toujours une ligne de notre base : le MBA n'a ni modèle, ni crédit, ni fiche d'agent. Lui fabriquer une
 * fausse ligne `agents` pour pouvoir poser une clé étrangère aurait pollué tous les écrans qui comptent les
 * agents, et il faudrait recommencer au prochain consommateur qui n'est pas un agent.
 *
 * ⚠️ LE PRIX EST ÉCRIT ICI POUR QU'IL NE SE PERDE PAS : il n'y a AUCUNE clé étrangère derrière
 * `agent:<uuid>`, donc aucune cascade ne nettoie les lignes d'un agent supprimé. C'est
 * `PgAgentStore.supprimer` qui doit le faire, dans la même transaction, et un test d'intégration le tient.
 *
 * La FORME est aussi un CHECK en base (migration 0127) : une clé que ce module fabriquerait et que la base
 * refuserait remonterait en 500 au moment précis où un client active un outil.
 */

/**
 * ⚠️ Recopiée VERBATIM dans le CHECK de `db/migrations/0127_outils_consommateurs.sql`, et
 * `tests/agent-consommateur.test.ts` vérifie que les deux ne divergent pas. C'est le cas d'école des « deux
 * constantes de fichiers différents qui doivent rester ordonnées » : l'invariant n'est visible dans aucun
 * des deux, il ne peut vivre que dans un test.
 */
export const FORME_CONSOMMATEUR = /^(agent:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|mba:[0-9]{1,32})$/;

/**
 * ⚠️ EN MINUSCULES : `estUuid` accepte un identifiant en majuscules (une adresse tapée à la main), et Postgres le
 * lit comme le même `uuid`, mais la clé TEXTE, elle, aurait différé. Recopiée telle quelle, elle était refusée par
 * le CHECK de 0127 (500), ou manquait les consentements existants au retrait d'un agent, qui laissait alors des
 * consommateurs fantômes (relecture du 2026-09-22).
 */
export function consommateurAgent(agentId: string): string {
  return `agent:${agentId.toLowerCase()}`;
}

export function consommateurMba(phoneNumberId: string): string {
  return `mba:${phoneNumberId}`;
}

/** L'identifiant de l'agent, ou `null` si ce consommateur n'en est pas un (le MBA, ou une clé malformée). */
export function agentDuConsommateur(cle: string): string | null {
  if (!FORME_CONSOMMATEUR.test(cle) || !cle.startsWith('agent:')) return null;
  return cle.slice('agent:'.length);
}
