import { estAbandon, HttpTimeoutError } from '../meta/http';

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

/**
 * CE QUE L'ÉCHEC D'UN APPEL AU MODÈLE A LE DROIT DE DIRE AU CLIENT, ou `null` quand ce n'est PAS une panne du
 * fournisseur (2026-09-22).
 *
 * 🔴 `null` VEUT DIRE « C'EST LA NÔTRE », et l'appelant doit alors RELANCER l'erreur : le gestionnaire global
 * (`src/server.ts`) rend un 500 opaque et la journalise. Le bac à sable rendait `err.message` dans un 422
 * pour TOUT ce que son `catch` attrapait, alors que le même `try` couvre des lectures en base : une panne de
 * notre base (« password authentication failed for user … ») serait partie telle quelle au navigateur.
 *
 * ⚠️ LA RAISON EST RÉDIGÉE, JAMAIS RECOPIÉE : le texte du fournisseur est en anglais, écrit pour un
 * développeur, et il reste dans le journal de l'appelant. Elle ne dit pas non plus QUI paie : les assistants
 * de configuration tournent sur NOTRE clé, le bac à sable sur celle de l'espace, et « votre crédit » serait
 * faux pour l'un des deux.
 *
 * ⚠️ UNE ERREUR RÉSEAU N'EN FAIT PAS PARTIE, délibérément : `ECONNREFUSED` est aussi ce que lève une base
 * injoignable, et l'attribuer au fournisseur serait un mensonge. Elle sort en 500, après les rejeux de
 * `withRetry`. Un abandon, lui, se dit « délai dépassé » sans nommer le modèle : dans le bac à sable, l'appel
 * coupé peut être celui d'un outil.
 */
export function direPanneModele(err: unknown): string | null {
  if (err instanceof PlafondModeleAtteint) return 'le crédit du modèle est épuisé';
  if (err instanceof LlmApiError) {
    return err.retryable
      ? 'le fournisseur du modèle est indisponible pour le moment, réessayez dans un instant'
      : `le fournisseur du modèle a refusé l’appel (HTTP ${err.status})`;
  }
  if (err instanceof HttpTimeoutError || estAbandon(err)) return 'délai dépassé, réessayez dans un instant';
  return null;
}
