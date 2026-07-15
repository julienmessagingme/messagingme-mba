import { MetaApiError } from '../meta/errors';
import type { PhoneNumberInfo, WabaInfo } from '../meta/phone-number';
import { normalizeQuality } from './service';

/**
 * Résultat d'un pull Graph du statut d'un numéro (+ santé WABA optionnelle). `ok:false` SANS throw : on distingue un
 * token invalide (authError -> rouge) d'un échec transitoire (-> gris). Pur -> testable sans réseau. Les champs Meta
 * additionnels (name/verif/throughput + santé WABA) sont TOUS optionnels : un pull partiel ne porte que ce que Meta a
 * renvoyé (coalesce à l'écriture -> un absent n'écrase pas un connu).
 */
export type PullResult =
  | {
      ok: true;
      status?: string;
      qualityRating?: string;
      messagingLimitTier?: string;
      displayPhoneNumber?: string;
      nameStatus?: string;
      codeVerificationStatus?: string;
      throughputLevel?: string;
      verifiedName?: string;
      wabaHealthStatus?: string;
      accountReviewStatus?: string;
      businessVerificationStatus?: string;
    }
  | { ok: false; authError: boolean };

/**
 * Mappe la réponse Graph -> PullResult. La qualité est TOUJOURS incluse (normalisée), y compris
 * 'UNKNOWN' : une dégradation GREEN -> UNKNOWN doit pouvoir ÉCRASER l'ancienne valeur en base
 * (sinon un vieux GREEN figé afficherait un faux vert alors que Meta ne confirme plus la qualité).
 * 'UNKNOWN' fait partie du CHECK SQL (0004) -> aucune violation. `waba` (santé du WABA, second appel Graph)
 * est optionnel : absent -> les champs WABA sont simplement omis (coalesce préserve le connu).
 */
export function pullFromInfo(info: PhoneNumberInfo, waba?: WabaInfo): PullResult {
  return {
    ok: true,
    ...(info.status !== undefined ? { status: info.status } : {}),
    qualityRating: normalizeQuality(info.qualityRating),
    ...(info.messagingLimitTier !== undefined ? { messagingLimitTier: info.messagingLimitTier } : {}),
    ...(info.displayPhoneNumber !== undefined ? { displayPhoneNumber: info.displayPhoneNumber } : {}),
    ...(info.nameStatus !== undefined ? { nameStatus: info.nameStatus } : {}),
    ...(info.codeVerificationStatus !== undefined ? { codeVerificationStatus: info.codeVerificationStatus } : {}),
    ...(info.throughputLevel !== undefined ? { throughputLevel: info.throughputLevel } : {}),
    ...(info.verifiedName !== undefined ? { verifiedName: info.verifiedName } : {}),
    ...(waba?.healthStatus !== undefined ? { wabaHealthStatus: waba.healthStatus } : {}),
    ...(waba?.accountReviewStatus !== undefined ? { accountReviewStatus: waba.accountReviewStatus } : {}),
    ...(waba?.businessVerificationStatus !== undefined ? { businessVerificationStatus: waba.businessVerificationStatus } : {}),
  };
}

/**
 * Mappe une erreur d'appel -> PullResult échec. authError = token invalide/expiré (rouge franc) :
 * code Graph 190 (OAuthException) ou HTTP 401. Le code 100 (« invalid parameter ») est générique
 * et PAS spécifiquement une auth -> il tombe en transitoire (gris), pas en rouge « token ».
 */
export function pullFromError(err: unknown): PullResult {
  const authError = err instanceof MetaApiError && (err.code === 190 || err.httpStatus === 401 || err.type === 'OAuthException');
  return { ok: false, authError };
}
