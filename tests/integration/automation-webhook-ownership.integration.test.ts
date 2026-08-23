import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgAutomationStore } from '../../src/automation/store.pg';

/**
 * Une automation de type `webhook` appartient à SON webhook entrant (migration 0074) : elle se crée, se
 * modifie et se supprime depuis l'écran Tools > Webhooks, jamais depuis l'écran Automation.
 *
 * L'invariant ne tenait d'abord qu'à un fait de présentation : l'identifiant de cette ligne n'est exposé
 * nulle part, donc personne ne pouvait la viser. C'est vrai aujourd'hui, et ça cesse de l'être le jour où
 * une route rend cet identifiant pour une raison quelconque. Il est désormais tenu EN BASE, par un prédicat
 * dans les quatre requêtes de `PgAutomationStore`.
 *
 * Ce test tape la vraie base, parce que c'est le seul endroit où un prédicat SQL peut être vérifié : un test
 * qui relirait la chaîne de la requête ne prouverait que sa propre copie.
 */

const url = process.env.DATABASE_URL ?? '';

describe.skipIf(!url)('automations possédées par un webhook : hors de portée de l’écran Automation', () => {
  let pool: Pool;
  let tenantId: string;
  let workflowId: string;
  let idWebhook: string;
  let idNormale: string;
  let store: PgAutomationStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    store = new PgAutomationStore(pool);
    tenantId = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-webhook-ownership') returning id`,
    )).rows[0]!.id;
    workflowId = (await pool.query<{ id: string }>(
      `insert into workflows (tenant_id, name, graph) values ($1, 'itest', '{"nodes":[],"edges":[]}'::jsonb) returning id`,
      [tenantId],
    )).rows[0]!.id;

    // La ligne POSSÉDÉE par un webhook, écrite comme `PgWebhookStore.syncAutomation` l'écrit.
    idWebhook = (await pool.query<{ id: string }>(
      `insert into automations (tenant_id, name, enabled, trigger_kind, trigger_config, workflow_id)
       values ($1, 'Webhook : commandes', true, 'webhook', '{"webhookId":"wh-itest"}'::jsonb, $2) returning id`,
      [tenantId, workflowId],
    )).rows[0]!.id;

    // Une automation ordinaire, témoin : elle doit rester pilotable normalement.
    idNormale = (await pool.query<{ id: string }>(
      `insert into automations (tenant_id, name, enabled, trigger_kind, trigger_config, workflow_id)
       values ($1, 'Mot-clé rdv', true, 'keyword', '{"keywords":["rdv"]}'::jsonb, $2) returning id`,
      [tenantId, workflowId],
    )).rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  it('🔴 `list` ne la montre pas, mais montre l’automation ordinaire', async () => {
    const noms = (await store.list(tenantId)).map((a) => a.name);
    expect(noms).toContain('Mot-clé rdv');
    expect(noms).not.toContain('Webhook : commandes');
  });

  it('🔴 `getById` ne la trouve pas', async () => {
    expect(await store.getById(idWebhook, tenantId)).toBeNull();
    expect(await store.getById(idNormale, tenantId)).not.toBeNull();
  });

  it('le chemin CHAUD, lui, la voit : c’est elle qui déclenche le scénario', async () => {
    // `listEnabled` ne porte volontairement PAS le prédicat : le sortir du chemin chaud rendrait le webhook
    // muet, ce qui est exactement l'inverse du but.
    const chaud = await store.listEnabled(tenantId, ['webhook']);
    expect(chaud.map((a) => a.id)).toContain(idWebhook);
    expect(chaud[0]?.triggerConfig.webhookId).toBe('wh-itest');
  });

  it('🔴 `update` ne peut pas la RÉAFFECTER à un autre déclencheur', async () => {
    // Sans le prédicat, ce PATCH transformait une ligne de webhook en automation par mot-clé : le webhook
    // croyait encore déclencher son scénario, et plus rien ne partait.
    expect(await store.update(idWebhook, tenantId, { triggerKind: 'keyword', triggerConfig: { keywords: ['x'] } })).toBe(false);
    const relu = await pool.query<{ trigger_kind: string }>('select trigger_kind from automations where id = $1', [idWebhook]);
    expect(relu.rows[0]?.trigger_kind).toBe('webhook');
  });

  it('🔴 `remove` ne peut pas la supprimer', async () => {
    expect(await store.remove(idWebhook, tenantId)).toBe(false);
    const reste = await pool.query('select 1 from automations where id = $1', [idWebhook]);
    expect(reste.rowCount).toBe(1);
  });

  it('l’automation ordinaire reste pilotable (le prédicat n’a pas tout verrouillé)', async () => {
    expect(await store.update(idNormale, tenantId, { name: 'Mot-clé rdv (modifié)' })).toBe(true);
    expect((await store.getById(idNormale, tenantId))?.name).toBe('Mot-clé rdv (modifié)');
    expect(await store.remove(idNormale, tenantId)).toBe(true);
  });
});
