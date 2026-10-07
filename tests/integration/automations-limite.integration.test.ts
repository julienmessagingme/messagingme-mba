import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgAutomationStore, type AutomationInput } from '../../src/automation/store.pg';
import { PgWebhookStore, type WebhookInput } from '../../src/webhook-entrant/store.pg';
import { LimiteOffreError } from '../../src/offres/refus';

/**
 * LA LIMITE D'AUTOMATIONS DE L'OFFRE (lot 6, tâche 5), sur une vraie base : les automations ALLUMÉES du client comptent,
 * celles des webhooks entrants aussi ; une automation possédée (lien, publicité, widget) ou éteinte ne compte pas.
 *
 * ⚠️ Ne PAS le lancer en local : le `DATABASE_URL` du `.env` local pointe sur la base de PRODUCTION. La CI monte un
 * Postgres jetable pour ça (job `integration`).
 */
const url = process.env.DATABASE_URL ?? '';
const LIMITE = 2;

describe.skipIf(!url)('la limite d’automations de l’offre', () => {
  let pool: Pool;
  let automations: PgAutomationStore;
  let webhooks: PgWebhookStore;
  let t = '';
  let wf = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    automations = new PgAutomationStore(pool, async () => LIMITE);
    webhooks = new PgWebhookStore(pool, async () => LIMITE);
    t = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-limite-automations') returning id`)).rows[0]!.id;
    wf = (await pool.query<{ id: string }>(`insert into workflows (tenant_id, name) values ($1, 'itest-limite') returning id`, [t])).rows[0]!.id;
  });
  beforeEach(async () => { await pool.query('delete from webhooks where tenant_id = $1', [t]); await pool.query('delete from automations where tenant_id = $1', [t]); });
  afterAll(async () => {
    await pool.query('delete from tenants where id = $1', [t]);
    await pool.end();
  });

  const entree = (enabled: boolean, possedePar?: string): AutomationInput => ({
    name: 'a', enabled, triggerKind: 'tag_added', triggerConfig: { tag: 'x' }, conditionGroup: null,
    workflowId: wf, startNodeId: null, cooldownSeconds: null, ...(possedePar ? { possedePar } : {}),
  });

  it('🔴 la troisième automation ALLUMÉE est refusée ; une éteinte et une possédée passent', async () => {
    await automations.create(t, entree(true));
    await automations.create(t, entree(true));
    await expect(automations.create(t, entree(true))).rejects.toBeInstanceOf(LimiteOffreError);
    await expect(automations.create(t, entree(false))).resolves.toMatchObject({ id: expect.any(String) });
    await expect(automations.create(t, entree(true, 'channelsme_link'))).resolves.toMatchObject({ id: expect.any(String) });
  });

  it('🔴 rallumer compte, et une automation déjà allumée ne se compte pas elle-même', async () => {
    const a = await automations.create(t, entree(true));
    const eteinte = await automations.create(t, entree(false));
    expect(await automations.update(a.id, t, { enabled: true })).toBe(true);
    await automations.create(t, entree(true));
    await expect(automations.update(eteinte.id, t, { enabled: true })).rejects.toBeInstanceOf(LimiteOffreError);
  });

  it('🔴 l’automation d’un webhook entrant allumé compte dans la même limite', async () => {
    await automations.create(t, entree(true));
    await automations.create(t, entree(true));
    const base: WebhookInput = { name: 'Formulaire', enabled: true, mapping: [], createContact: false, optIn: false, workflowId: wf, startNodeId: null, cooldownSeconds: null };
    await expect(webhooks.create(t, base)).rejects.toBeInstanceOf(LimiteOffreError);
  });
});
