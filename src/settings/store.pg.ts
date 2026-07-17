import type { Pool } from 'pg';

export interface TenantSettings {
  mbaEnabled: boolean;
  /** Toggle « Campagnes via données HubSpot » : OFF = aucun appel au connecteur. */
  hubspotListsEnabled: boolean;
}

/** Réglages par tenant (upsert). Toggle MBA on/off + toggle import de listes HubSpot. */
export class PgTenantSettingsStore {
  constructor(private readonly pool: Pool) {}

  async get(tenantId: string): Promise<TenantSettings> {
    const res = await this.pool.query<{ mba_enabled: boolean; hubspot_lists_enabled: boolean }>(
      `select mba_enabled, hubspot_lists_enabled from tenant_settings where tenant_id = $1`,
      [tenantId],
    );
    const r = res.rows[0];
    return { mbaEnabled: r?.mba_enabled ?? false, hubspotListsEnabled: r?.hubspot_lists_enabled ?? false };
  }

  async setMbaEnabled(tenantId: string, enabled: boolean): Promise<void> {
    await this.pool.query(
      `insert into tenant_settings (tenant_id, mba_enabled, updated_at) values ($1, $2, now())
       on conflict (tenant_id) do update set mba_enabled = excluded.mba_enabled, updated_at = now()`,
      [tenantId, enabled],
    );
  }

  /** Active/désactive l'import de listes HubSpot. N'ÉCRASE PAS mba_enabled (upsert ciblé sur la colonne). */
  async setHubspotListsEnabled(tenantId: string, enabled: boolean): Promise<void> {
    await this.pool.query(
      `insert into tenant_settings (tenant_id, hubspot_lists_enabled, updated_at) values ($1, $2, now())
       on conflict (tenant_id) do update set hubspot_lists_enabled = excluded.hubspot_lists_enabled, updated_at = now()`,
      [tenantId, enabled],
    );
  }
}
