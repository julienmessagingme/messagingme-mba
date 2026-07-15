import { MetaApiError, type MetaErrorBody } from './errors';
import type { FetchLike } from './templates';

/** Champs de statut d'un numéro renvoyés par `GET /{phone_number_id}`. Tout optionnel (Meta peut omettre). */
export interface PhoneNumberInfo {
  status?: string;
  qualityRating?: string;
  messagingLimitTier?: string;
  nameStatus?: string;
  displayPhoneNumber?: string;
  /** État de la vérification du numéro (`code_verification_status` : VERIFIED / NOT_VERIFIED / EXPIRED). */
  codeVerificationStatus?: string;
  /** Débit d'envoi (`throughput.level` : STANDARD / HIGH / ...). Le champ Graph est un objet, on extrait `level`. */
  throughputLevel?: string;
  /** Nom d'affichage vérifié (`verified_name`) : le nom que voient les destinataires. */
  verifiedName?: string;
}

/** Santé du WABA (`GET /{waba_id}`). Tout optionnel (Meta peut omettre selon droits/état). */
export interface WabaInfo {
  /** Capacité d'envoi consolidée (`health_status.can_send_message` : AVAILABLE / LIMITED / BLOCKED). */
  healthStatus?: string;
  /** Revue du compte (`account_review_status` : APPROVED / PENDING / REJECTED). */
  accountReviewStatus?: string;
  /** Vérification d'entreprise (`business_verification_status` : verified / not_verified / pending). */
  businessVerificationStatus?: string;
}

/**
 * Client Graph en LECTURE d'un numéro WhatsApp. Sert au statut compte de la page Accueil.
 * Calqué sur MetaTemplateClient (Bearer token, fetch injectable, throw MetaApiError si non-2xx).
 */
export class MetaPhoneNumberClient {
  constructor(
    private readonly token: string,
    private readonly version = 'v25.0',
    private readonly fetchImpl: FetchLike = fetch,
    private readonly baseUrl = 'https://graph.facebook.com',
  ) {}

  /** `GET /{phone_number_id}?fields=status,quality_rating,messaging_limit_tier,name_status,display_phone_number,code_verification_status,throughput,verified_name`. */
  async get(phoneNumberId: string): Promise<PhoneNumberInfo> {
    const fields = 'status,quality_rating,messaging_limit_tier,name_status,display_phone_number,code_verification_status,throughput,verified_name';
    const url = `${this.baseUrl}/${this.version}/${encodeURIComponent(phoneNumberId)}?fields=${fields}`;
    const res = await this.fetchImpl(url, { method: 'GET', headers: { authorization: `Bearer ${this.token}` } });
    const json = (await res.json().catch(() => null)) as
      | {
          status?: string; quality_rating?: string; messaging_limit_tier?: string; name_status?: string; display_phone_number?: string;
          code_verification_status?: string; throughput?: { level?: string }; verified_name?: string; error?: MetaErrorBody;
        }
      | null;
    if (!res.ok) throw new MetaApiError(res.status, json?.error ?? null);
    return {
      status: json?.status,
      qualityRating: json?.quality_rating,
      messagingLimitTier: json?.messaging_limit_tier,
      nameStatus: json?.name_status,
      displayPhoneNumber: json?.display_phone_number,
      codeVerificationStatus: json?.code_verification_status,
      throughputLevel: json?.throughput?.level,
      verifiedName: json?.verified_name,
    };
  }

  /**
   * `GET /{waba_id}?fields=health_status,account_review_status,business_verification_status`. Santé globale du WABA
   * (page Accueil). `health_status` est un OBJET côté Graph -> on extrait `can_send_message` (tolérant si Meta
   * renvoie déjà une chaîne selon la version). Throw MetaApiError si non-2xx (même contrat que `get`).
   */
  async getWabaHealth(wabaId: string): Promise<WabaInfo> {
    const fields = 'health_status,account_review_status,business_verification_status';
    const url = `${this.baseUrl}/${this.version}/${encodeURIComponent(wabaId)}?fields=${fields}`;
    const res = await this.fetchImpl(url, { method: 'GET', headers: { authorization: `Bearer ${this.token}` } });
    const json = (await res.json().catch(() => null)) as
      | {
          health_status?: { can_send_message?: string } | string;
          account_review_status?: string; business_verification_status?: string; error?: MetaErrorBody;
        }
      | null;
    if (!res.ok) throw new MetaApiError(res.status, json?.error ?? null);
    const hs = json?.health_status;
    const healthStatus = typeof hs === 'string' ? hs : hs?.can_send_message;
    return {
      healthStatus,
      accountReviewStatus: json?.account_review_status,
      businessVerificationStatus: json?.business_verification_status,
    };
  }
}
