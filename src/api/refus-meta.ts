import { MetaApiError } from '../meta/errors';
import type { CodeApi } from './erreurs';

/**
 * CE QU'UNE ERREUR DE META VEUT DIRE POUR UN APPELANT DE L'API (lot 17) : un seul classement, partagé par le gestionnaire
 * commun de `/v1` (`src/server.ts`), la création et la lecture d'un modèle (`refusDeMeta`) et l'envoi d'un message
 * (`src/http/v1-messages.ts`). Sans lui, la même cause portait un code différent selon la route qui l'avait vue.
 *
 *  - le JETON de l'espace refusé (401, code 190) : 409 `meta_auth_failed`, le compte est à reconnecter ;
 *  - un refus PASSAGER (limite, panne de Meta) : 429 `rate_limited`, avec le délai à attendre. Le transport l'a déjà
 *    rejoué plusieurs fois (`withRetry`) : s'il arrive ici, il a duré, et c'est à l'appelant de réessayer plus tard ;
 *  - tout autre refus : 422 `meta_rejected`, avec le numéro de Meta (`metaCode`) quand il en donne un.
 *
 * ⚠️ Un refus passager n'est jamais `meta_rejected` : ce code dit « Meta a refusé la demande, ne la rejouez pas telle
 * quelle », et un intégrateur qui le croit ne réessaierait jamais un message que Meta aurait pris une minute plus tard.
 */
export interface ClasseMeta {
  statut: 409 | 422 | 429;
  code: Extract<CodeApi, 'meta_auth_failed' | 'rate_limited' | 'meta_rejected'>;
  /** Sur `meta_rejected` : le numéro d'erreur de Meta, `null` s'il n'en donne pas. */
  metaCode: number | null;
  /** Sur `rate_limited` : les secondes à attendre (`Retry-After` de Meta, sinon 30). */
  reessayerDansS?: number;
}

export function classerErreurMeta(err: MetaApiError): ClasseMeta {
  if (err.httpStatus === 401 || err.code === 190) return { statut: 409, code: 'meta_auth_failed', metaCode: null };
  if (err.retryable) {
    const s = err.retryAfterMs !== undefined ? Math.max(1, Math.ceil(err.retryAfterMs / 1000)) : 30;
    return { statut: 429, code: 'rate_limited', metaCode: null, reessayerDansS: s };
  }
  return { statut: 422, code: 'meta_rejected', metaCode: err.code ?? null };
}
