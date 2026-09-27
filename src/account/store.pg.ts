import type { Pool, PoolClient } from 'pg';
import { enTransaction } from '../db/transaction';
import type { PhoneNumberRecord, HubspotPortalLink } from './types';

/** Accès en lecture/écriture au statut d'un numéro (page Accueil : numéro + pastille de statut). */
export class PgPhoneStatusStore {
  constructor(private readonly pool: Pool) {}

  /** Numéro principal de l'espace avec son statut persisté. null si aucun numéro. */
  async getPhoneNumber(tenantId: string): Promise<PhoneNumberRecord | null> {
    const res = await this.pool.query<{
      id: string; display_phone_number: string | null; status: string | null; quality_rating: string | null; messaging_limit_tier: string | null;
      name_status: string | null; code_verification_status: string | null; throughput_level: string | null; verified_name: string | null;
      waba_health_status: string | null; account_review_status: string | null; business_verification_status: string | null;
      marketing_messages_lite_api_status: string | null; owner_business_name: string | null; hubspot_connected: boolean;
      hubspot_paused_at: string | null; delie_le: Date | null;
    }>(
      `select id, display_phone_number, status, quality_rating, messaging_limit_tier,
              name_status, code_verification_status, throughput_level, verified_name,
              waba_health_status, account_review_status, business_verification_status,
              marketing_messages_lite_api_status, owner_business_name, hubspot_connected,
              hubspot_paused_at::text as hubspot_paused_at, delie_le
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
          marketingMessagesLiteApiStatus: r.marketing_messages_lite_api_status,
          ownerBusinessName: r.owner_business_name,
          hubspotConnected: r.hubspot_connected,
          hubspotPausedAt: r.hubspot_paused_at,
          delieLe: r.delie_le ? r.delie_le.toISOString() : null,
        }
      : null;
  }

  /**
   * Persiste un statut fraîchement relevé. `coalesce($n, col)` : un champ absent du pull ne remplace pas la valeur
   * connue. `quality_rating` porte un CHECK : l'appelant n'y passe qu'une valeur normalisée. `hubspot_connected`
   * n'est pas touché : c'est un réglage humain.
   */
  async saveStatus(
    phoneNumberId: string,
    patch: {
      status?: string; qualityRating?: string; messagingLimitTier?: string;
      nameStatus?: string; codeVerificationStatus?: string; throughputLevel?: string; verifiedName?: string;
      wabaHealthStatus?: string; accountReviewStatus?: string; businessVerificationStatus?: string;
      marketingMessagesLiteApiStatus?: string; ownerBusinessName?: string;
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
         business_verification_status = coalesce($11, business_verification_status),
         marketing_messages_lite_api_status = coalesce($12, marketing_messages_lite_api_status),
         owner_business_name = coalesce($13, owner_business_name),
         -- Horodate le RELEVÉ, pas la modification : c'est ce qui fait tourner le tourniquet du balayage
         -- (lot 7). Un pull qui ne change rien doit quand même faire passer ce numéro en queue, sinon les
         -- numéros stables seraient relus en boucle et les autres jamais.
         status_checked_at = now()
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
        patch.marketingMessagesLiteApiStatus ?? null,
        patch.ownerBusinessName ?? null,
      ],
    );
  }

  /**
   * Active ou coupe la synchro HubSpot d'un numéro. 🔴 Filtré sur l'espace : un admin ne peut pas basculer le numéro
   * d'un autre client en forgeant l'id.
   */
  async setHubspotConnected(
    phoneNumberId: string,
    tenantId: string,
    connected: boolean,
  ): Promise<{ updated: boolean; resumedFrom: string | null }> {
    return enTransaction(this.pool, async (client) => {
      // Verrou consultatif par espace : sérialise les bascules d'un même espace, même sur des numéros différents,
      // sinon l'agrégat `campaigns_paused` serait calculé sur un état périmé. Toujours verrou d'espace puis FOR
      // UPDATE ligne : pas d'interblocage.
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [tenantId]);
      // FOR UPDATE : sérialise deux clics concurrents sur le même numéro.
      const cur = await client.query<{ hubspot_connected: boolean; hubspot_paused_at: string | null }>(
        `select hubspot_connected, hubspot_paused_at::text as hubspot_paused_at
         from phone_numbers where id = $1 and tenant_id = $2 for update`,
        [phoneNumberId, tenantId],
      );
      const row = cur.rows[0];
      if (!row) return { updated: false, resumedFrom: null };
      const startingPause = !connected && row.hubspot_connected; // passage d'actif à coupé : début d'une pause
      // resumedFrom : l'instant de pause lu avant écrasement, non nul seulement si on reprend depuis une pause.
      const resumedFrom = connected ? row.hubspot_paused_at : null;
      await client.query(
        `update phone_numbers set hubspot_connected = $3,
           hubspot_paused_at = case when $4 then now() when $3 then null else hubspot_paused_at end
         where id = $1 and tenant_id = $2`,
        [phoneNumberId, tenantId, connected, startingPause],
      );
      await this.recomputeCampaignsPaused(client, tenantId);
      return { updated: true, resumedFrom };
    });
  }

  /**
   * Déconnexion HubSpot complète d'un espace, reflet local de l'unlink du portail côté mm-hubspot. Le portail est
   * lié par espace, la synchro par numéro : tous les numéros sont coupés, sans pause (`hubspot_paused_at` à null,
   * rien à rattraper). Même verrou consultatif que setHubspotConnected. À n'appeler qu'après le succès de l'unlink.
   */
  async disconnectHubspotTenant(tenantId: string): Promise<{ updated: boolean }> {
    return enTransaction(this.pool, async (client) => {
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [tenantId]);
      const r = await client.query(
        `update phone_numbers set hubspot_connected = false, hubspot_paused_at = null where tenant_id = $1`,
        [tenantId],
      );
      await this.recomputeCampaignsPaused(client, tenantId);
      return { updated: (r.rowCount ?? 0) > 0 };
    });
  }

  /**
   * Portail HubSpot lié à cet espace, lu dans le schéma `mmhs` du connecteur (même base), en lecture seule.
   * `{ connected: false }` si aucun portail n'est mappé.
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
   * État de synchro HubSpot du numéro en un seul instantané : gate du push (`connected`) et décision de rattrapage
   * (`pausedAt`). Les lire ensemble ferme la course avec une reprise intercalée. Numéro inconnu : ni push ni marque.
   */
  async getHubspotGateStatus(tenantId: string, displayPhoneNumber: string): Promise<{ connected: boolean; pausedAt: string | null }> {
    const res = await this.pool.query<{ hubspot_connected: boolean; hubspot_paused_at: string | null }>(
      `select hubspot_connected, hubspot_paused_at::text as hubspot_paused_at from phone_numbers
         where tenant_id = $1 and display_phone_number = $2
         order by created_at asc limit 1`,
      [tenantId, displayPhoneNumber],
    );
    const r = res.rows[0];
    return { connected: r?.hubspot_connected ?? false, pausedAt: r?.hubspot_paused_at ?? null };
  }

  /**
   * Recalcule `tenant_settings.campaigns_paused` dans la transaction en cours. Le drapeau est par espace, la pause
   * par numéro : il vaut « au moins un numéro en pause », jamais le miroir du seul numéro basculé (reprendre l'un
   * rouvrirait les campagnes alors qu'un autre reste en pause). L'EXISTS lit l'état après l'update appelant.
   * Définition unique de « en pause », partagée par la pause d'un numéro et la déconnexion du portail.
   */
  private async recomputeCampaignsPaused(client: PoolClient, tenantId: string): Promise<void> {
    await client.query(
      `insert into tenant_settings (tenant_id, campaigns_paused, updated_at)
       values ($1, exists(select 1 from phone_numbers where tenant_id = $1 and hubspot_connected = false and hubspot_paused_at is not null), now())
       on conflict (tenant_id) do update set campaigns_paused = excluded.campaigns_paused, updated_at = now()`,
      [tenantId],
    );
  }
}
