import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgSignauxStore } from '../../src/signaux/store.pg';
import { PgIntegrationBatchStore } from '../../src/signaux/integration-batch.pg';
import { PgJournalAppels } from '../../src/agent/catalog.pg';
import { PgErreursLivraisonStore } from '../../src/ops/erreurs-livraison.pg';
import { PgTrackedLinkStore } from '../../src/links/tracked-links.pg';
import { NOM_APPEL_SIGNAUX } from '../../src/signaux/types';

const url = process.env.DATABASE_URL ?? '';

/**
 * LES LECTURES DES SIGNAUX ET LE RÉGLAGE, contre un VRAI Postgres (lot 6 de l'API publique).
 *
 * ⚠️ Jamais joué en local (le `DATABASE_URL` local pointe la PRODUCTION) : joué par le job `integration`.
 */
describe.skipIf(!url)('signaux : lectures et réglage (Postgres)', () => {
  let pool: Pool;
  let lectures: PgSignauxStore;
  let reglages: PgIntegrationBatchStore;
  let tenantId: string;
  let autreTenantId: string;
  let contactId: string;
  let conversationId: string;
  let campagneId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    lectures = new PgSignauxStore(pool);
    reglages = new PgIntegrationBatchStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-signaux') returning id`)).rows[0]!.id;
    autreTenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-signaux-autre') returning id`)).rows[0]!.id;
    contactId = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164, external_id, opt_in_status, opt_in_source)
       values ($1, '+33600000881', 'crm-itest-1', 'opted_out', 'whatsapp_stop') returning id`,
      [tenantId],
    )).rows[0]!.id;
    conversationId = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, contact_id) values ($1, '33600000881', $2) returning id`,
      [tenantId, contactId],
    )).rows[0]!.id;
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, body, meta_message_id, origin)
       values ($1, 'out', 'text', 'x', 'wamid.itest.signaux.1', 'api')`,
      [conversationId],
    );
    campagneId = (await pool.query<{ id: string }>(
      `insert into campaigns (tenant_id, name, category, status) values ($1, 'itest-signaux', 'utility', 'completed') returning id`,
      [tenantId],
    )).rows[0]!.id;
    const destinataireId = (await pool.query<{ id: string }>(
      `insert into campaign_recipients (campaign_id, contact_id, to_e164, status, message_id)
       values ($1, $2, '+33600000881', 'sent', 'wamid.itest.signaux.1') returning id`,
      [campagneId, contactId],
    )).rows[0]!.id;
    // Une chaîne de repli : l'étage 1 est parti sous un AUTRE identifiant, que `campaign_recipients.message_id`
    // (la dernière tentative) ne garde plus. Seul le journal des tentatives (0134) le connaît encore.
    await pool.query(
      `insert into campaign_envois (campaign_id, recipient_id, contact_id, rang, canal, statut, message_id)
       values ($1, $2, $3, 1, 'whatsapp', 'sent', 'wamid.itest.signaux.etage1'),
              ($1, $2, $3, 2, 'rcs', 'sent', 'wamid.itest.signaux.1')`,
      [campagneId, destinataireId, contactId],
    );
    await pool.query(
      `insert into conversation_analysis (conversation_id, tenant_id, sentiment, intent, topic, resolved, handled_by,
         exchanges_count, action_suggestion, confidence, justification, llm_provider, llm_model, summary, satisfaction, urgence)
       values ($1, $2, 'positif', 'sav', 'livraison', true, 'humain', 4, 'aucune', 0.9, 'j', 'test', 'test', 'Résumé.', null, 3)`,
      [conversationId, tenantId],
    );
  });

  afterAll(async () => {
    for (const t of [tenantId, autreTenantId]) if (t) await pool.query('delete from tenants where id = $1', [t]);
    await pool.end();
  });

  it('la fiche se retrouve par wa_id, avec son identifiant externe et son consentement', async () => {
    expect(await lectures.ficheParWaId(tenantId, '33600000881')).toEqual({
      contactId, externalId: 'crm-itest-1', optOutWhatsapp: true, optOutRcs: false, optInSource: 'whatsapp_stop',
    });
    expect((await lectures.ficheParId(tenantId, contactId))?.externalId).toBe('crm-itest-1');
  });

  it('🔴 la fiche d’un espace n’est jamais rendue à un autre', async () => {
    expect(await lectures.ficheParWaId(autreTenantId, '33600000881')).toBeNull();
    expect(await lectures.ficheParId(autreTenantId, contactId)).toBeNull();
    expect(await lectures.waIdDeLaConversation(autreTenantId, conversationId)).toBeNull();
  });

  it('le contexte d’un message : son origine et son envoi', async () => {
    expect(await lectures.contexteDuMessage(tenantId, 'wamid.itest.signaux.1')).toEqual({ origine: 'api', sendId: campagneId });
  });

  it('🔴 le contexte d’un message d’un autre espace reste vide', async () => {
    expect(await lectures.contexteDuMessage(autreTenantId, 'wamid.itest.signaux.1')).toEqual({ origine: null, sendId: null });
  });

  it('🔴 l’accusé d’un étage REMPLACÉ d’une chaîne de repli retrouve quand même son envoi', async () => {
    expect(await lectures.contexteDuMessage(tenantId, 'wamid.itest.signaux.etage1')).toEqual({ origine: null, sendId: campagneId });
    expect(await lectures.contexteDuMessage(autreTenantId, 'wamid.itest.signaux.etage1')).toEqual({ origine: null, sendId: null });
  });

  it('l’analyse relue garde null pour une note absente', async () => {
    expect(await lectures.analyse(tenantId, conversationId)).toMatchObject({ intent: 'sav', satisfaction: null, urgence: 3, summary: 'Résumé.' });
    expect(await lectures.analyse(autreTenantId, conversationId)).toBeNull();
    expect(await lectures.waIdDeLaConversation(tenantId, conversationId)).toBe('33600000881');
  });

  it('le lien : son template et sa destination, dans son espace seulement', async () => {
    const code = await new PgTrackedLinkStore(pool).allocate(
      tenantId, 'itestsig0001', { templateName: 'promo', templateLanguage: 'fr', cardIndex: null, buttonIndex: 0 }, 'https://client.fr/promo', true,
    );
    expect(await lectures.lien(tenantId, code)).toEqual({ template: 'promo', destination: 'https://client.fr/promo' });
    expect(await lectures.lien(autreTenantId, code)).toBeNull();
  });

  it('🔴 un premier branchement sans les deux clés n’écrit rien', async () => {
    expect(await reglages.enregistrer(autreTenantId, { cleRestChiffree: 'x', cleProjetChiffree: null, envoyerResume: false })).toBe(false);
    expect(await reglages.lire(autreTenantId)).toBeNull();
  });

  it('brancher, relire SANS secret, puis modifier l’option sans renvoyer les clés', async () => {
    expect(await reglages.enregistrer(tenantId, { cleRestChiffree: 'chiffre-rest', cleProjetChiffree: 'chiffre-projet', envoyerResume: false })).toBe(true);
    const vue = await reglages.lire(tenantId);
    expect(vue).toMatchObject({ envoyerResume: false, sansIdentifiant: 0, sansIdentifiantLe: null, refusClesLe: null });
    expect(JSON.stringify(vue)).not.toContain('chiffre-');
    expect(await reglages.enregistrer(tenantId, { cleRestChiffree: null, cleProjetChiffree: null, envoyerResume: true })).toBe(true);
    expect(await reglages.secrets(tenantId)).toMatchObject({ cleRestChiffree: 'chiffre-rest', cleProjetChiffree: 'chiffre-projet', envoyerResume: true });
  });

  it('🔴 un espace dont les clés sont refusées sort des espaces actifs, et une clé neuve l’y remet', async () => {
    expect((await reglages.espacesActifs()).has(tenantId)).toBe(true);
    await reglages.suspendre(tenantId);
    expect((await reglages.espacesActifs()).has(tenantId)).toBe(false);
    expect((await reglages.lire(tenantId))?.refusClesLe).not.toBeNull();
    // Changer l'option seule ne lève PAS la suspension : ce ne sont pas de nouvelles clés.
    await reglages.enregistrer(tenantId, { cleRestChiffree: null, cleProjetChiffree: null, envoyerResume: false });
    expect((await reglages.espacesActifs()).has(tenantId)).toBe(false);
    await reglages.enregistrer(tenantId, { cleRestChiffree: 'chiffre-rest-2', cleProjetChiffree: null, envoyerResume: false });
    expect((await reglages.espacesActifs()).has(tenantId)).toBe(true);
  });

  it('le compte des signaux sans identifiant s’additionne et se date', async () => {
    await reglages.noterSansIdentifiant(tenantId, 2);
    await reglages.noterSansIdentifiant(tenantId, 3);
    const vue = await reglages.lire(tenantId);
    expect(vue?.sansIdentifiant).toBe(5);
    expect(vue?.sansIdentifiantLe).not.toBeNull();
  });

  it('🔴 le journal accepte la source signaux (CHECK relâché), et le journal des erreurs la rend', async () => {
    const journal = new PgJournalAppels(pool);
    const id = await journal.ouvrir({
      tenantId, sessionId: null, toolId: null, toolName: NOM_APPEL_SIGNAUX, origin: 'http',
      argsRediges: { signaux: 1, noms: 'em_replied', em_event_id: 'e' }, source: 'signaux',
    });
    await journal.clore({ tenantId, id, status: 'refuse', httpStatus: 401, dureeMs: 50, erreur: 'l’outil branché a répondu 401' });
    const lignes = await new PgErreursLivraisonStore(pool).listerEchecsSysteme(tenantId);
    expect(lignes.map((l) => l.source)).toContain('signaux');
  });

  it('supprimer le réglage', async () => {
    expect(await reglages.supprimer(tenantId)).toBe(true);
    expect(await reglages.supprimer(tenantId)).toBe(false);
    expect(await reglages.lire(tenantId)).toBeNull();
  });
});
