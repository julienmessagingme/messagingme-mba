/**
 * Erreur d'appel à un modèle de langage, partagée par TOUS les clients LLM du repo.
 *
 * Extraite de `src/analysis/llm-client.ts` quand un second client est arrivé (l'agent) : la garder là-bas
 * aurait obligé le client de l'agent à importer depuis le module d'analyse de conversation, qui n'a rien à
 * voir. `analysis/llm-client.ts` la RÉ-EXPORTE, donc aucun import existant ne casse.
 *
 * `retryable` est reconnu par `withRetry` en duck-typing (`src/meta/http.ts`), et par les jobs qui laissent
 * remonter l'erreur jusqu'à pg-boss quand les tentatives sont épuisées.
 */
export class LlmApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'LlmApiError';
  }
}

/**
 * Le fournisseur a refuse l'appel PARCE QUE le plafond de la cle est atteint (2026-09-09).
 *
 * 🔴 CE N'EST PAS UNE PANNE, C'EST UN FAIT COMMERCIAL : le client a consomme ce qu'il a achete. La
 * distinction n'est pas cosmetique, elle change DEUX comportements :
 *   - `retryable: false`, toujours. Vercel repond 429 sur un plafond atteint, et 429 est rejouable dans la
 *     regle generale : sans cette classe, chaque tour d'agent d'un client a sec repartait pour trois
 *     tentatives, toutes vouees a echouer, sur chaque message recu ;
 *   - le parcours sort par « Plafond atteint » et non par « Echec », donc le client cable UNE seule sortie
 *     quelle que soit la raison, ce que la garde du solde fait deja pour la meme situation vue de chez nous.
 */
export class PlafondModeleAtteint extends LlmApiError {
  constructor(status: number, message: string) {
    super(status, message, false);
    this.name = 'PlafondModeleAtteint';
  }
}
