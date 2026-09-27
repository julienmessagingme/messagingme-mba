import type { FetchLike } from './templates';
import { appelGraph } from './graph';

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
  /** Statut d'onboarding de l'API MM Lite (`marketing_messages_lite_api_status` : ONBOARDED / ...). */
  marketingMessagesLiteApiStatus?: string;
  /** Nom du business propriétaire du WABA (`owner_business_info.name`). */
  ownerBusinessName?: string;
}

/** Client Graph en lecture d'un numéro WhatsApp (statut du compte sur l'Accueil). Lève MetaApiError si non-2xx. */
export class MetaPhoneNumberClient {
  constructor(
    private readonly token: string,
    private readonly version = 'v25.0',
    private readonly fetchImpl: FetchLike = fetch,
    private readonly baseUrl = 'https://graph.facebook.com',
  ) {}

  async get(phoneNumberId: string): Promise<PhoneNumberInfo> {
    const fields = 'status,quality_rating,messaging_limit_tier,name_status,display_phone_number,code_verification_status,throughput,verified_name';
    const url = `${this.baseUrl}/${this.version}/${encodeURIComponent(phoneNumberId)}?fields=${fields}`;
    const json = (await appelGraph(this.fetchImpl, this.token, url, { method: 'GET' })) as
      | {
          status?: string; quality_rating?: string; messaging_limit_tier?: string; name_status?: string; display_phone_number?: string;
          code_verification_status?: string; throughput?: { level?: string }; verified_name?: string;
        }
      | null;
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
   * La photo de profil WhatsApp du numéro (`GET /{phone_number_id}/whatsapp_business_profile`), celle que voient
   * les destinataires. L'URL rendue est signée et expire : elle se relit à l'affichage, jamais en base.
   * `null` quand le numéro n'a pas de photo (Meta rend alors l'objet sans le champ), cas courant au début.
   */
  async photoDeProfil(phoneNumberId: string): Promise<string | null> {
    const url = `${this.baseUrl}/${this.version}/${encodeURIComponent(phoneNumberId)}/whatsapp_business_profile?fields=profile_picture_url`;
    const json = (await appelGraph(this.fetchImpl, this.token, url, { method: 'GET' })) as
      | { data?: Array<{ profile_picture_url?: string }> }
      | null;
    const u = json?.data?.[0]?.profile_picture_url;
    return typeof u === 'string' && u.trim() !== '' ? u : null;
  }

  /**
   * Santé du WABA, statut MM Lite et business propriétaire. `health_status` est un objet côté Graph : on en
   * extrait `can_send_message`, en tolérant une chaîne selon la version. Lève MetaApiError si non-2xx.
   */
  async getWabaHealth(wabaId: string): Promise<WabaInfo> {
    const fields = 'health_status,account_review_status,business_verification_status,marketing_messages_lite_api_status,owner_business_info';
    const url = `${this.baseUrl}/${this.version}/${encodeURIComponent(wabaId)}?fields=${fields}`;
    const json = (await appelGraph(this.fetchImpl, this.token, url, { method: 'GET' })) as
      | {
          health_status?: { can_send_message?: string } | string;
          account_review_status?: string; business_verification_status?: string;
          marketing_messages_lite_api_status?: string;
          owner_business_info?: { name?: string; id?: string };
        }
      | null;
    const hs = json?.health_status;
    const healthStatus = typeof hs === 'string' ? hs : hs?.can_send_message;
    return {
      healthStatus,
      accountReviewStatus: json?.account_review_status,
      businessVerificationStatus: json?.business_verification_status,
      marketingMessagesLiteApiStatus: json?.marketing_messages_lite_api_status,
      ownerBusinessName: json?.owner_business_info?.name,
    };
  }
}
