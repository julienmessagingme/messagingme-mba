import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgCampaignRepo } from '../../src/campaign/store.pg';
import { PgWebhookStore } from '../../src/webhook-entrant/store.pg';

/**
 * Campagne AU FIL DE L'EAU, contre une VRAIE base (migration 0084).
 *
 * Tout ce qui est testé ici est du SQL, et le SQL ne se vérifie qu'en base : une requête relue en test unitaire
 * ne prouve que sa propre copie. Trois invariants portent la fonctionnalité entière, et chacun se casse en
 * SILENCE s'il lâche :
 *
 *  - `listRunningByWebhook` ne rend QUE les campagnes vivantes de CE tenant : trop large, un lead d'un espace
 *    partirait dans la campagne d'un autre ; trop étroite, plus aucun lead n'est contacté.
 *  - `insertWebhookRecipient` ne pose jamais deux fois la même personne (contrainte `(campaign_id, contact_id)`).
 *  - `getByCode().alimenteCampagne` décide de publier l'événement quand le webhook n'a pas de scénario. Faux,
 *    et la campagne reste « en cours » sans jamais recevoir un seul contact.
 */
const url = process.env.DATABASE_URL ?? '';

describe.skipIf(!url)('campagne alimentée par un webhook', () => {
  let pool: Pool;
  let repo: PgCampaignRepo;
  let webhooks: PgWebhookStore;
  let tenantId: string;
  let autreTenant: string;
  let webhookId: string;
  let code: string;
  let contactId: string;

  const phone = '+33600000084';
  const waId = '33600000084';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    repo = new PgCampaignRepo(pool);
    webhooks = new PgWebhookStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-fil-eau') returning id`)).rows[0]!.id;
    autreTenant = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-fil-eau-autre') returning id`)).rows[0]!.id;
    const cree = await webhooks.create(tenantId, {
      name: 'Leads itest', enabled: true, mapping: [{ chemin: 'tel', cible: 'sys:phone' }],
      createContact: true, optIn: true, workflowId: null, startNodeId: null, cooldownSeconds: null,
    });
    webhookId = cree.id;
    code = cree.code;
    contactId = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164, opt_in_status, fields) values ($1, $2, 'opted_in', '{"prenom":"Alice"}'::jsonb) returning id`,
      [tenantId, phone],
    )).rows[0]!.id;
  });

  afterAll(async () => {
    await pool.query(`delete from tenants where id = any($1::uuid[])`, [[tenantId, autreTenant]]);
    await pool.end();
  });

  /** Crée une campagne au fil de l'eau par le CHEMIN RÉEL (`createWithRecipients`) et la met dans un statut. */
  async function campagne(statut: string, tenant = tenantId, hook: string | null = webhookId): Promise<string> {
    const { campaignId } = await repo.createWithRecipients({
      tenantId: tenant, phoneNumberId: 'pn-itest', name: `itest ${statut}`, category: 'utility',
      templateName: 'promo', templateLanguage: 'fr', paramMapping: [],
      ...(hook ? { webhookId: hook } : {}),
    }, []);
    await pool.query(`update campaigns set status = $2 where id = $1`, [campaignId, statut]);
    return campaignId;
  }

  it('la colonne existe et fait l’aller-retour par le chemin de création réel', async () => {
    const id = await campagne('draft');
    const relue = await repo.getCampaign(id);
    expect(relue?.webhookId).toBe(webhookId);
  });

  it('🔴 listRunningByWebhook : seulement `running`, seulement CE webhook, seulement CE tenant', async () => {
    const enCours = await campagne('running');
    await campagne('draft');
    await campagne('paused');
    await campagne('completed');
    await campagne('running', autreTenant, null); // autre espace, sans webhook
    const trouvees = await repo.listRunningByWebhook(tenantId, webhookId);
    expect(trouvees.map((c) => c.id)).toEqual([enCours]);
    // Le tenant est un filtre, pas une décoration : le même webhookId vu d'un autre espace ne rend rien.
    expect(await repo.listRunningByWebhook(autreTenant, webhookId)).toEqual([]);
  });

  it('🔴 insertWebhookRecipient : le même contact n’est inscrit qu’UNE fois', async () => {
    const id = await campagne('running');
    const premier = await repo.insertWebhookRecipient(id, { contactId, toE164: phone, resolvedParams: ['Alice'], statut: 'pending' });
    const second = await repo.insertWebhookRecipient(id, { contactId, toE164: phone, resolvedParams: ['Alice'], statut: 'pending' });
    expect(premier).toBe(true);
    expect(second).toBe(false); // il ne recevra pas deux fois
    const n = await pool.query(`select 1 from campaign_recipients where campaign_id = $1`, [id]);
    expect(n.rowCount).toBe(1);
  });

  it('un arrivant ÉCARTÉ est inscrit avec son motif, il ne disparaît pas', async () => {
    const id = await campagne('running');
    await repo.insertWebhookRecipient(id, { contactId, toE164: phone, resolvedParams: [], statut: 'skipped', motif: 'Écarté : pas de consentement pour du marketing.' });
    const r = await pool.query<{ status: string; error: string | null }>(
      `select status, error from campaign_recipients where campaign_id = $1`, [id],
    );
    expect(r.rows[0]).toMatchObject({ status: 'skipped' });
    expect(r.rows[0]!.error).toContain('consentement');
  });

  it('contactForBuildByWaId retrouve le contact par son wa_id, avec ses champs', async () => {
    const c = await repo.contactForBuildByWaId(tenantId, waId);
    expect(c).toMatchObject({ id: contactId, phone_e164: phone, optInStatus: 'opted_in' });
    expect(c?.fields).toMatchObject({ prenom: 'Alice' });
    // Un contact d'un AUTRE espace n'est jamais rendu.
    expect(await repo.contactForBuildByWaId(autreTenant, waId)).toBeNull();
  });

  it('un contact BLOQUÉ n’est plus un arrivant', async () => {
    const bloque = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164, opt_in_status, blocked_at) values ($1, '+33600000085', 'opted_in', now()) returning id`,
      [tenantId],
    )).rows[0]!.id;
    expect(bloque).toBeTruthy();
    expect(await repo.contactForBuildByWaId(tenantId, '33600000085')).toBeNull();
  });

  it('listWebhookCampaignsWithPending ne rend que celles qui ont vraiment quelqu’un en attente', async () => {
    const avec = await campagne('running');
    const sans = await campagne('running');
    await repo.insertWebhookRecipient(avec, { contactId, toE164: phone, resolvedParams: [], statut: 'pending' });
    const ids = (await repo.listWebhookCampaignsWithPending()).map((c) => c.id);
    expect(ids).toContain(avec);
    expect(ids).not.toContain(sans);
  });

  it('🔴 stopWebhookCampaign : ferme la campagne, scopée au tenant, et seulement si elle est vivante', async () => {
    const id = await campagne('running');
    expect(await repo.stopWebhookCampaign(id, autreTenant)).toBe(false); // pas son espace
    expect(await repo.stopWebhookCampaign(id, tenantId)).toBe(true);
    const st = await pool.query<{ status: string }>(`select status from campaigns where id = $1`, [id]);
    expect(st.rows[0]?.status).toBe('completed');
    expect(await repo.stopWebhookCampaign(id, tenantId)).toBe(false); // déjà arrêtée
    // Une campagne ORDINAIRE ne s'arrête pas par cette route : elle se termine toute seule.
    const ordinaire = await campagne('running', tenantId, null);
    expect(await repo.stopWebhookCampaign(ordinaire, tenantId)).toBe(false);
  });

  it('🔴 webhookFeedsLiveCampaign : nomme la campagne qui interdit la suppression de l’adresse', async () => {
    const id = await campagne('running');
    expect(await repo.webhookFeedsLiveCampaign(tenantId, webhookId)).toContain('itest');
    await repo.stopWebhookCampaign(id, tenantId);
    // Toutes les campagnes de cet espace sur ce webhook doivent être closes pour libérer l'adresse.
    await pool.query(`update campaigns set status = 'completed' where tenant_id = $1 and webhook_id = $2`, [tenantId, webhookId]);
    expect(await repo.webhookFeedsLiveCampaign(tenantId, webhookId)).toBeNull();
  });

  it('🔴 getByCode.alimenteCampagne suit l’état réel des campagnes', async () => {
    await pool.query(`update campaigns set status = 'completed' where tenant_id = $1 and webhook_id = $2`, [tenantId, webhookId]);
    expect((await webhooks.getByCode(code))?.alimenteCampagne).toBe(false);
    const id = await campagne('running');
    expect((await webhooks.getByCode(code))?.alimenteCampagne).toBe(true);
    // Arrêtée -> l'adresse cesse aussitôt de publier pour elle. Aucun compteur à tenir à jour, donc rien à
    // désynchroniser : c'est l'état des campagnes qui fait foi.
    await repo.stopWebhookCampaign(id, tenantId);
    expect((await webhooks.getByCode(code))?.alimenteCampagne).toBe(false);
  });

  it('supprimer le webhook laisse l’historique des campagnes terminées (webhook_id à null)', async () => {
    const id = await campagne('completed');
    await webhooks.remove(tenantId, webhookId);
    const r = await pool.query<{ webhook_id: string | null }>(`select webhook_id from campaigns where id = $1`, [id]);
    expect(r.rows[0]?.webhook_id).toBeNull();
  });
});
