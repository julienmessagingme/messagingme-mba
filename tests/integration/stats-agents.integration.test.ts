import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgStatsStore } from '../../src/stats/store.pg';
import { PgToolCatalog } from '../../src/agent/catalog.pg';

// Ne PAS lancer ce fichier en local : le DATABASE_URL du .env local pointe sur la base de PRODUCTION.
const url = process.env.DATABASE_URL ?? '';
const RANGE = { from: '2026-09-01', to: '2026-09-07' };

/**
 * LES DEUX COMPTES NEUFS DE `get_ai_stats` (lot « chiffres pour Claude Code », livraison B), sur Postgres réel : les
 * demandes ouvertes pour l'équipe par jour (`escaladee` et `passee_par_mba` de la frise, hors fils de test) et les actions des agents IA par jour et par
 * action. Bornés à la période, au fuseau de Paris, et à l'espace : un autre espace ne voit rien.
 */
describe.skipIf(!url)('les passages à l’équipe et les actions des agents, par jour (Postgres réel)', () => {
  let pool: Pool;
  let store: PgStatsStore;
  let tenantId = '';
  let autreTenantId = '';
  let toolId = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    store = new PgStatsStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-stats-agents') returning id`)).rows[0]!.id;
    autreTenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-stats-agents-autre') returning id`)).rows[0]!.id;
    const conversation = async (tenant: string, wa: string, test = false) => (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, last_message_at, control_owner, last_direction, is_test)
       values ($1, $2, now(), 'app_human', 'in', $3) returning id`,
      [tenant, wa, test],
    )).rows[0]!.id;
    const cv = await conversation(tenantId, '33616000801');
    const cvAutre = await conversation(autreTenantId, '33616000802');
    const cvTest = await conversation(tenantId, '33616000804', true);
    // Deux demandes le 5 (dont une à 23 h 30 à Paris, le 5 au soir en UTC), deux le 6 (dont une passation de l'agent de
    // Meta, `passee_par_mba`), une hors période, un autre type, et un fil de test.
    await pool.query(
      `insert into conversation_evenements (tenant_id, conversation_id, type, cause, at) values
         ($1, $2, 'escaladee', 'automatique : agent IA', timestamptz '2026-09-05 10:00:00+00'),
         ($1, $2, 'escaladee', 'automatique : agent IA', timestamptz '2026-09-05 21:30:00+00'),
         ($1, $2, 'escaladee', 'automatique : agent IA', timestamptz '2026-09-06 08:00:00+00'),
         ($1, $2, 'escaladee', 'automatique : agent IA', timestamptz '2026-09-20 08:00:00+00'),
         ($1, $2, 'passee_par_mba', 'automatique : agent de Meta', timestamptz '2026-09-06 09:00:00+00'),
         ($1, $2, 'urgente', 'automatique : agent IA', timestamptz '2026-09-05 10:00:00+00'),
         ($1, $5, 'escaladee', 'automatique : agent IA', timestamptz '2026-09-05 10:00:00+00'),
         ($3, $4, 'escaladee', 'automatique : agent IA', timestamptz '2026-09-05 10:00:00+00')`,
      [tenantId, cv, autreTenantId, cvAutre, cvTest],
    );
    // ⚠️ `mention_ia` et `modele` sont NOT NULL SANS défaut (0086).
    const agentId = (await pool.query<{ id: string }>(
      `insert into agents (tenant_id, label, fiche, mention_ia, modele)
       values ($1, 'itest-stats-agents', $2::jsonb, 'Je suis une IA.', 'test/modele') returning id`,
      [tenantId, JSON.stringify({ objectif: 'aider' })],
    )).rows[0]!.id;
    const outil = await new PgToolCatalog(pool).ajouter(tenantId, agentId, {
      handler: 'declencher_action',
      cible: { handler: 'declencher_action', nom: 'Résiliation', consigne: '', champs: [] },
      name: 'action_resiliation', title: 'Résiliation', description: 'Déclenche.', nePasUtiliser: '', params: [], risk: 'write',
    });
    toolId = outil!.id;
    await pool.query(
      `insert into agent_actions (tenant_id, tool_id, agent_id, conversation_id, wa_id, jour, champs, at) values
         ($1, $2, $3, $4, '33616000801', '2026-09-05', '{}'::jsonb, timestamptz '2026-09-05 10:00:00+00'),
         ($1, $2, $3, $4, '33616000803', '2026-09-05', '{}'::jsonb, timestamptz '2026-09-05 11:00:00+00'),
         ($1, $2, $3, $4, '33616000801', '2026-09-06', '{}'::jsonb, timestamptz '2026-09-06 11:00:00+00')`,
      [tenantId, toolId, agentId, cv],
    );
  });

  afterAll(async () => {
    if (pool) {
      for (const t of [tenantId, autreTenantId]) if (t) await pool.query('delete from tenants where id = $1', [t]);
      await pool.end();
    }
  });

  it('🔴 les demandes pour l’équipe : par jour de Paris, sur la période, les deux ouvertures, sans fil de test ni autre espace', async () => {
    expect(await store.demandesEquipeParJour(tenantId, RANGE)).toEqual([
      // 21 h 30 UTC le 5 = 23 h 30 à Paris : toujours le 5.
      { date: '2026-09-05', count: 2 },
      // L'escalade et la passation de l'agent de Meta.
      { date: '2026-09-06', count: 2 },
    ]);
    expect(await store.demandesEquipeParJour(autreTenantId, RANGE)).toEqual([{ date: '2026-09-05', count: 1 }]);
  });

  it('🔴 les actions : par jour et par action, nommées par leur cible, et rien d’un autre espace', async () => {
    expect(await store.actionsAgentParJour(tenantId, RANGE)).toEqual([
      { date: '2026-09-05', actionId: toolId, nom: 'Résiliation', n: 2 },
      { date: '2026-09-06', actionId: toolId, nom: 'Résiliation', n: 1 },
    ]);
    expect(await store.actionsAgentParJour(autreTenantId, RANGE)).toEqual([]);
  });
});
