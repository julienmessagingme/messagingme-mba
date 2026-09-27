import { MetaApiError } from '../meta/errors';
import type { PhoneNumberInfo, WabaInfo } from '../meta/phone-number';
import { normalizeQuality } from './service';

/**
 * Résultat d'un pull Graph du statut d'un numéro (et de la santé du WABA). `ok:false` sans throw : un token invalide
 * (authError, rouge) se distingue d'un échec transitoire (gris). Les champs Meta sont tous optionnels : un absent
 * n'écrase pas un connu (coalesce à l'écriture).
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
      marketingMessagesLiteApiStatus?: string;
      ownerBusinessName?: string;
    }
  | { ok: false; authError: boolean };

/** Champs persistables d'un pull réussi, ce que saveStatus écrit en coalesce. */
export type PhoneStatusPatch = Omit<Extract<PullResult, { ok: true }>, 'ok'>;

/**
 * Mappe la réponse Graph en PullResult. La qualité est toujours incluse, `UNKNOWN` compris : une dégradation de
 * GREEN vers UNKNOWN doit écraser l'ancienne valeur, sinon un vieux vert figé resterait affiché.
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
    ...(waba?.marketingMessagesLiteApiStatus !== undefined ? { marketingMessagesLiteApiStatus: waba.marketingMessagesLiteApiStatus } : {}),
    ...(waba?.ownerBusinessName !== undefined ? { ownerBusinessName: waba.ownerBusinessName } : {}),
  };
}

/**
 * Mappe une erreur d'appel en échec. authError = token invalide ou expiré : code Graph 190 (OAuthException) ou
 * HTTP 401. Le code 100 (« invalid parameter ») est générique et tombe en transitoire.
 */
export function pullFromError(err: unknown): PullResult {
  const authError = err instanceof MetaApiError && (err.code === 190 || err.httpStatus === 401 || err.type === 'OAuthException');
  return { ok: false, authError };
}
