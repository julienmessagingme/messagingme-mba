import { estAbandon, HttpTimeoutError } from '../meta/http';

/**
 * Erreur d'appel à un modèle de langage, partagée par tous les clients LLM (ré-exportée par
 * `analysis/llm-client.ts`). `retryable` est reconnu par `withRetry` (duck-typing) et par les jobs qui laissent
 * remonter l'erreur jusqu'à pg-boss.
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
 * Le fournisseur a refusé l'appel parce que le plafond de la clé est atteint : un fait commercial, pas une panne.
 *  - `retryable: false`, toujours : Vercel répond 429, rejouable en règle générale, et chaque tour d'un client à sec
 *    repartirait pour des tentatives vouées à échouer ;
 *  - le parcours sort par « Plafond atteint » et non par « Échec », comme la garde du solde.
 */
export class PlafondModeleAtteint extends LlmApiError {
  constructor(status: number, message: string) {
    super(status, message, false);
    this.name = 'PlafondModeleAtteint';
  }
}

/**
 * Ce que l'échec d'un appel au modèle a le droit de dire au client, ou `null` quand ce n'est pas une panne du
 * fournisseur.
 *
 * 🔴 `null` veut dire « c'est la nôtre » : l'appelant relance l'erreur, que le gestionnaire global rend en 500
 * opaque et journalise. Sinon une panne de notre base (message avec identifiants) partirait au navigateur.
 * La raison est rédigée, jamais recopiée (le texte du fournisseur reste au journal), et ne dit pas qui paie :
 * les assistants tournent sur notre clé, le bac à sable sur celle de l'espace.
 * Une coupure réseau n'est reconnue que sous la forme de `fetch` (undici) : un `TypeError` au message exact
 * « fetch failed » ; une base injoignable lève une `Error` avec `code: 'ECONNREFUSED'`. Dans les `try` appelants,
 * le seul `fetch` est l'appel au modèle : un appelant dont le `try` couvrirait un autre `fetch` doit relire ceci.
 */
export function direPanneModele(err: unknown): string | null {
  if (err instanceof PlafondModeleAtteint) return 'le crédit du modèle est épuisé';
  if (err instanceof LlmApiError) {
    return err.retryable
      ? 'le fournisseur du modèle est indisponible pour le moment, réessayez dans un instant'
      : `le fournisseur du modèle a refusé l’appel (HTTP ${err.status})`;
  }
  if (err instanceof HttpTimeoutError || estAbandon(err)) return 'le modèle n’a pas répondu à temps, réessayez dans un instant';
  if (err instanceof TypeError && err.message === 'fetch failed') {
    return 'le fournisseur du modèle est injoignable pour le moment, réessayez dans un instant';
  }
  return null;
}
