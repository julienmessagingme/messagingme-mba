import type { Pool } from 'pg';

export interface TenantSettings {
  mbaEnabled: boolean;
  /** Toggle « Campagnes via données HubSpot » : OFF = aucun appel au connecteur. */
  hubspotListsEnabled: boolean;
  /**
   * Durée du GEL après qu'un opérateur a pris la main, en secondes. Pendant ce temps, ni le scénario ni
   * l'agent de Meta n'écrivent au client.
   *
   * null = le client n'a rien réglé, le défaut du serveur s'applique. 0 = pas de reprise automatique,
   * la conversation reste à l'humain jusqu'à ce qu'il la rende explicitement.
   */
  controlHandbackSeconds: number | null;
}

/** Réglages par tenant (upsert). Toggle MBA on/off + toggle import de listes HubSpot. */
export class PgTenantSettingsStore {
  constructor(private readonly pool: Pool) {}

  async get(tenantId: string): Promise<TenantSettings> {
    const res = await this.pool.query<{ mba_enabled: boolean; hubspot_lists_enabled: boolean; control_handback_seconds: number | null }>(
      `select mba_enabled, hubspot_lists_enabled, control_handback_seconds from tenant_settings where tenant_id = $1`,
      [tenantId],
    );
    const r = res.rows[0];
    return {
      mbaEnabled: r?.mba_enabled ?? false,
      hubspotListsEnabled: r?.hubspot_lists_enabled ?? false,
      controlHandbackSeconds: r?.control_handback_seconds ?? null,
    };
  }

  async setMbaEnabled(tenantId: string, enabled: boolean): Promise<void> {
    await this.pool.query(
      `insert into tenant_settings (tenant_id, mba_enabled, updated_at) values ($1, $2, now())
       on conflict (tenant_id) do update set mba_enabled = excluded.mba_enabled, updated_at = now()`,
      [tenantId, enabled],
    );
  }

  /**
   * Règle la durée du gel après prise de main par un opérateur. `null` remet le défaut du serveur, `0`
   * supprime la reprise automatique. Upsert ciblé : n'écrase aucun autre réglage.
   */
  async setControlHandbackSeconds(tenantId: string, seconds: number | null): Promise<void> {
    await this.pool.query(
      `insert into tenant_settings (tenant_id, control_handback_seconds, updated_at) values ($1, $2, now())
       on conflict (tenant_id) do update set control_handback_seconds = excluded.control_handback_seconds, updated_at = now()`,
      [tenantId, seconds],
    );
  }

  /**
   * Délais de reprise par tenant, pour les tenants donnés, en MILLISECONDES. Utilisé par le balayage :
   * il lit un lot de conversations de plusieurs clients d'un coup et doit appliquer à chacune le réglage
   * de SON client. Les tenants sans réglage sont absents de la Map, l'appelant retombe sur son défaut.
   */
  async handbackMsByTenant(tenantIds: readonly string[]): Promise<Map<string, number>> {
    if (tenantIds.length === 0) return new Map();
    const res = await this.pool.query<{ tenant_id: string; control_handback_seconds: number }>(
      `select tenant_id, control_handback_seconds from tenant_settings
       where tenant_id = any($1::uuid[]) and control_handback_seconds is not null`,
      [[...tenantIds]],
    );
    return new Map(res.rows.map((r) => [r.tenant_id, r.control_handback_seconds * 1000]));
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
