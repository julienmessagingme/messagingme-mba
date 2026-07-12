import { MetaApiError, type MetaErrorBody } from './errors';
import type { FetchLike } from './templates';

/** Champs de statut d'un numéro renvoyés par `GET /{phone_number_id}`. Tout optionnel (Meta peut omettre). */
export interface PhoneNumberInfo {
  status?: string;
  qualityRating?: string;
  messagingLimitTier?: string;
  nameStatus?: string;
  displayPhoneNumber?: string;
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

  /** `GET /{phone_number_id}?fields=status,quality_rating,messaging_limit_tier,name_status,display_phone_number`. */
  async get(phoneNumberId: string): Promise<PhoneNumberInfo> {
    const fields = 'status,quality_rating,messaging_limit_tier,name_status,display_phone_number';
    const url = `${this.baseUrl}/${this.version}/${encodeURIComponent(phoneNumberId)}?fields=${fields}`;
    const res = await this.fetchImpl(url, { method: 'GET', headers: { authorization: `Bearer ${this.token}` } });
    const json = (await res.json().catch(() => null)) as
      | { status?: string; quality_rating?: string; messaging_limit_tier?: string; name_status?: string; display_phone_number?: string; error?: MetaErrorBody }
      | null;
    if (!res.ok) throw new MetaApiError(res.status, json?.error ?? null);
    return {
      status: json?.status,
      qualityRating: json?.quality_rating,
      messagingLimitTier: json?.messaging_limit_tier,
      nameStatus: json?.name_status,
      displayPhoneNumber: json?.display_phone_number,
    };
  }
}
