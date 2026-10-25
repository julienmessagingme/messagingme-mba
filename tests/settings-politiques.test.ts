import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  DEFAULT_BUSINESS_HOURS,
  DEFAULT_TIMEZONE,
  PgTenantSettingsStore,
} from '../src/settings/store.pg';
import type { BusinessHours } from '../src/workflow/conditions';

class PoolLie {
  readonly appels: Array<{ sql: string; params: unknown[] }> = [];

  constructor(private readonly lignes: Array<Record<string, unknown>>) {}

  async query(sql: string, params: unknown[]) {
    this.appels.push({ sql, params });
    return { rows: this.lignes };
  }
}

describe('PgTenantSettingsStore.horairesEffectifs', () => {
  it('applique les deux défauts sans exposer une ligne de réglages absente', async () => {
    const pool = new PoolLie([]);
    const store = new PgTenantSettingsStore(pool as unknown as Pool);

    expect(await store.horairesEffectifs('tenant-1')).toEqual({
      timezone: DEFAULT_TIMEZONE,
      businessHours: DEFAULT_BUSINESS_HOURS,
    });
    expect(pool.appels).toEqual([{
      sql: 'select * from tenant_settings where tenant_id = $1',
      params: ['tenant-1'],
    }]);
  });

  it('rend ensemble le fuseau et les horaires persistés en gardant le pool lié à son instance', async () => {
    const businessHours: BusinessHours = {
      '0': { closed: true, open: '', close: '' },
      '1': { closed: false, open: '10:00', close: '19:00' },
      '2': { closed: false, open: '10:00', close: '19:00' },
      '3': { closed: false, open: '10:00', close: '19:00' },
      '4': { closed: false, open: '10:00', close: '19:00' },
      '5': { closed: false, open: '10:00', close: '19:00' },
      '6': { closed: true, open: '', close: '' },
    };
    const pool = new PoolLie([{ timezone: 'America/New_York', business_hours: businessHours }]);
    const store = new PgTenantSettingsStore(pool as unknown as Pool);

    expect(await store.horairesEffectifs('tenant-2')).toEqual({
      timezone: 'America/New_York',
      businessHours,
    });
  });
});
