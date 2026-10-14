import { z } from 'zod';
import type { FetchLike } from './templates';
import { appelGraph } from './graph';

/**
 * Le Business Manager propriétaire, lu par `safeParse` : son identifiant désigne la cible d'une ÉCRITURE (le plafond de
 * l'agent de Meta), il ne passe pas par un `as` (relecture du 2026-10-02). Un identifiant Meta est fait de chiffres.
 */
const proprietaireSchema = z.object({ owner_business_info: z.object({ id: z.string().regex(/^\d+$/) }) });

/**
 * Le statut de la Marketing Messages API (ex-MM Lite) sur le WABA : une chaîne (`ELIGIBLE`, `ONBOARDED`...). Meta rend
 * le même champ en objet `{ status, time }` au niveau du Business Manager : les deux formes sont acceptées.
 */
const statutMmSchema = z.object({
  marketing_messages_onboarding_status: z.union([z.string().min(1), z.object({ status: z.string().min(1) })]),
});

/**
 * Les codes d'erreur de `health_status` qui disent « moyen de paiement » sur l'entité WABA. Mesuré le 2026-10-13 sur
 * quatre comptes sans carte valable : 141006, « There is an error with the payment method. This will block business
 * initiated conversations » (les modèles ne partent plus, les réponses de service si).
 */
export const CODES_PAIEMENT_META: readonly number[] = [141006];

/** La forme de `health_status` en objet, lue par `safeParse` : un champ inattendu ne casse pas la santé du compte. */
const santeSchema = z.object({
  health_status: z.object({
    can_send_message: z.string().optional(),
    entities: z.array(z.object({
      entity_type: z.string(),
      errors: z.array(z.object({ error_code: z.number() })).optional(),
    })).optional(),
  }),
});

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
  /**
   * Statut de la Marketing Messages API (`marketing_messages_onboarding_status` : ELIGIBLE / ONBOARDED / ...). Le nom
   * garde « Lite », comme la colonne `phone_numbers.marketing_messages_lite_api_status` où il s'écrit.
   */
  marketingMessagesLiteApiStatus?: string;
  /** Nom du business propriétaire du WABA (`owner_business_info.name`). */
  ownerBusinessName?: string;
  /** Son identifiant : c'est lui qui porte les plafonds de l'agent de Meta (`agent_budget`), et que Meta facture. */
  ownerBusinessId?: string;
  /**
   * Le compte est-il bloqué pour son moyen de paiement (`CODES_PAIEMENT_META` sur l'entité WABA) ? Absent quand
   * `health_status` n'est pas un objet lisible : inconnu, jamais « pas de souci ».
   */
  paiementBloque?: boolean;
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
   * Santé du WABA, statut de la Marketing Messages API et business propriétaire. `health_status` est un objet côté
   * Graph : on en extrait `can_send_message`, en tolérant une chaîne selon la version. Lève MetaApiError si la santé
   * est refusée (non-2xx).
   *
   * 🔴 Le statut de la Marketing Messages API se lit dans un appel À PART. Meta refuse EN BLOC (erreur 100) un appel
   * qui demande un champ indisponible, et l'ancien `marketing_messages_lite_api_status` est annoncé déprécié : dans
   * le même appel, son retrait aurait emporté la santé du compte et le Business Manager propriétaire, que le plafond
   * de l'agent lit par ici. Un échec de ce second appel rend un statut absent, que `saveStatus` ne retient pas.
   */
  async getWabaHealth(wabaId: string): Promise<WabaInfo> {
    const base = `${this.baseUrl}/${this.version}/${encodeURIComponent(wabaId)}`;
    const fields = 'health_status,account_review_status,business_verification_status,owner_business_info';
    const [lu, luMm] = await Promise.all([
      appelGraph(this.fetchImpl, this.token, `${base}?fields=${fields}`, { method: 'GET' }),
      appelGraph(this.fetchImpl, this.token, `${base}?fields=marketing_messages_onboarding_status`, { method: 'GET' })
        .catch(() => null),
    ]);
    const json = lu as
      | {
          health_status?: { can_send_message?: string } | string;
          account_review_status?: string; business_verification_status?: string;
          owner_business_info?: { name?: string; id?: string };
        }
      | null;
    const hs = json?.health_status;
    const healthStatus = typeof hs === 'string' ? hs : hs?.can_send_message;
    const sante = santeSchema.safeParse(json);
    // Sans entités, Meta ne dit pas pourquoi : « disponible » vaut faux, tout le reste reste inconnu (relecture du lot).
    const entites = sante.success ? sante.data.health_status.entities : undefined;
    const paiementBloque = !sante.success
      ? undefined
      : entites === undefined
        ? (sante.data.health_status.can_send_message === 'AVAILABLE' ? false : undefined)
        : entites.some((e) => e.entity_type === 'WABA' && (e.errors ?? []).some((x) => CODES_PAIEMENT_META.includes(x.error_code)));
    const mm = statutMmSchema.safeParse(luMm);
    const statutMm = mm.success ? mm.data.marketing_messages_onboarding_status : undefined;
    return {
      healthStatus,
      ...(paiementBloque !== undefined ? { paiementBloque } : {}),
      accountReviewStatus: json?.account_review_status,
      businessVerificationStatus: json?.business_verification_status,
      marketingMessagesLiteApiStatus: typeof statutMm === 'string' ? statutMm : statutMm?.status,
      ownerBusinessName: json?.owner_business_info?.name,
      ownerBusinessId: (() => {
        const lu = proprietaireSchema.safeParse(json);
        return lu.success ? lu.data.owner_business_info.id : undefined;
      })(),
    };
  }
}
