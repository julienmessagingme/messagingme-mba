import type { Pool } from 'pg';
import type { PhoneNumberRecord, HubspotPortalLink } from '../http/account';

/** Accès en lecture/écriture au statut d'un numéro (page Accueil : numéro + pastille de statut). */
export class PgPhoneStatusStore {
  constructor(private readonly pool: Pool) {}

  /** Numéro principal du tenant avec son statut persisté. null si aucun numéro. */
  async getPhoneNumber(tenantId: string): Promise<PhoneNumberRecord | null> {
    const res = await this.pool.query<{
      id: string; display_phone_number: string | null; status: string | null; quality_rating: string | null; messaging_limit_tier: string | null;
      name_status: string | null; code_verification_status: string | null; throughput_level: string | null; verified_name: string | null;
      waba_health_status: string | null; account_review_status: string | null; business_verification_status: string | null; hubspot_connected: boolean;
    }>(
      `select id, display_phone_number, status, quality_rating, messaging_limit_tier,
              name_status, code_verification_status, throughput_level, verified_name,
              waba_health_status, account_review_status, business_verification_status, hubspot_connected
         from phone_numbers where tenant_id = $1 order by created_at limit 1`,
      [tenantId],
    );
    const r = res.rows[0];
    return r
      ? {
          id: r.id,
          displayPhoneNumber: r.display_phone_number,
          status: r.status,
          qualityRating: r.quality_rating,
          messagingLimitTier: r.messaging_limit_tier,
          nameStatus: r.name_status,
          codeVerificationStatus: r.code_verification_status,
          throughputLevel: r.throughput_level,
          verifiedName: r.verified_name,
          wabaHealthStatus: r.waba_health_status,
          accountReviewStatus: r.account_review_status,
          businessVerificationStatus: r.business_verification_status,
          hubspotConnected: r.hubspot_connected,
        }
      : null;
  }

  /**
   * Persiste un statut fraîchement pull. `coalesce($n, col)` : un champ absent du pull (undefined -> null)
   * NE remplace PAS la valeur connue en base. Note : `quality_rating` porte un CHECK
   * (GREEN/YELLOW/RED/UNKNOWN) ; l'appelant ne passe qu'une valeur normalisée à cet ensemble.
   * `hubspot_connected` N'EST PAS touché ici : c'est un réglage humain (toggle), pas un champ de pull Meta.
   */
  async saveStatus(
    phoneNumberId: string,
    patch: {
      status?: string; qualityRating?: string; messagingLimitTier?: string;
      nameStatus?: string; codeVerificationStatus?: string; throughputLevel?: string; verifiedName?: string;
      wabaHealthStatus?: string; accountReviewStatus?: string; businessVerificationStatus?: string;
    },
  ): Promise<void> {
    await this.pool.query(
      `update phone_numbers set
         status = coalesce($2, status),
         quality_rating = coalesce($3, quality_rating),
         messaging_limit_tier = coalesce($4, messaging_limit_tier),
         name_status = coalesce($5, name_status),
         code_verification_status = coalesce($6, code_verification_status),
         throughput_level = coalesce($7, throughput_level),
         verified_name = coalesce($8, verified_name),
         waba_health_status = coalesce($9, waba_health_status),
         account_review_status = coalesce($10, account_review_status),
         business_verification_status = coalesce($11, business_verification_status)
       where id = $1`,
      [
        phoneNumberId,
        patch.status ?? null,
        patch.qualityRating ?? null,
        patch.messagingLimitTier ?? null,
        patch.nameStatus ?? null,
        patch.codeVerificationStatus ?? null,
        patch.throughputLevel ?? null,
        patch.verifiedName ?? null,
        patch.wabaHealthStatus ?? null,
        patch.accountReviewStatus ?? null,
        patch.businessVerificationStatus ?? null,
      ],
    );
  }

  /**
   * Active/coupe la synchro HubSpot d'UN numéro (toggle admin). Scopé au tenant (un admin ne peut pas
   * flipper le numéro d'un autre client, même en forgeant l'id). Renvoie true si une ligne a été mise à jour.
   */
  async setHubspotConnected(phoneNumberId: string, tenantId: string, connected: boolean): Promise<boolean> {
    const res = await this.pool.query(
      `update phone_numbers set hubspot_connected = $3 where id = $1 and tenant_id = $2`,
      [phoneNumberId, tenantId, connected],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Portail HubSpot lié à CE tenant, lu CROSS-SCHEMA dans le connecteur mm-hubspot (schéma `mmhs`, même base/pool).
   * Jointure tenant_portals -> portals pour ramener le hub_id + le domaine du portail. `{ connected: false }` si le
   * tenant n'est mappé à aucun portail (la console proposera « Connecter HubSpot »). Lecture seule : ne touche RIEN
   * dans mmhs (le mapping du pilote reste intact).
   */
  async getHubspotPortal(tenantId: string): Promise<HubspotPortalLink> {
    const res = await this.pool.query<{ hub_id: string; hub_domain: string | null; granted_scopes: string[] | null }>(
      `select p.hub_id, p.hub_domain, p.granted_scopes
         from mmhs.tenant_portals tp
         join mmhs.portals p on p.hub_id = tp.hub_id
        where tp.tenant_id = $1
        limit 1`,
      [tenantId],
    );
    const r = res.rows[0];
    if (!r) return { connected: false };
    return { connected: true, hubId: r.hub_id, hubDomain: r.hub_domain, listsScopeGranted: (r.granted_scopes ?? []).includes('crm.lists.read') };
  }

  /**
   * La synchro HubSpot est-elle active pour le numéro (tenant + numéro d'affichage) ? Sert de GATE au push
   * d'analyse : on ne pousse au connecteur mm-hubspot QUE si true. Numéro inconnu / non trouvé -> false
   * (défensif : sans identification certaine du numéro, on ne pousse pas).
   */
  async isHubspotConnectedForNumber(tenantId: string, displayPhoneNumber: string): Promise<boolean> {
    const res = await this.pool.query<{ hubspot_connected: boolean }>(
      `select hubspot_connected from phone_numbers
         where tenant_id = $1 and display_phone_number = $2
         order by created_at asc limit 1`,
      [tenantId, displayPhoneNumber],
    );
    return res.rows[0]?.hubspot_connected ?? false;
  }
}
