/**
 * Qui consomme un outil : un agent IA du client, ou le Meta Business Agent d'un numéro.
 *
 * Une clé texte, pas une clé étrangère : le MBA n'a pas de ligne `agents`, et lui en fabriquer une fausserait
 * tous les écrans qui comptent les agents. Aucune cascade ne nettoie donc les lignes d'un agent supprimé :
 * c'est `PgAgentStore.supprimer` qui le fait, dans la même transaction.
 */

/**
 * Recopiée verbatim dans le CHECK de `db/migrations/0127_outils_consommateurs.sql` (une clé que la base
 * refuse remonterait en 500) ; `tests/agent-consommateur.test.ts` tient la parité.
 */
export const FORME_CONSOMMATEUR = /^(agent:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|mba:[0-9]{1,32})$/;

/**
 * En minuscules : `estUuid` accepte les majuscules et Postgres y lit le même `uuid`, mais la clé texte
 * différerait (refusée par le CHECK, ou manquant les consentements existants au retrait d'un agent).
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
