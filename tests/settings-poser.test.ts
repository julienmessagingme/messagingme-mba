import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { PgTenantSettingsStore } from '../src/settings/store.pg';
import { DEFAULT_BUSINESS_HOURS } from '../src/settings/store.pg';

/**
 * Les setters de `PgTenantSettingsStore` passent tous par `poser` (audit ponytail du 2026-09-25). Ce test
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
    ['salesforce_actif', (s) => s.setSalesforceActif(T, true), upsert('salesforce_actif'), true],
    ['mba_relais_cle_id', (s) => s.setMbaRelaisCleId(T, 'cle-1'), upsert('mba_relais_cle_id'), 'cle-1'],
    ['agents_peuvent_prendre', (s) => s.setAgentsPeuventPrendre(T, false), upsert('agents_peuvent_prendre'), false],
    ['mention_ia_frequence', (s) => s.setMentionIaFrequence(T, 'jamais'), upsert('mention_ia_frequence'), 'jamais'],
    ['optout_request_id', (s) => s.setOptoutRequestId(T, null), upsert('optout_request_id'), null],
    ['mba_handoff_mode', (s) => s.setMbaHandoffMode(T, 'never'), upsert('mba_handoff_mode'), 'never'],
    ['agent_transfert_mode', (s) => s.setAgentTransfertMode(T, 'always'), upsert('agent_transfert_mode'), 'always'],
    ['timezone', (s) => s.setTimezone(T, 'Europe/Paris'), upsert('timezone'), 'Europe/Paris'],
    ['business_hours', (s) => s.setBusinessHours(T, DEFAULT_BUSINESS_HOURS), upsert('business_hours', '$2::jsonb'), JSON.stringify(DEFAULT_BUSINESS_HOURS)],
    ['control_handback_seconds', (s) => s.setControlHandbackSeconds(T, 0), upsert('control_handback_seconds'), 0],
    ['hubspot_lists_enabled', (s) => s.setHubspotListsEnabled(T, true), upsert('hubspot_lists_enabled'), true],
  ];

  it.each(cas)('%s', async (_colonne, appeler, sql, valeur) => {
    const { pool, appels } = fauxPool();
    await appeler(new PgTenantSettingsStore(pool));
    expect(appels).toEqual([{ sql, params: [T, valeur] }]);
  });

  /**
   * 🔴 DEUX EXCEPTIONS, ET ELLES SONT DÉCIDÉES (RC6, migration 0217). `mba_enabled` écrit AUSSI le mode du répondeur,
   * dans la même instruction : allumer quand personne ne répond passe en `mba`, éteindre en `mba` passe en `equipe`.
   * Et il ne touche PLUS l'agent IA répondeur : allumé, l'agent de Meta est en veille, il ne le remplace pas.
   * Ce que la base en fait vraiment : `tests/integration/repondeur.integration.test.ts`, en CI.
   */
  it('mba_enabled : sa colonne et la règle du mode, jamais l’agent IA répondeur', async () => {
    const { pool, appels } = fauxPool();
    await new PgTenantSettingsStore(pool).setMbaEnabled(T, true);
    expect(appels).toHaveLength(1);
    const [a] = appels;
    expect(a?.params).toEqual([T, true]);
    expect(a?.sql).toContain('mba_enabled = excluded.mba_enabled');
    expect(a?.sql).toContain("when not excluded.mba_enabled and tenant_settings.repondeur_mode = 'mba' then 'equipe'");
    expect(a?.sql).toContain("when excluded.mba_enabled and (tenant_settings.repondeur_mode = 'equipe'");
    // 🔴 Avant RC6 : `repondeur_agent_id = case when excluded.mba_enabled then null ...`. Revenu, il éteindrait l'agent
    // IA répondeur chaque fois que quelqu'un rallume l'agent de Meta.
    expect(a?.sql).not.toContain('repondeur_agent_id =');
  });

  it('setRepondeur : le mode et sa cible d’un seul coup, les cibles des autres modes remises à nul', async () => {
    const { pool, appels } = fauxPool();
    const s = new PgTenantSettingsStore(pool);
    await s.setRepondeur(T, { mode: 'agent', agentId: 'ag-1' });
    await s.setRepondeur(T, { mode: 'scenario', workflowId: 'wf-1', delaiS: 7200 });
    await s.setRepondeur(T, { mode: 'equipe' });
    expect(appels.map((x) => x.params)).toEqual([
      [T, 'agent', 'ag-1', null, null],
      [T, 'scenario', null, 'wf-1', 7200],
      [T, 'equipe', null, null, null],
    ]);
    // Un seul `update` par choix, qui écrit les quatre colonnes ; le délai garde sa valeur hors du mode scénario.
    for (const x of appels) {
      expect(x.sql).toContain('repondeur_agent_id = excluded.repondeur_agent_id');
      expect(x.sql).toContain('repondeur_workflow_id = excluded.repondeur_workflow_id');
      expect(x.sql).toContain('repondeur_delai_scenario_s = coalesce($5::integer, tenant_settings.repondeur_delai_scenario_s)');
    }
  });
});
