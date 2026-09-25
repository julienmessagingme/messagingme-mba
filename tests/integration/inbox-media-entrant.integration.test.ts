import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgInboxStore } from '../../src/inbox/store.pg';

/**
 * Les pièces jointes reçues, côté base (migration 0160, plan 2026-09-19).
 *
 * 🔴 CE QUE CES TESTS PROTÈGENT, ET QU'AUCUN TEST UNITAIRE NE VOIT : que le nom d'un document soit ÉCRIT à la
 * réception (il n'existe nulle part ailleurs), et que « expiré » soit calculé par la base sur l'âge du
 * message, avec le même fragment pour l'écran et pour la lecture du fichier. Un `now() - make_interval(...)`
 * ne se prouve pas en relisant la chaîne.
 *
 * ⚠️ Ne PAS le lancer en local : le `DATABASE_URL` du `.env` local pointe sur la base de PRODUCTION, et ce
 * fichier crée et supprime des tenants. La CI monte un Postgres jetable pour ça (job `integration`).
 */
const url = process.env.DATABASE_URL ?? '';
const WA_ID = '33600000161';

describe.skipIf(!url)('les pièces jointes reçues', () => {
  let pool: Pool;
  let store: PgInboxStore;
  let tenantId = '';
  let convId = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    store = new PgInboxStore(pool);
    tenantId = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-inbox-media') returning id`,
    )).rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('delete from conversations where tenant_id = $1', [tenantId]);
    await store.recordInbound(tenantId, {
      phoneNumberId: 'pn', waId: WA_ID, messageId: 'wamid.itest-media-doc', type: 'document', body: '[document]',
      buttonPayload: null, profileName: null, field: 'messages',
      media: { id: 'media-doc-1', mime: 'application/pdf', nom: 'facture-mars.pdf' },
    });
    await store.recordInbound(tenantId, {
      phoneNumberId: 'pn', waId: WA_ID, messageId: 'wamid.itest-media-txt', type: 'text', body: 'et voilà',
      buttonPayload: null, profileName: null, field: 'messages',
    });
    convId = (await pool.query<{ id: string }>(
      'select id from conversations where tenant_id = $1 and wa_id = $2', [tenantId, WA_ID],
    )).rows[0]!.id;
  });

  const parType = async (type: string) => (await store.getMessages(convId)).find((m) => m.type === type)!;

  it('🔴 le nom du document est écrit à la réception, et relu par le fil', async () => {
    expect((await parType('document')).mediaNom).toBe('facture-mars.pdf');
  });

  it('un média de moins de sept jours n’est pas expiré', async () => {
    expect((await parType('document')).mediaExpire).toBe(false);
  });

  it('🔴 passé sept jours, le fil dit « expiré », et la lecture du fichier aussi', async () => {
    // Le même fragment sert aux deux lecteurs : s'ils divergeaient, l'écran annoncerait « expiré » pendant
    // que la route irait encore chercher le fichier chez Meta, ou l'inverse.
    await pool.query(
      `update conversation_messages set created_at = now() - interval '8 days' where meta_message_id = 'wamid.itest-media-doc'`,
    );
    const doc = await parType('document');
    expect(doc.mediaExpire).toBe(true);
    const lu = await store.lireMessagePourTranscription(tenantId, doc.id, convId);
    expect(lu).toMatchObject({ mediaExpire: true, mediaNom: 'facture-mars.pdf' });
  });

  it('un message SANS média n’est jamais « expiré », même vieux', async () => {
    // Sinon l'écran annoncerait un fichier disparu sur un simple texte.
    await pool.query(
      `update conversation_messages set created_at = now() - interval '30 days' where meta_message_id = 'wamid.itest-media-txt'`,
    );
    expect((await parType('text')).mediaExpire).toBe(false);
  });
});
