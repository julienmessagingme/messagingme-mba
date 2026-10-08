import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgAdressesEvenementsStore, PgEnvoisEvenementsStore } from '../../src/evenements/store.pg';
import { PgContactStore } from '../../src/crm/contact-store.pg';

const url = process.env.DATABASE_URL ?? '';

/**
 * LES WEBHOOKS SORTANTS, contre un VRAI Postgres (lot 12, livraison A, migration 0223).
 *
 * ⚠️ Jamais joué en local (le `DATABASE_URL` local pointe la PRODUCTION) : joué par le job `integration`.
 */
describe.skipIf(!url)('webhooks sortants : adresses et envois (Postgres)', () => {
  let pool: Pool;
  let adresses: PgAdressesEvenementsStore;
  let envois: PgEnvoisEvenementsStore;
  let tenantId: string;
  let autreTenantId: string;
  let contactId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    adresses = new PgAdressesEvenementsStore(pool);
    envois = new PgEnvoisEvenementsStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-evenements') returning id`)).rows[0]!.id;
    autreTenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-evenements-autre') returning id`)).rows[0]!.id;
    contactId = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164, profile_name) values ($1, '+33600000771', 'Claire') returning id`,
      [tenantId],
    )).rows[0]!.id;
    const conversationId = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, contact_id) values ($1, '33600000771', $2) returning id`,
      [tenantId, contactId],
    )).rows[0]!.id;
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, body, meta_message_id)
       values ($1, 'in', 'text', 'Bonjour, mon colis ?', 'wamid.itest.evenements.1')`,
      [conversationId],
    );
  });

  afterAll(async () => {
    for (const t of [tenantId, autreTenantId]) if (t) await pool.query('delete from tenants where id = $1', [t]);
    await pool.end();
  });

  it('🔴 une adresse se crée et se lit sans son secret ; un autre espace ne la voit pas', async () => {
    const a = await adresses.creer(tenantId, { url: 'https://app.client.fr/hook', description: 'prod', types: ['message.received'], secretChiffre: 'chiffre-1' });
    expect(a).toMatchObject({ url: 'https://app.client.fr/hook', types: ['message.received'], active: true, enReessai: 0, echecs: 0 });
    expect(JSON.stringify(await adresses.lister(tenantId))).not.toContain('chiffre-1');
    expect(await adresses.lister(autreTenantId)).toEqual([]);
    expect(await adresses.lire(autreTenantId, a.id)).toBeNull();
    expect(await adresses.supprimer(autreTenantId, a.id)).toBe(false);
    expect((await adresses.espacesEtTypes()).get(tenantId)).toEqual(new Set(['message.received']));
    await adresses.supprimer(tenantId, a.id);
  });

  it('🔴 le rang suit l’ordre de création : c’est lui qui gèle les plus récentes au-delà de l’offre', async () => {
    const a1 = await adresses.creer(tenantId, { url: 'https://a.client.fr/h', description: '', types: ['link.clicked'], secretChiffre: 'c' });
    const a2 = await adresses.creer(tenantId, { url: 'https://b.client.fr/h', description: '', types: ['link.clicked'], secretChiffre: 'c' });
    expect((await adresses.pourEnvoi(tenantId, a1.id))?.rang).toBe(1);
    expect((await adresses.pourEnvoi(tenantId, a2.id))?.rang).toBe(2);
    expect((await adresses.activesPourDistribution(tenantId)).map((a) => a.id)).toEqual([a1.id, a2.id]);
    await adresses.supprimer(tenantId, a1.id);
    await adresses.supprimer(tenantId, a2.id);
  });

  it('🔴 un envoi n’est créé qu’une fois par (adresse, événement), et une tentative périmée n’écrase rien', async () => {
    const a = await adresses.creer(tenantId, { url: 'https://app.client.fr/hook', description: '', types: ['message.received'], secretChiffre: 'c' });
    const ligne = { tenantId, adresseId: a.id, evenementId: 'evt_itest_1', type: 'message.received' as const, contactId, corps: '{"id":"evt_itest_1"}' };
    const crees = await envois.creer([ligne]);
    expect(crees).toHaveLength(1);
    // Jamais tentée : une distribution rejouée la rend encore (son job a pu se perdre) ; une fois tentée, plus jamais.
    expect((await envois.creer([ligne])).map((r) => r.id)).toEqual([crees[0]!.id]);

    const id = crees[0]!.id;
    await envois.noter(tenantId, id, 0, { statut: 'en_cours', code: 503, extrait: 'oups', prochainEssai: new Date(Date.now() + 30_000) });
    // La même tentative rejouée (un job en double) : la ligne en est à 1, rien ne bouge.
    await envois.noter(tenantId, id, 0, { statut: 'livre', code: 200, extrait: '', prochainEssai: null });
    let e = await envois.pourEnvoi(tenantId, id);
    expect(e).toMatchObject({ statut: 'en_cours', tentatives: 1, corps: '{"id":"evt_itest_1"}' });
    expect(await envois.creer([ligne])).toEqual([]);
    // En cours, essai programmé : pas un orphelin, il ne se rejoue pas ; en retard de plus de 15 minutes, si.
    expect(await envois.rejouer(tenantId, id)).toBeNull();
    await pool.query(`update envois_evenements set prochain_essai_le = now() - interval '20 minutes' where id = $1`, [id]);
    expect(await envois.rejouer(tenantId, id)).toEqual({ tentative: 1 });
    await envois.noter(tenantId, id, 1, { statut: 'livre', code: 200, extrait: '', prochainEssai: null });
    e = await envois.pourEnvoi(tenantId, id);
    expect(e).toMatchObject({ statut: 'livre', tentatives: 2 });
    expect(await envois.pourEnvoi(autreTenantId, id)).toBeNull();

    // Un rejeu rouvre la fenêtre et rend la tentative à faire ; un envoi déjà en cours ne se rejoue pas.
    expect(await envois.rejouer(tenantId, id)).toEqual({ tentative: 2 });
    expect(await envois.rejouer(tenantId, id)).toBeNull();
    expect(await envois.rejouer(autreTenantId, id)).toBeNull();
    await adresses.supprimer(tenantId, a.id);
  });

  it('le message reçu se relit par l’espace, jamais par le seul identifiant de Meta', async () => {
    expect(await envois.messageRecu(tenantId, 'wamid.itest.evenements.1')).toEqual({ type: 'text', text: 'Bonjour, mon colis ?', transcription: null });
    expect(await envois.messageRecu(autreTenantId, 'wamid.itest.evenements.1')).toBeNull();
  });

  it('🔴 la purge du journal suit l’offre : un espace en Base garde 3 jours', async () => {
    const a = await adresses.creer(tenantId, { url: 'https://app.client.fr/hook', description: '', types: ['message.received'], secretChiffre: 'c' });
    const [vieux, recent] = await envois.creer([
      { tenantId, adresseId: a.id, evenementId: 'evt_itest_vieux', type: 'message.received', contactId: null, corps: '{}' },
      { tenantId, adresseId: a.id, evenementId: 'evt_itest_recent', type: 'message.received', contactId: null, corps: '{}' },
    ]);
    await pool.query(`update envois_evenements set cree_le = now() - interval '4 days' where id = $1`, [vieux!.id]);
    await envois.purger({ base: 3, pro: 30, entreprise: 30 });
    expect(await envois.pourEnvoi(tenantId, vieux!.id)).toBeNull();
    expect(await envois.pourEnvoi(tenantId, recent!.id)).not.toBeNull();
    await adresses.supprimer(tenantId, a.id);
  });

  it('🔴 la purge RGPD d’un contact efface ses envois : leur corps porte son numéro et ses messages', async () => {
    const a = await adresses.creer(tenantId, { url: 'https://app.client.fr/hook', description: '', types: ['message.received'], secretChiffre: 'c' });
    const [envoi] = await envois.creer([{ tenantId, adresseId: a.id, evenementId: 'evt_itest_rgpd', type: 'message.received', contactId, corps: '{"phone":"+33600000771"}' }]);
    await new PgContactStore(pool).purgeMany(tenantId, [contactId]);
    expect(await envois.pourEnvoi(tenantId, envoi!.id)).toBeNull();
    await adresses.supprimer(tenantId, a.id);
  });

  it('un espace supprimé emporte ses adresses et ses envois (cascade)', async () => {
    const t = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-evenements-cascade') returning id`)).rows[0]!.id;
    const a = await adresses.creer(t, { url: 'https://app.client.fr/hook', description: '', types: ['message.received'], secretChiffre: 'c' });
    await envois.noterEssai(t, a.id, { evenementId: 'evt_itest_essai', corps: '{}', livre: true, code: 200, extrait: '' });
    await pool.query('delete from tenants where id = $1', [t]);
    expect((await pool.query('select 1 from envois_evenements where tenant_id = $1', [t])).rowCount).toBe(0);
    expect((await pool.query('select 1 from adresses_evenements where tenant_id = $1', [t])).rowCount).toBe(0);
  });
});
