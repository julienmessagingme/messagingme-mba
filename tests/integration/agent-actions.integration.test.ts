import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgToolCatalog } from '../../src/agent/catalog.pg';
import { PgActionsAgent } from '../../src/agent/actions.pg';
import { PgInboxStore } from '../../src/inbox/store.pg';

/**
 * LES ACTIONS DE L'AGENT IA EN BASE (migration 0232, plan docs/superpowers/plans/2026-10-13-actions-agent.md) : une
 * fois par jour, par contact et par action, tenu par la contrainte et non par une lecture ; une réservation rendue
 * libère le jour ; la trace de la frise passe le CHECK des types ; et rien ne déborde sur un autre espace.
 *
 * ⚠️ Ne PAS le lancer en local : le `DATABASE_URL` du `.env` local pointe sur la base de PRODUCTION, et ce fichier crée
 * et supprime des tenants. La CI monte un Postgres jetable pour ça (job `integration`).
 */
const url = process.env.DATABASE_URL ?? '';

describe.skipIf(!url)('les actions de l’agent IA (Postgres)', () => {
  let pool: Pool;
  let actions: PgActionsAgent;
  let inbox: PgInboxStore;
  let tenantId = '';
  let autreTenantId = '';
  let agentId = '';
  let toolId = '';
  let conversationId = '';
  const waId = '33616000999';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    actions = new PgActionsAgent(pool);
    inbox = new PgInboxStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-agent-actions') returning id`)).rows[0]!.id;
    autreTenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-agent-actions-autre') returning id`)).rows[0]!.id;
    // ⚠️ `mention_ia` et `modele` sont NOT NULL SANS défaut (0086).
    agentId = (await pool.query<{ id: string }>(
      `insert into agents (tenant_id, label, fiche, mention_ia, modele)
       values ($1, 'itest-actions', $2::jsonb, 'Je suis une IA.', 'test/modele') returning id`,
      [tenantId, JSON.stringify({ objectif: 'aider' })],
    )).rows[0]!.id;
    const outil = await new PgToolCatalog(pool).ajouter(tenantId, agentId, {
      handler: 'declencher_action',
      cible: { handler: 'declencher_action', nom: 'résiliation', consigne: '', champs: [] },
      name: 'action_resiliation', title: 'Déclencher une action', description: 'Déclenche.', nePasUtiliser: '',
      params: [], risk: 'write',
    });
    toolId = outil!.id;
    conversationId = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, last_message_at, control_owner, last_direction)
       values ($1, $2, now(), 'mba', 'in') returning id`,
      [tenantId, waId],
    )).rows[0]!.id;
  });

  afterAll(async () => {
    if (pool) {
      for (const t of [tenantId, autreTenantId]) if (t) await pool.query('delete from tenants where id = $1', [t]);
      await pool.end();
    }
  });

  const ligne = (jour: string) => ({
    tenantId, actionId: toolId, agentId, conversationId, waId, jour, champs: { contrat: '12345', mois: 3 },
  });

  it('🔴 une fois par jour : la seconde réservation du même jour rend null, celle du lendemain passe', async () => {
    const premiere = await actions.reserver(ligne('2026-10-13'));
    expect(premiere).toMatch(/^[0-9a-f-]{36}$/);
    expect(await actions.reserver(ligne('2026-10-13'))).toBeNull();
    expect(await actions.reserver(ligne('2026-10-14'))).not.toBeNull();
    const champs = (await pool.query<{ champs: unknown }>('select champs from agent_actions where id = $1', [premiere])).rows[0]!.champs;
    expect(champs).toEqual({ contrat: '12345', mois: 3 });
  });

  it('🔴 une réservation rendue libère le jour ; un autre espace ne peut pas la rendre', async () => {
    const id = (await actions.reserver(ligne('2026-10-20')))!;
    await actions.annuler(autreTenantId, id);
    expect(await actions.reserver(ligne('2026-10-20'))).toBeNull();
    await actions.annuler(tenantId, id);
    expect(await actions.reserver(ligne('2026-10-20'))).not.toBeNull();
  });

  it('🔴 la trace de la frise passe le CHECK des types, et pas dans un autre espace', async () => {
    await inbox.noterActionAgent(tenantId, conversationId, 'automatique : action « résiliation »');
    await inbox.noterActionAgent(autreTenantId, conversationId, 'automatique : action « intrus »');
    const lignes = (await pool.query<{ type: string; cause: string }>(
      `select type, cause from conversation_evenements where conversation_id = $1 and type = 'action_agent'`, [conversationId],
    )).rows;
    expect(lignes).toEqual([{ type: 'action_agent', cause: 'automatique : action « résiliation »' }]);
  });

  it('🔴 le menu du déclencheur : les actions de l’espace, nommées par leur cible, et rien pour un autre espace', async () => {
    expect(await actions.listerDeLEspace(tenantId)).toEqual([{ id: toolId, nom: 'résiliation', agentId, agent: 'itest-actions' }]);
    expect(await actions.listerDeLEspace(autreTenantId)).toEqual([]);
  });

  it('🔴 l’action s’efface avec sa conversation (les champs sont des données du contact)', async () => {
    await pool.query('delete from conversations where id = $1', [conversationId]);
    const reste = (await pool.query<{ n: string }>('select count(*) as n from agent_actions where tenant_id = $1', [tenantId])).rows[0]!.n;
    expect(Number(reste)).toBe(0);
  });
});
