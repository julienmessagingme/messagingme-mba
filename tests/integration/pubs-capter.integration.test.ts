import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgArriveesPubStore } from '../../src/pubs/arrivees.pg';
import { PgTarifsMetaStore } from '../../src/pubs/tarifs-meta.pg';

// Ne PAS lancer ce fichier en local : le DATABASE_URL du .env local pointe sur la base de PRODUCTION
// (cf. CLAUDE.md du dépôt). La CI monte un Postgres jetable pour ça (job `integration`).
const url = process.env.DATABASE_URL ?? '';

const arrivee = (messageId: string, surcharge: { ctwaClid?: string | null; enStandby?: boolean } = {}) => ({
  messageId, adId: '120212345678901234', sourceType: 'ad', titre: 'Offre itest', url: 'https://fb.me/itest',
  ctwaClid: 'clid-itest', enStandby: false, ...surcharge,
});

describe.skipIf(!url)('lot 1 des pubs : ce qui est capté à la réception (Postgres réel)', () => {
  let pool: Pool;
  let arrivees: PgArriveesPubStore;
  let tarifs: PgTarifsMetaStore;
  let tenantId = '';
  let autreTenantId = '';
  let contactId = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    arrivees = new PgArriveesPubStore(pool);
    tarifs = new PgTarifsMetaStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-pubs-capter') returning id`)).rows[0]!.id;
    autreTenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-pubs-voisin') returning id`)).rows[0]!.id;
    await pool.query(
      `insert into waba (id, tenant_id, name) values ('itest-waba-pubs', $1, 'w'), ('itest-waba-pubs-v', $2, 'w')`,
      [tenantId, autreTenantId],
    );
    await pool.query(
      `insert into phone_numbers (id, waba_id, tenant_id, display_phone_number) values
         ('itest-pn-pubs', 'itest-waba-pubs', $1, '+33525680401'),
         ('itest-pn-pubs-v', 'itest-waba-pubs-v', $2, '+33525680402')`,
      [tenantId, autreTenantId],
    );
    contactId = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164) values ($1, '+33600000501') returning id`, [tenantId],
    )).rows[0]!.id;
    await pool.query(`insert into contacts (tenant_id, bsuid) values ($1, 'itest-bsuid-pubs')`, [tenantId]);
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    if (autreTenantId) await pool.query('delete from tenants where id = $1', [autreTenantId]);
    await pool.end();
  });

  it('🔴 retrouve la fiche par son wa_id (chiffres nus contre E.164) et garde tout, ctwa_clid compris', async () => {
    expect(await arrivees.enregistrer(tenantId, '33600000501', arrivee('wamid.itest-a1'))).toBe('ecrite');
    const r = (await pool.query(
      `select contact_id, ad_id, source_type, titre, url, ctwa_clid, en_standby
         from arrivees_pub where tenant_id = $1 and meta_message_id = 'wamid.itest-a1'`,
      [tenantId],
    )).rows[0];
    expect(r).toEqual({
      contact_id: contactId, ad_id: '120212345678901234', source_type: 'ad', titre: 'Offre itest',
      url: 'https://fb.me/itest', ctwa_clid: 'clid-itest', en_standby: false,
    });
  });

  it('une fiche SANS numéro (BSUID seul) est retrouvée aussi', async () => {
    expect(await arrivees.enregistrer(tenantId, 'itest-bsuid-pubs', arrivee('wamid.itest-a2', { enStandby: true, ctwaClid: null })))
      .toBe('ecrite');
  });

  it('🔴 un webhook redélivré ne crée pas une seconde arrivée', async () => {
    expect(await arrivees.enregistrer(tenantId, '33600000501', arrivee('wamid.itest-a1'))).toBe('deja_vue');
    const n = (await pool.query<{ n: number }>(
      `select count(*)::int as n from arrivees_pub where tenant_id = $1 and meta_message_id = 'wamid.itest-a1'`, [tenantId],
    )).rows[0]!.n;
    expect(n).toBe(1);
  });

  it('aucune fiche pour ce wa_id : rien n’est écrit, et on le sait', async () => {
    expect(await arrivees.enregistrer(tenantId, '33699999999', arrivee('wamid.itest-a3'))).toBe('sans_contact');
  });

  it('🔴 cloisonné : le même wa_id chez un AUTRE espace ne trouve pas notre fiche', async () => {
    expect(await arrivees.enregistrer(autreTenantId, '33600000501', arrivee('wamid.itest-a4'))).toBe('sans_contact');
  });

  it('supprimer réellement la fiche supprime ses arrivées', async () => {
    const jetable = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164) values ($1, '+33600000502') returning id`, [tenantId],
    )).rows[0]!.id;
    expect(await arrivees.enregistrer(tenantId, '33600000502', arrivee('wamid.itest-a5'))).toBe('ecrite');
    await pool.query('delete from contacts where id = $1', [jetable]);
    const n = (await pool.query<{ n: number }>(
      `select count(*)::int as n from arrivees_pub where meta_message_id = 'wamid.itest-a5'`,
    )).rows[0]!.n;
    expect(n).toBe(0);
  });

  it('🔴 le tarif est rattaché à l’espace du numéro destinataire', async () => {
    await tarifs.enregistrer('itest-pn-pubs', { messageId: 'wamid.itest-t1', type: 'free_entry_point', categorie: 'referral_conversion', facturable: false, modele: 'PMP' });
    await tarifs.enregistrer('itest-pn-pubs-v', { messageId: 'wamid.itest-t2', type: 'regular', categorie: 'marketing', facturable: true, modele: 'PMP' });
    const rows = (await pool.query(
      `select tenant_id, wamid, type, categorie, facturable from tarifs_meta where wamid like 'wamid.itest-t%' order by wamid`,
    )).rows;
    expect(rows).toEqual([
      { tenant_id: tenantId, wamid: 'wamid.itest-t1', type: 'free_entry_point', categorie: 'referral_conversion', facturable: false },
      { tenant_id: autreTenantId, wamid: 'wamid.itest-t2', type: 'regular', categorie: 'marketing', facturable: true },
    ]);
  });

  it('le PREMIER accusé qui porte un tarif gagne (sent, delivered et read le répètent)', async () => {
    await tarifs.enregistrer('itest-pn-pubs', { messageId: 'wamid.itest-t1', type: 'regular', categorie: null, facturable: true, modele: null });
    const type = (await pool.query<{ type: string }>(`select type from tarifs_meta where wamid = 'wamid.itest-t1'`)).rows[0]!.type;
    expect(type).toBe('free_entry_point');
  });

  it('un numéro inconnu n’écrit rien (aucun espace à qui rattacher la ligne)', async () => {
    await tarifs.enregistrer('itest-pn-inconnu', { messageId: 'wamid.itest-t3', type: 'regular', categorie: null, facturable: null, modele: null });
    const n = (await pool.query<{ n: number }>(
      `select count(*)::int as n from tarifs_meta where wamid = 'wamid.itest-t3'`,
    )).rows[0]!.n;
    expect(n).toBe(0);
  });
});
