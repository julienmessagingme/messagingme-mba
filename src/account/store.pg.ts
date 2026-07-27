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
      waba_health_status: string | null; account_review_status: string | null; business_verification_status: string | null;
      marketing_messages_lite_api_status: string | null; owner_business_name: string | null; hubspot_connected: boolean;
      hubspot_paused_at: string | null;
    }>(
      `select id, display_phone_number, status, quality_rating, messaging_limit_tier,
              name_status, code_verification_status, throughput_level, verified_name,
              waba_health_status, account_review_status, business_verification_status,
              marketing_messages_lite_api_status, owner_business_name, hubspot_connected,
              hubspot_paused_at::text as hubspot_paused_at
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
         owner_business_name = coalesce($13, owner_business_name)
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
   * Active/coupe la synchro HubSpot d'UN numéro (toggle admin). Scopé au tenant (un admin ne peut pas
   * flipper le numéro d'un autre client, même en forgeant l'id). Renvoie true si une ligne a été mise à jour.
   */
  async setHubspotConnected(
    phoneNumberId: string,
    tenantId: string,
    connected: boolean,
  ): Promise<{ updated: boolean; resumedFrom: string | null }> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      // Verrou consultatif PAR TENANT (relâché en fin de transaction) : sérialise tous les toggles HubSpot d'un même
      // tenant, y compris sur des numéros DIFFÉRENTS. Sans lui, deux toggles simultanés sur deux numéros du tenant
      // calculeraient chacun l'agrégat campaigns_paused ci-dessous avant de voir le commit de l'autre -> valeur figée
      // fausse entre deux commits. Ordre de prise TOUJOURS lock tenant PUIS FOR UPDATE ligne -> pas de deadlock.
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [tenantId]);
      // FOR UPDATE : sérialise deux clics/onglets admin concurrents sur le même numéro (pas de course pause/resume).
      const cur = await client.query<{ hubspot_connected: boolean; hubspot_paused_at: string | null }>(
        `select hubspot_connected, hubspot_paused_at::text as hubspot_paused_at
         from phone_numbers where id = $1 and tenant_id = $2 for update`,
        [phoneNumberId, tenantId],
      );
      const row = cur.rows[0];
      if (!row) { await client.query('rollback'); return { updated: false, resumedFrom: null }; }
      const startingPause = !connected && row.hubspot_connected; // transition ACTIF -> OFF : c'est le DÉBUT d'une pause
      // resumedFrom : l'instant de pause capturé AVANT écrasement, non-null seulement si on REPREND depuis une pause.
      const resumedFrom = connected ? row.hubspot_paused_at : null;
      await client.query(
        `update phone_numbers set hubspot_connected = $3,
           hubspot_paused_at = case when $4 then now() when $3 then null else hubspot_paused_at end
         where id = $1 and tenant_id = $2`,
        [phoneNumberId, tenantId, connected, startingPause],
      );
      // F3-b : la MÊME action Pause pilote AUSSI le flag campagnes-via-listes du tenant, dans la MÊME transaction
      // (aucun drift possible avec hubspot_paused_at). campaigns_paused est PAR TENANT alors que la pause est PAR
      // numéro : on le calcule donc par AGRÉGATION (« au moins un numéro du tenant est en pause »), PAS comme le miroir
      // du seul numéro togglé, sinon reprendre un numéro rouvrirait les campagnes alors qu'un autre reste en pause
      // (tenant multi-numéros). L'EXISTS lit l'état APRÈS l'update ci-dessus (read-your-writes intra-transaction) et
      // emploie la même définition de « en pause » que hubspot_paused_at (connected=false ET paused_at non-null), pour
      // ne pas bloquer sur un numéro jamais activé. Upsert ciblé : n'écrase aucun autre réglage du tenant.
      await client.query(
        `insert into tenant_settings (tenant_id, campaigns_paused, updated_at)
         values ($1, exists(select 1 from phone_numbers where tenant_id = $1 and hubspot_connected = false and hubspot_paused_at is not null), now())
         on conflict (tenant_id) do update set campaigns_paused = excluded.campaigns_paused, updated_at = now()`,
        [tenantId],
      );
      await client.query('commit');
      return { updated: true, resumedFrom };
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Déconnexion complète HubSpot pour un tenant (candidat 2), reflet LOCAL de l'unlink du portail côté mm-hubspot. Le
   * portail est lié PAR TENANT alors que la synchro est PAR numéro : une déconnexion coupe donc TOUS les numéros du
   * tenant (hubspot_connected=false). Ce N'EST PAS une pause -> hubspot_paused_at remis à null (aucun rattrapage à
   * prévoir, le portail est parti). Recalcule campaigns_paused (agrégat : plus aucun numéro en pause -> false). Verrou
   * consultatif tenant (même clé que setHubspotConnected) pour sérialiser avec un toggle concurrent. À n'appeler
   * QU'APRÈS le succès de l'unlink côté connecteur (l'appelant garantit l'ordre, anti-drift). `updated` = au moins un
   * numéro affecté.
   */
  async disconnectHubspotTenant(tenantId: string): Promise<{ updated: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [tenantId]);
      const r = await client.query(
        `update phone_numbers set hubspot_connected = false, hubspot_paused_at = null where tenant_id = $1`,
        [tenantId],
      );
      await client.query(
        `insert into tenant_settings (tenant_id, campaigns_paused, updated_at)
         values ($1, exists(select 1 from phone_numbers where tenant_id = $1 and hubspot_connected = false and hubspot_paused_at is not null), now())
         on conflict (tenant_id) do update set campaigns_paused = excluded.campaigns_paused, updated_at = now()`,
        [tenantId],
      );
      await client.query('commit');
      return { updated: (r.rowCount ?? 0) > 0 };
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
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
   * État de synchro HubSpot du numéro (tenant + numéro d'affichage), lu en UN SEUL snapshot. Sert de GATE au push
   * d'analyse (`connected`) ET de décision de rattrapage (`pausedAt` non-null = en pause). Le lire d'un coup ferme
   * la course TOCTOU qu'un gate booléen + une re-lecture séparée « en pause ? » laissait ouverte (une reprise
   * intercalée entre les deux faisait rater la marque). Numéro inconnu -> {connected:false, pausedAt:null} (jamais
   * activé, défensif : on ne pousse pas et on ne marque pas un historique jamais demandé).
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
}
