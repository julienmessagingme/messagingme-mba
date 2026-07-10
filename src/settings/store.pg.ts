import type { Pool } from 'pg';

export interface TenantSettings {
  mbaEnabled: boolean;
}

/** Réglages par tenant (upsert). Aujourd'hui : toggle MBA on/off (intention). */
export class PgTenantSettingsStore {
  constructor(private readonly pool: Pool) {}

  async get(tenantId: string): Promise<TenantSettings> {
    const res = await this.pool.query<{ mba_enabled: boolean }>(
      `select mba_enabled from tenant_settings where tenant_id = $1`,
      [tenantId],
    );
    return { mbaEnabled: res.rows[0]?.mba_enabled ?? false };
  }

  async setMbaEnabled(tenantId: string, enabled: boolean): Promise<void> {
    await this.pool.query(
      `insert into tenant_settings (tenant_id, mba_enabled, updated_at) values ($1, $2, now())
       on conflict (tenant_id) do update set mba_enabled = excluded.mba_enabled, updated_at = now()`,
      [tenantId, enabled],
    );
  }
}
