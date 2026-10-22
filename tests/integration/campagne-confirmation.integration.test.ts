import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgConfirmations } from '../../src/campaign/confirmation.pg';
import { PgCampaignRepo } from '../../src/campaign/store.pg';

const url = process.env.DATABASE_URL ?? '';

/**
 * LA CONFIRMATION D'UNE CAMPAGNE DE L'ASSISTANT, contre une vraie base (plan « Campagnes depuis Claude », tâche 7) :
 * l'usage unique tient à UNE requête atomique, que seul Postgres peut prouver ; l'expiration se compte sur l'horloge
 * de la base ; et le filtre d'espace est le seul contrôle. Jamais joué en local (le `DATABASE_URL` local pointe la
 * PRODUCTION), joué par le job `integration`.
 */
describe.skipIf(!url)('PgConfirmations (Postgres)', () => {
  let pool: Pool;
  let confirmations: PgConfirmations;
  let campagnes: PgCampaignRepo;
  let tenantId = '';
  let autreTenant = '';
  let campaignId = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    confirmations = new PgConfirmations(pool);
    campagnes = new PgCampaignRepo(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-confirmation') returning id`)).rows[0]!.id;
    autreTenant = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-confirmation-autre') returning id`)).rows[0]!.id;
    campaignId = (await pool.query<{ id: string }>(
      `insert into campaigns (tenant_id, phone_number_id, name, category, template_name, template_language, prevue_le)
       values ($1, 'pn-conf', 'assistant', 'utility', 'retard_livraison', 'fr', '2027-10-30T08:00:00Z') returning id`,
      [tenantId],
    )).rows[0]!.id;
    const contact = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164, profile_name, opt_in_status) values ($1, '+33600009201', 'Léa', 'opted_out') returning id`, [tenantId],
    )).rows[0]!.id;
    await pool.query(
      `insert into campaign_recipients (campaign_id, contact_id, to_e164, resolved_params, status) values ($1, $2, '+33600009201', '[]'::jsonb, 'pending')`,
      [campaignId, contact],
    );
  });

  afterAll(async () => {
    for (const t of [tenantId, autreTenant]) if (t) await pool.query('delete from tenants where id = $1', [t]).catch(() => {});
    await pool.end().catch(() => {});
  });

  it('l’état relu en base : modèle, date prévue, destinataires en attente, statut', async () => {
    expect(await campagnes.etatPourConfirmation(tenantId, campaignId)).toEqual({
      templateName: 'retard_livraison', templateLanguage: 'fr', category: 'utility', prevueLe: '2027-10-30T08:00:00.000Z',
      paramMapping: [], recipientCount: 1, status: 'draft',
    });
    expect(await campagnes.etatPourConfirmation(autreTenant, campaignId)).toBeNull();
  });

  it('le récapitulatif : les noms des destinataires, et ceux qui ont dit STOP', async () => {
    expect(await campagnes.apercuDestinataires(tenantId, campaignId, 5)).toEqual(['Léa']);
    expect(await campagnes.desabonnesParmiLesDestinataires(tenantId, campaignId)).toBe(1);
    expect(await campagnes.apercuDestinataires(autreTenant, campaignId, 5)).toEqual([]);
    expect(await campagnes.desabonnesParmiLesDestinataires(autreTenant, campaignId)).toBe(0);
  });

  it('le motif et l’échéance d’une pause (prepare_resume), lus dans l’espace seulement', async () => {
    const enPause = (await pool.query<{ id: string }>(
      `insert into campaigns (tenant_id, phone_number_id, name, category, template_name, template_language, status, pause_reason, paused_until)
       values ($1, 'pn-conf', 'en pause', 'utility', 'retard_livraison', 'fr', 'paused', 'debit', '2027-10-30T08:15:00Z') returning id`,
      [tenantId],
    )).rows[0]!.id;
    expect(await campagnes.pauseDe(tenantId, enPause)).toEqual({ motif: 'debit', jusqua: new Date('2027-10-30T08:15:00Z') });
    expect(await campagnes.pauseDe(tenantId, campaignId)).toEqual({ motif: null, jusqua: null });
    expect(await campagnes.pauseDe(autreTenant, enPause)).toBeNull();
  });

  it('🔴 la campagne d’un autre espace ne reçoit pas de code', async () => {
    expect(await confirmations.poser(autreTenant, campaignId, 'etat')).toBeNull();
    expect(await confirmations.existe(autreTenant, campaignId)).toBe(false);
  });

  it('🔴 deux réclamations simultanées du même code : un seul « ok »', async () => {
    const pose = (await confirmations.poser(tenantId, campaignId, 'etat-1'))!;
    expect(pose.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(await confirmations.existe(tenantId, campaignId)).toBe(true);
    const issues = await Promise.all([1, 2, 3].map(() => confirmations.reclamer(tenantId, campaignId, pose.code, 'etat-1')));
    expect(issues.filter((i) => i === 'ok')).toHaveLength(1);
    expect(issues.filter((i) => i === 'utilise')).toHaveLength(2);
  });

  it('rendu après un lancement refusé, le code resservira ; un autre espace ne le réclame pas', async () => {
    const pose = (await confirmations.poser(tenantId, campaignId, 'etat-2'))!;
    expect(await confirmations.reclamer(autreTenant, campaignId, pose.code, 'etat-2')).toBe('invalide');
    expect(await confirmations.reclamer(tenantId, campaignId, pose.code, 'etat-2')).toBe('ok');
    await confirmations.rendre(tenantId, campaignId);
    expect(await confirmations.reclamer(tenantId, campaignId, pose.code, 'etat-2')).toBe('ok');
  });

  it('un code faux, un état changé, un code expiré : chacun son refus', async () => {
    const pose = (await confirmations.poser(tenantId, campaignId, 'etat-3'))!;
    const faux = pose.code === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA';
    expect(await confirmations.reclamer(tenantId, campaignId, faux, 'etat-3')).toBe('invalide');
    expect(await confirmations.reclamer(tenantId, campaignId, pose.code, 'etat-autre')).toBe('modifie');
    await pool.query(`update campagne_confirmations set expire_le = now() - interval '1 second' where campaign_id = $1`, [campaignId]);
    expect(await confirmations.reclamer(tenantId, campaignId, pose.code, 'etat-3')).toBe('expire');
  });
});
