import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgStatsStore } from '../../src/stats/store.pg';

// Ne PAS lancer ce fichier en local : le DATABASE_URL du .env local pointe sur la base de PRODUCTION.
const url = process.env.DATABASE_URL ?? '';
const RANGE = { from: '2026-09-01', to: '2026-09-07' };

/**
 * LES MODÈLES ENVOYÉS ET LEURS ACCUSÉS, PAR JOUR (`PgStatsStore.statutsDesModelesParJour`, lot « chiffres pour Claude
 * Code »), sur Postgres réel :
 *  - la population des `envoyes` est celle du tableau de bord (`getDashboard`) : même total sur la période ;
 *  - une campagne : livré, lu, sans accusé, échec annoncé par Meta (hors des envoyés, daté de son accusé), refus à
 *    l'envoi (daté de sa réclamation) ;
 *  - un modèle seul : ses accusés par `conversation_messages.statut` ; un doublon d'une campagne, un modèle sans
 *    catégorie et une conversation de test ne comptent pas ;
 *  - un autre espace ne voit rien.
 */
describe.skipIf(!url)('les modèles envoyés et leurs accusés, par jour (Postgres réel)', () => {
  let pool: Pool;
  let store: PgStatsStore;
  let tenantId = '';
  let autreTenantId = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    store = new PgStatsStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-statuts-modeles') returning id`)).rows[0]!.id;
    autreTenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-statuts-modeles-autre') returning id`)).rows[0]!.id;
    const contacts: string[] = [];
    for (const num of ['+33600000701', '+33600000702', '+33600000703', '+33600000704', '+33600000705', '+33600000706',
      '+33600000707', '+33600000708']) {
      contacts.push((await pool.query<{ id: string }>(
        `insert into contacts (tenant_id, phone_e164) values ($1, $2) returning id`, [tenantId, num],
      )).rows[0]!.id);
    }
    const campagne = (await pool.query<{ id: string }>(
      `insert into campaigns (tenant_id, name, category, template_name, channel)
       values ($1, 'itest-statuts', 'marketing', 'itest_tpl_statuts', 'whatsapp') returning id`,
      [tenantId],
    )).rows[0]!.id;
    // Le 5 septembre (10 h à Paris) : livré, lu, sans accusé ; un échec annoncé par Meta le 6 ; un refus à l'envoi le 5.
    await pool.query(
      `insert into campaign_recipients (campaign_id, contact_id, to_e164, resolved_params, status, claimed_at, sent_at, message_id, delivery_status, delivery_updated_at)
       values ($1, $2, '+33600000701', '{}'::jsonb, 'sent', null, timestamptz '2026-09-05 08:00:00+00', 'wamid.st-livre', 'delivered', timestamptz '2026-09-05 08:01:00+00'),
              ($1, $3, '+33600000702', '{}'::jsonb, 'sent', null, timestamptz '2026-09-05 08:00:00+00', 'wamid.st-lu', 'read', timestamptz '2026-09-05 08:02:00+00'),
              ($1, $4, '+33600000703', '{}'::jsonb, 'sent', null, timestamptz '2026-09-05 08:00:00+00', 'wamid.st-muet', null, null),
              ($1, $5, '+33600000704', '{}'::jsonb, 'sent', null, timestamptz '2026-09-05 08:00:00+00', 'wamid.st-echec', 'failed', timestamptz '2026-09-06 08:00:00+00'),
              ($1, $6, '+33600000705', '{}'::jsonb, 'failed', timestamptz '2026-09-05 07:00:00+00', null, null, null, null)`,
      [campagne, contacts[0], contacts[1], contacts[2], contacts[3], contacts[4]],
    );
    // Un accusé « sent » de Meta (téléphone éteint) : ni livré, ni sans accusé.
    await pool.query(
      `insert into campaign_recipients (campaign_id, contact_id, to_e164, resolved_params, status, sent_at, message_id, delivery_status, delivery_updated_at)
       values ($1, $2, '+33600000707', '{}'::jsonb, 'sent', timestamptz '2026-09-05 08:00:00+00', 'wamid.st-envoye', 'sent', timestamptz '2026-09-05 08:00:30+00')`,
      [campagne, contacts[6]],
    );
    // 🔴 Une campagne à SCÉNARIO : sa ligne ne porte pas de modèle (message_id wf-...) ; le modèle que son parcours
    // envoie est dans le fil, plus bas, avec son accusé. Compté UNE fois, livré et lu (relecture du lot, 2026-10-13).
    const parcours = (await pool.query<{ id: string }>(
      `insert into workflows (tenant_id, name) values ($1, 'itest-statuts-wf') returning id`, [tenantId],
    )).rows[0]!.id;
    const campagneScenario = (await pool.query<{ id: string }>(
      `insert into campaigns (tenant_id, name, category, workflow_id, channel)
       values ($1, 'itest-statuts-scenario', 'marketing', $2, 'whatsapp') returning id`,
      [tenantId, parcours],
    )).rows[0]!.id;
    await pool.query(
      `insert into campaign_recipients (campaign_id, contact_id, to_e164, resolved_params, status, claimed_at, sent_at, message_id)
       values ($1, $2, '+33600000708', '{}'::jsonb, 'sent', timestamptz '2026-09-05 08:00:00+00', timestamptz '2026-09-05 08:00:01+00', $3)`,
      [campagneScenario, contacts[7], `wf-${parcours}`],
    );
    const conversation = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, contact_id, last_message_at, control_owner, is_test)
       values ($1, '33600000706', $2, now(), 'app_workflow', false) returning id`,
      [tenantId, contacts[5]],
    )).rows[0]!.id;
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, channel, template_name, template_category, created_at, meta_message_id, statut) values
         ($1, 'out', 'template', 'whatsapp', 'itest_tpl_seul', 'utility', timestamptz '2026-09-05 09:00:00+00', 'wamid.st-m-livre', 'delivered'),
         ($1, 'out', 'template', 'whatsapp', 'itest_tpl_seul', 'utility', timestamptz '2026-09-05 09:01:00+00', 'wamid.st-m-lu', 'read'),
         ($1, 'out', 'template', 'whatsapp', 'itest_tpl_seul', 'utility', timestamptz '2026-09-05 09:02:00+00', 'wamid.st-m-echec', 'failed'),
         ($1, 'out', 'template', 'whatsapp', 'itest_tpl_seul', 'utility', timestamptz '2026-09-05 09:03:00+00', 'wamid.st-m-muet', null),
         ($1, 'out', 'template', 'whatsapp', 'itest_tpl_seul', 'utility', timestamptz '2026-09-05 09:05:00+00', 'wamid.st-m-envoye', 'sent'),
         ($1, 'out', 'template', 'whatsapp', 'itest_tpl_parcours', 'marketing', timestamptz '2026-09-05 09:06:00+00', 'wamid.st-scn', 'read'),
         ($1, 'out', 'template', 'whatsapp', 'itest_tpl_statuts', 'marketing', timestamptz '2026-09-05 08:00:01+00', 'wamid.st-livre', 'delivered'),
         ($1, 'out', 'template', 'whatsapp', 'itest_tpl_ancien', null, timestamptz '2026-09-05 09:04:00+00', 'wamid.st-m-sans-cat', 'read')`,
      [conversation],
    );
    const essai = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, last_message_at, control_owner, is_test)
       values ($1, '33600000799', now(), 'app_workflow', true) returning id`,
      [tenantId],
    )).rows[0]!.id;
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, channel, template_name, template_category, created_at, meta_message_id, statut)
       values ($1, 'out', 'template', 'whatsapp', 'itest_tpl_essai', 'utility', timestamptz '2026-09-05 09:00:00+00', 'wamid.st-essai', 'read')`,
      [essai],
    );
    // L'autre espace : un envoi le même jour, qu'on ne doit jamais voir.
    const contactAutre = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164) values ($1, '+33600000790') returning id`, [autreTenantId],
    )).rows[0]!.id;
    const campagneAutre = (await pool.query<{ id: string }>(
      `insert into campaigns (tenant_id, name, category, template_name, channel)
       values ($1, 'itest-statuts-autre', 'marketing', 'itest_tpl_autre', 'whatsapp') returning id`,
      [autreTenantId],
    )).rows[0]!.id;
    await pool.query(
      `insert into campaign_recipients (campaign_id, contact_id, to_e164, resolved_params, status, sent_at, message_id, delivery_status)
       values ($1, $2, '+33600000790', '{}'::jsonb, 'sent', timestamptz '2026-09-05 08:00:00+00', 'wamid.st-autre', 'read')`,
      [campagneAutre, contactAutre],
    );
  });

  afterAll(async () => {
    if (pool) {
      for (const t of [tenantId, autreTenantId]) if (t) await pool.query('delete from tenants where id = $1', [t]);
      await pool.end();
    }
  });

  it('🔴 jour par jour : envoyés, livrés (lus compris), lus, échecs datés, sans accusé ; les exclusions du tableau de bord', async () => {
    const lignes = await store.statutsDesModelesParJour(tenantId, RANGE);
    expect(lignes).toEqual([
      // Campagne : livré, lu, sans accusé, accusé « sent » (l'échec de Meta sort des envoyés) + refus à l'envoi ; la
      // ligne de la campagne à scénario n'est pas comptée.
      // Fil : livré, lu, échec, sans accusé, accusé « sent », et le modèle du scénario (lu) ; le doublon de la
      // campagne, le sans-catégorie et l'essai exclus.
      { date: '2026-09-05', envoyes: 10, livres: 5, lus: 3, echecs: 2, sansAccuse: 2 },
      { date: '2026-09-06', envoyes: 0, livres: 0, lus: 0, echecs: 1, sansAccuse: 0 },
    ]);
  });

  it('🔴 la population des envoyés est celle du tableau de bord : même total sur la période', async () => {
    const lignes = await store.statutsDesModelesParJour(tenantId, RANGE);
    const tableau = await store.getDashboard(tenantId, RANGE);
    const modelesDuTableau = [...tableau.templates.marketing, ...tableau.templates.utility].reduce((a, p) => a + p.count, 0);
    expect(lignes.reduce((a, l) => a + l.envoyes, 0)).toBe(modelesDuTableau);
  });

  it('🔴 un autre espace ne voit rien de celui-ci, et réciproquement', async () => {
    const autre = await store.statutsDesModelesParJour(autreTenantId, RANGE);
    expect(autre).toEqual([{ date: '2026-09-05', envoyes: 1, livres: 1, lus: 1, echecs: 0, sansAccuse: 0 }]);
  });
});
