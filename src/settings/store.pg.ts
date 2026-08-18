import type { Pool } from 'pg';
import type { BusinessHours } from '../workflow/conditions';

/** Fuseau par défaut si le tenant n'a rien réglé (marché principal FR). */
export const DEFAULT_TIMEZONE = 'Europe/Paris';
/** Horaires d'ouverture par défaut : Lun-Ven 9h-18h, week-end fermé (jour '0' = dimanche). */
export const DEFAULT_BUSINESS_HOURS: BusinessHours = {
  '0': { closed: true, open: '', close: '' },
  '1': { closed: false, open: '09:00', close: '18:00' },
  '2': { closed: false, open: '09:00', close: '18:00' },
  '3': { closed: false, open: '09:00', close: '18:00' },
  '4': { closed: false, open: '09:00', close: '18:00' },
  '5': { closed: false, open: '09:00', close: '18:00' },
  '6': { closed: true, open: '', close: '' },
};

export interface TenantSettings {
  mbaEnabled: boolean;
  /** Fuseau IANA du tenant (ex. 'Europe/Paris'). Défaut serveur si non réglé. Base de NOW / weekday / horaires. */
  timezone: string;
  /** Heures d'ouverture par jour ('0'..'6', 0 = dimanche). Défaut serveur si non réglé. */
  businessHours: BusinessHours;
  /** Toggle « Campagnes via données HubSpot » : OFF = aucun appel au connecteur. */
  hubspotListsEnabled: boolean;
  /**
   * Pause des campagnes via listes HubSpot (F3-b). Piloté ENSEMBLE avec la pause du push (F3-a) par l'action Pause du
   * toggle Synchronisation. true = campagnes listes suspendues (le gate effectif est `hubspotListsEnabled && !campaignsPaused`).
   * N'écrase jamais `hubspotListsEnabled` : la reprise (campaignsPaused -> false) restaure le réglage d'origine.
   */
  campaignsPaused: boolean;
  /** Auto-relance des échecs de livraison (F6). true = le sweeper relance 131049/131026 selon la politique de recouvrement. */
  autoRetryEnabled: boolean;
  /**
   * Durée du GEL après qu'un opérateur a pris la main, en secondes. Pendant ce temps, ni le scénario ni
   * l'agent de Meta n'écrivent au client.
   *
   * null = le client n'a rien réglé, le défaut du serveur s'applique. 0 = pas de reprise automatique,
   * la conversation reste à l'humain jusqu'à ce qu'il la rende explicitement.
   */
  controlHandbackSeconds: number | null;
  /**
   * Défaut du tenant pour la destination d'un fil après une prise en main opérateur (C.4). `resume` = rendu
   * au scénario par le sweep de handback (comportement historique) ; `inbox` = reste à l'humain, jamais rendu
   * automatiquement. null = pas de choix explicite -> repli usine `resume` (rien ne change en silence). Une
   * surcharge par conversation prime sur ce défaut.
   */
}

/** Réglages par tenant (upsert). Toggle MBA on/off + toggle import de listes HubSpot. */
export class PgTenantSettingsStore {
  constructor(private readonly pool: Pool) {}

  async get(tenantId: string): Promise<TenantSettings> {
    const res = await this.pool.query<{ mba_enabled: boolean; hubspot_lists_enabled: boolean; campaigns_paused: boolean; auto_retry_enabled: boolean; control_handback_seconds: number | null; timezone: string | null; business_hours: BusinessHours | null }>(
      `select mba_enabled, hubspot_lists_enabled, campaigns_paused, auto_retry_enabled, control_handback_seconds, timezone, business_hours from tenant_settings where tenant_id = $1`,
      [tenantId],
    );
    const r = res.rows[0];
    return {
      mbaEnabled: r?.mba_enabled ?? false,
      hubspotListsEnabled: r?.hubspot_lists_enabled ?? false,
      campaignsPaused: r?.campaigns_paused ?? false,
      autoRetryEnabled: r?.auto_retry_enabled ?? false,
      controlHandbackSeconds: r?.control_handback_seconds ?? null,
      timezone: r?.timezone ?? DEFAULT_TIMEZONE,
      businessHours: r?.business_hours ?? DEFAULT_BUSINESS_HOURS,
    };
  }

  /** Règle le fuseau IANA du tenant (validé en amont par la route). Upsert ciblé : n'écrase aucun autre réglage. */
  async setTimezone(tenantId: string, timezone: string): Promise<void> {
    await this.pool.query(
      `insert into tenant_settings (tenant_id, timezone, updated_at) values ($1, $2, now())
       on conflict (tenant_id) do update set timezone = excluded.timezone, updated_at = now()`,
      [tenantId, timezone],
    );
  }

  /** Règle les heures d'ouverture (déjà normalisées par la route). Upsert ciblé. */
  async setBusinessHours(tenantId: string, hours: BusinessHours): Promise<void> {
    await this.pool.query(
      `insert into tenant_settings (tenant_id, business_hours, updated_at) values ($1, $2::jsonb, now())
       on conflict (tenant_id) do update set business_hours = excluded.business_hours, updated_at = now()`,
      [tenantId, JSON.stringify(hours)],
    );
  }

  /** Active/désactive l'auto-relance des échecs (F6). Upsert ciblé : n'écrase aucun autre réglage. */
  async setAutoRetryEnabled(tenantId: string, enabled: boolean): Promise<void> {
    await this.pool.query(
      `insert into tenant_settings (tenant_id, auto_retry_enabled, updated_at) values ($1, $2, now())
       on conflict (tenant_id) do update set auto_retry_enabled = excluded.auto_retry_enabled, updated_at = now()`,
      [tenantId, enabled],
    );
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

  /**
   * Défaut du tenant pour la destination de reprise (C.4). `null` retire le choix explicite -> repli usine
   * `resume`. Upsert ciblé : n'écrase aucun autre réglage.
   */
  /**
   * Défaut de destination de reprise par tenant, pour les tenants donnés (C.4). Utilisé par le sweep : il
   * traite un lot de conversations de plusieurs clients et doit appliquer à chacune le défaut de SON client.
   * Les tenants sans choix explicite sont ABSENTS de la Map -> l'appelant retombe sur `resume`.
   */

  /** Active/désactive l'import de listes HubSpot. N'ÉCRASE PAS mba_enabled (upsert ciblé sur la colonne). */
  async setHubspotListsEnabled(tenantId: string, enabled: boolean): Promise<void> {
    await this.pool.query(
      `insert into tenant_settings (tenant_id, hubspot_lists_enabled, updated_at) values ($1, $2, now())
       on conflict (tenant_id) do update set hubspot_lists_enabled = excluded.hubspot_lists_enabled, updated_at = now()`,
      [tenantId, enabled],
    );
  }
}
