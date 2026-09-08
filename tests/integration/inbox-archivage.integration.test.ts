import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgInboxStore } from '../../src/inbox/store.pg';

/**
 * L'archivage d'une conversation (colonne `archived_at`, migration 0120).
 *
 * 🔴 CE QUE CES TESTS PROTÈGENT. Deux choses, et la seconde est celle qui se casserait en silence.
 *
 * D'abord qu'archiver RANGE sans rien effacer : la conversation sort des dossiers ordinaires, entre dans
 * Archivé, et le geste inverse la ramène.
 *
 * Ensuite, et c'est le point : qu'un message DU CONTACT la désarchive, et qu'un envoi SORTANT automatisé
 * ne le fasse pas. Les deux passent par le MÊME upsert (`upsertConversationByWaId`). Décider dans cette
 * dépendance partagée ferait remonter dans l'inbox de tout le monde chaque contact archivé qu'une campagne
 * touche, ce qui viderait le dossier Archivé au premier envoi de masse. Le dépôt applique déjà cette règle
 * aux événements d'automation, mot pour mot.
 *
 * Ce test tape la VRAIE base : un `case when` dans un `on conflict do update` ne se prouve pas en relisant
 * la chaîne de la requête, qui ne serait que sa propre copie.
 *
 * ⚠️ Ne PAS le lancer en local : le `DATABASE_URL` du `.env` local pointe sur la base de PRODUCTION, et ce
 * fichier crée et supprime des tenants. La CI monte un Postgres jetable pour ça (job `integration`).
 */
const url = process.env.DATABASE_URL ?? '';

const WA_ID = '33600000042';
const entrant = (messageId: string, body: string) => ({
  phoneNumberId: 'pn-itest', waId: WA_ID, messageId, type: 'text', body, buttonPayload: null, profileName: null,
  // 'messages' = un VRAI entrant, par opposition a 'standby' (un autre app tient le fil). C'est le cas qui
  // nous interesse : c'est celui qui doit desarchiver.
  field: 'messages',
});

describe.skipIf(!url)('archivage d une conversation', () => {
  let pool: Pool;
  let store: PgInboxStore;
  let tenantId = '';
  let autreTenantId = '';
  let convId = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    store = new PgInboxStore(pool);
    tenantId = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-inbox-archivage') returning id`,
    )).rows[0]!.id;
    autreTenantId = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-inbox-archivage-autre') returning id`,
    )).rows[0]!.id;
  });

  afterAll(async () => {
    for (const t of [tenantId, autreTenantId]) if (t) await pool.query('delete from tenants where id = $1', [t]);
    await pool.end();
  });

  // Une conversation NEUVE à chaque cas : l'archivage est un état, et deux cas qui se le passeraient
  // dépendraient de leur ordre d'exécution.
  beforeEach(async () => {
    await pool.query('delete from conversations where tenant_id = $1', [tenantId]);
    await store.recordInbound(tenantId, entrant('wamid.itest-init', 'bonjour'));
    convId = (await pool.query<{ id: string }>(
      'select id from conversations where tenant_id = $1 and wa_id = $2', [tenantId, WA_ID],
    )).rows[0]!.id;
  });

  const ids = async (opts?: { archivees?: boolean }): Promise<string[]> =>
    (await store.listConversations(tenantId, opts)).map((c) => c.id);

  it('🔴 archiver sort des dossiers ordinaires et met dans Archivé', async () => {
    expect(await store.archiverConversation(tenantId, convId, true)).toBe(true);
    expect(await ids()).not.toContain(convId);
    expect(await ids({ archivees: true })).toEqual([convId]);
  });

  it('désarchiver la remet dans les dossiers ordinaires, et la retire d’Archivé', async () => {
    await store.archiverConversation(tenantId, convId, true);
    expect(await store.archiverConversation(tenantId, convId, false)).toBe(true);
    expect(await ids()).toContain(convId);
    expect(await ids({ archivees: true })).toEqual([]);
  });

  it('🔴 un MESSAGE DU CONTACT désarchive, dans la même écriture que celle qui avance le fil', async () => {
    // La décision de Julien, et le point le plus facile à casser plus tard : une conversation archivée que
    // le client relance doit revenir, sinon on l'a rendue muette.
    await store.archiverConversation(tenantId, convId, true);
    await store.recordInbound(tenantId, entrant('wamid.itest-retour', 'vous êtes là ?'));
    expect(await ids()).toContain(convId);
    expect(await ids({ archivees: true })).toEqual([]);
  });

  it('🔴 PREUVE INVERSE : un envoi SORTANT automatisé ne désarchive PAS', async () => {
    // `recordInbound` et `recordOutboundByWaId` partagent le MÊME upsert. Sans une décision prise par le
    // CHEMIN appelant, une campagne qui touche mille contacts ferait remonter dans l'inbox tous ceux qu'on
    // avait rangés, et le dossier Archivé se viderait au premier envoi de masse.
    await store.archiverConversation(tenantId, convId, true);
    await store.recordOutboundByWaId(tenantId, WA_ID, {
      body: 'notre promo du mois', messageId: 'wamid.itest-promo', origine: 'campagne',
    });
    expect(await ids()).not.toContain(convId);
    expect(await ids({ archivees: true })).toEqual([convId]);
  });

  it('🔴 une conversation d’un AUTRE espace ne s’archive pas', async () => {
    // Le pooler est superuser, la RLS est contournée : ce `tenant_id` dans le `where` est LE contrôle.
    expect(await store.archiverConversation(autreTenantId, convId, true)).toBe(false);
    expect(await ids()).toContain(convId);
  });

  it('une conversation inconnue rend false, pour que la route en fasse un 404', async () => {
    expect(await store.archiverConversation(tenantId, '00000000-0000-4000-8000-000000000000', true)).toBe(false);
  });
});
