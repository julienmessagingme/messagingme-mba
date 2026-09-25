import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { PgTenantSettingsStore } from '../src/settings/store.pg';
import { DEFAULT_BUSINESS_HOURS } from '../src/settings/store.pg';

/**
 * Les douze setters de `PgTenantSettingsStore` passent par `poser` (audit ponytail du 2026-09-25). Ce test
 * fige, setter par setter, l'upsert CIBLÉ qu'ils envoyaient chacun à la main : même colonne, même paramètre,
 * et la conversion `::jsonb` des heures d'ouverture. Un upsert qui écrirait une autre colonne, ou qui en
 * écraserait une voisine, changerait le texte comparé ici.
 */
function fauxPool() {
  const appels: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      appels.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Pool;
  return { pool, appels };
}

const upsert = (colonne: string, valeur = '$2') =>
  `insert into tenant_settings (tenant_id, ${colonne}, updated_at) values ($1, ${valeur}, now()) `
  + `on conflict (tenant_id) do update set ${colonne} = excluded.${colonne}, updated_at = now()`;

describe('PgTenantSettingsStore : un setter écrit SA colonne, et seulement elle', () => {
  const T = '11111111-1111-1111-1111-111111111111';
  const cas: Array<[string, (s: PgTenantSettingsStore) => Promise<void>, string, unknown]> = [
    ['hubspot_actif', (s) => s.setHubspotActif(T, true), upsert('hubspot_actif'), true],
    ['mba_relais_cle_id', (s) => s.setMbaRelaisCleId(T, 'cle-1'), upsert('mba_relais_cle_id'), 'cle-1'],
    ['agents_peuvent_prendre', (s) => s.setAgentsPeuventPrendre(T, false), upsert('agents_peuvent_prendre'), false],
    ['mention_ia_frequence', (s) => s.setMentionIaFrequence(T, 'jamais'), upsert('mention_ia_frequence'), 'jamais'],
    ['optout_request_id', (s) => s.setOptoutRequestId(T, null), upsert('optout_request_id'), null],
    ['mba_handoff_mode', (s) => s.setMbaHandoffMode(T, 'never'), upsert('mba_handoff_mode'), 'never'],
    ['agent_transfert_mode', (s) => s.setAgentTransfertMode(T, 'always'), upsert('agent_transfert_mode'), 'always'],
    ['timezone', (s) => s.setTimezone(T, 'Europe/Paris'), upsert('timezone'), 'Europe/Paris'],
    ['business_hours', (s) => s.setBusinessHours(T, DEFAULT_BUSINESS_HOURS), upsert('business_hours', '$2::jsonb'), JSON.stringify(DEFAULT_BUSINESS_HOURS)],
    ['mba_enabled', (s) => s.setMbaEnabled(T, true), upsert('mba_enabled'), true],
    ['control_handback_seconds', (s) => s.setControlHandbackSeconds(T, 0), upsert('control_handback_seconds'), 0],
    ['hubspot_lists_enabled', (s) => s.setHubspotListsEnabled(T, true), upsert('hubspot_lists_enabled'), true],
  ];

  it.each(cas)('%s', async (_colonne, appeler, sql, valeur) => {
    const { pool, appels } = fauxPool();
    await appeler(new PgTenantSettingsStore(pool));
    expect(appels).toEqual([{ sql, params: [T, valeur] }]);
  });
});
