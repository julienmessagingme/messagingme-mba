import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgCampaignRunLock } from '../../src/campaign/run-lock';
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
    if (cree.kind !== 'cree') throw new Error(`création du webhook témoin refusée : ${cree.kind}`);
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

  async function creerWebhook(nom: string, workflowId: string | null = null): Promise<{ id: string; code: string }> {
    const issue = await webhooks.create(tenantId, {
      name: nom, enabled: true, mapping: [], createContact: true, optIn: true,
      workflowId, startNodeId: null, cooldownSeconds: null,
    });
    if (issue.kind !== 'cree') throw new Error(`création du webhook « ${nom} » refusée : ${issue.kind}`);
    return { id: issue.id, code: issue.code };
  }

  it('la colonne existe et fait l’aller-retour par le chemin de création réel', async () => {
    const id = await campagne('draft');
    const relue = await repo.getCampaign(id);
    expect(relue?.webhookId).toBe(webhookId);
  });

  it("🔴 le store refuse lui-même le scénario d'un autre espace", async () => {
    const workflowAutre = (await pool.query<{ id: string }>(
      `insert into workflows (tenant_id, name, graph) values ($1, 'itest autre', '{"nodes":[],"edges":[]}'::jsonb) returning id`,
      [autreTenant],
    )).rows[0]!.id;
    const issue = await webhooks.create(tenantId, {
      name: 'Ne doit pas naître', enabled: true, mapping: [], createContact: true, optIn: true,
      workflowId: workflowAutre, startNodeId: null, cooldownSeconds: null,
    });
    expect(issue).toEqual({ kind: 'scenario_inconnu' });
    const absente = await pool.query(`select 1 from webhooks where tenant_id = $1 and name = 'Ne doit pas naître'`, [tenantId]);
    expect(absente.rowCount).toBe(0);
  });

  it("🔴 le store refuse aussi de modifier un webhook avec le scénario d'un autre espace, sans écriture partielle", async () => {
    const workflowLocal = (await pool.query<{ id: string }>(
      `insert into workflows (tenant_id, name, graph) values ($1, 'itest local', '{"nodes":[],"edges":[]}'::jsonb) returning id`,
      [tenantId],
    )).rows[0]!.id;
    const workflowAutre = (await pool.query<{ id: string }>(
      `insert into workflows (tenant_id, name, graph) values ($1, 'itest autre update', '{"nodes":[],"edges":[]}'::jsonb) returning id`,
      [autreTenant],
    )).rows[0]!.id;
    const hook = await creerWebhook('Webhook à préserver', workflowLocal);
    const avant = await pool.query<{ automation_id: string; workflow_id: string }>(
      `select w.automation_id, a.workflow_id
         from webhooks w join automations a on a.id = w.automation_id
        where w.tenant_id = $1 and w.id = $2`,
      [tenantId, hook.id],
    );

    const issue = await webhooks.update(tenantId, hook.id, {
      name: 'Ne doit pas être écrit', enabled: false, mapping: [], createContact: false, optIn: false,
      workflowId: workflowAutre, startNodeId: null, cooldownSeconds: 12,
    });

    expect(issue).toEqual({ kind: 'scenario_inconnu' });
    expect(await webhooks.get(tenantId, hook.id)).toMatchObject({
      name: 'Webhook à préserver', enabled: true, createContact: true, optIn: true, workflowId: workflowLocal,
    });
    const apres = await pool.query<{ automation_id: string; workflow_id: string }>(
      `select w.automation_id, a.workflow_id
         from webhooks w join automations a on a.id = w.automation_id
        where w.tenant_id = $1 and w.id = $2`,
      [tenantId, hook.id],
    );
    expect(apres.rows).toEqual(avant.rows);
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

  /**
   * 🔴 LE BALAYAGE DE REPRISE (R4), qui a REMPLACÉ celui du fil de l'eau : celui-ci n'en était qu'un cas
   * particulier, et il ne savait pas voir qu'un run tournait déjà.
   */
  it('🔴 listCampagnesGelees : `running` + du travail + AUCUN run vivant', async () => {
    const gelee = await campagne('running');
    const sansTravail = await campagne('running');
    const enCours = await campagne('running');
    await repo.insertWebhookRecipient(gelee, { contactId, toE164: phone, resolvedParams: [], statut: 'pending' });
    await repo.insertWebhookRecipient(enCours, { contactId, toE164: phone, resolvedParams: [], statut: 'pending' });
    // `enCours` tient un verrou VIVANT : elle envoie, on ne la relance surtout pas.
    const verrou = new PgCampaignRunLock(pool);
    const jeton = await verrou.acquire(enCours, tenantId, 300);
    expect(jeton).not.toBeNull();

    const ids = (await repo.listCampagnesGelees()).map((c: { id: string }) => c.id);
    expect(ids).toContain(gelee);
    expect(ids).not.toContain(sansTravail); // rien en attente
    expect(ids).not.toContain(enCours); // un run la tient

    // 🔴 Et un verrou dont le BAIL EST ÉCOULÉ ne protège plus : c'est exactement le cas du worker tué en plein
    // envoi, celui que R4 doit rattraper. Sans ça la campagne resterait gelée jusqu'à l'expiration du bail.
    await pool.query(`update campaign_run_locks set expires_at = now() - interval '1 second' where campaign_id = $1`, [enCours]);
    expect((await repo.listCampagnesGelees()).map((c: { id: string }) => c.id)).toContain(enCours);
    await verrou.release(enCours, tenantId, jeton!);
  });

  it('🔴 renouveler repousse le bail, et le jeton de garde protège celui d’un autre', async () => {
    const id = await campagne('running');
    const verrou = new PgCampaignRunLock(pool);
    const jeton = (await verrou.acquire(id, tenantId, 1))!;
    expect(await verrou.renouveler(id, tenantId, jeton)).toBe(true);
    // Un jeton qui n'est pas le nôtre ne repousse rien : sinon un run mort prolongerait le bail d'un vivant.
    expect(await verrou.renouveler(id, tenantId, 'pas-le-bon-jeton')).toBe(false);
    await verrou.release(id, tenantId, jeton);
    // Verrou rendu : plus rien à renouveler.
    expect(await verrou.renouveler(id, tenantId, jeton)).toBe(false);
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

  it('🔴 le store nomme la campagne vivante et refuse de supprimer son adresse', async () => {
    const hook = await creerWebhook('Webhook protégé');
    const id = await campagne('running', tenantId, hook.id);
    expect(await webhooks.remove(tenantId, hook.id)).toEqual({ kind: 'campagne_vivante', campagne: 'itest running' });
    expect(await webhooks.get(tenantId, hook.id)).not.toBeNull();
    await repo.stopWebhookCampaign(id, tenantId);
    expect(await webhooks.remove(tenantId, hook.id)).toEqual({ kind: 'supprime' });
  });

  it('🔴 une campagne attachée en concurrence est vue avant toute suppression', async () => {
    const hook = await creerWebhook('Webhook concurrent');
    const tientInsertion = await pool.connect();
    let transactionOuverte = false;
    let suppression: Promise<Awaited<ReturnType<PgWebhookStore['remove']>>> | null = null;
    try {
      await tientInsertion.query('begin');
      transactionOuverte = true;
      const pidInsertion = (await tientInsertion.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
      await tientInsertion.query(
        `insert into campaigns
           (tenant_id, phone_number_id, name, category, template_name, template_language, param_mapping,
            webhook_id, status, channel)
         values ($1, 'pn-itest', 'itest concurrente', 'utility', 'promo', 'fr', '[]'::jsonb,
                 $2, 'draft', 'whatsapp')`,
        [tenantId, hook.id],
      );

      suppression = webhooks.remove(tenantId, hook.id);
      let suppressionBloquee = false;
      for (let i = 0; i < 100 && !suppressionBloquee; i += 1) {
        const attente = await pool.query<{ bloquee: boolean }>(
          `select exists (
             select 1 from pg_stat_activity a
              where $1 = any(pg_blocking_pids(a.pid))
                and a.query like '%select automation_id from webhooks%'
           ) as bloquee`,
          [pidInsertion],
        );
        suppressionBloquee = attente.rows[0]?.bloquee === true;
        if (!suppressionBloquee) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(suppressionBloquee).toBe(true);

      await tientInsertion.query('commit');
      transactionOuverte = false;
      expect(await suppression).toEqual({ kind: 'campagne_vivante', campagne: 'itest concurrente' });
      expect(await webhooks.get(tenantId, hook.id)).not.toBeNull();
      await pool.query(`update campaigns set status = 'completed' where tenant_id = $1 and webhook_id = $2`, [tenantId, hook.id]);
      expect(await webhooks.remove(tenantId, hook.id)).toEqual({ kind: 'supprime' });
    } finally {
      if (transactionOuverte) await tientInsertion.query('rollback');
      tientInsertion.release();
      if (suppression) await suppression.catch(() => {});
    }
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
    expect(await webhooks.remove(tenantId, webhookId)).toEqual({ kind: 'supprime' });
    const r = await pool.query<{ webhook_id: string | null }>(`select webhook_id from campaigns where id = $1`, [id]);
    expect(r.rows[0]?.webhook_id).toBeNull();
  });
});
