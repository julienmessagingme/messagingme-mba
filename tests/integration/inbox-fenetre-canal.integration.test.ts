import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgInboxStore } from '../../src/inbox/store.pg';

const url = process.env.DATABASE_URL ?? '';

/**
 * La fenêtre de service 24 h ne compte QUE les messages entrants WhatsApp.
 *
 * Le défaut réparé ici, signalé par Julien le 2026-08-25 : depuis la migration 0058 le fil est UNIQUE par
 * contact, donc les bulles RCS et WhatsApp cohabitent. La fenêtre de 24 h est pourtant une règle de
 * MESSAGERIE META, et Meta ne sait rien d'une réponse RCS. Sans filtre de canal, une suggestion RCS tapée par
 * le contact ouvrait la fenêtre WhatsApp à l'écran : l'opérateur lisait « ouvert », envoyait du texte libre,
 * et Meta le refusait en 131047. Mesuré sur la conversation réelle de Julien : dernier entrant tous canaux à
 * 15 h (fenêtre annoncée ouverte), dernier entrant WhatsApp à 50 h (fenêtre réellement fermée).
 *
 * Pourquoi en intégration et pas en unitaire : le filtre vit ENTIÈREMENT dans le SQL (`filter (where ...)`).
 * Un faux store dirait toujours ce qu'on lui fait dire, exactement l'angle mort que ce fichier existe pour
 * fermer.
 */
describe.skipIf(!url)('PgInboxStore : la fenêtre 24 h ignore les entrants RCS (Supabase)', () => {
  let pool: Pool;
  let tenantId: string;
  let store: PgInboxStore;

  const conversation = async (waId: string): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, last_message_at) values ($1, $2, now()) returning id`,
      [tenantId, waId],
    );
    return r.rows[0]!.id;
  };
  const message = async (
    conversationId: string,
    direction: 'in' | 'out',
    channel: 'whatsapp' | 'rcs',
    ilYAHeures: number,
  ): Promise<void> => {
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, body, channel, created_at)
       values ($1, $2, 'text', 'x', $3, now() - make_interval(hours => $4))`,
      [conversationId, direction, channel, ilYAHeures],
    );
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-fenetre-canal') returning id`)).rows[0]!.id;
    store = new PgInboxStore(pool);
  });
  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  it('🔴 un entrant RCS récent n’ouvre PAS la fenêtre quand le dernier entrant WhatsApp est vieux', async () => {
    const id = await conversation('33600000101');
    await message(id, 'in', 'whatsapp', 50); // vraie dernière réponse WhatsApp : hors fenêtre
    await message(id, 'in', 'rcs', 2);       // suggestion RCS tapée il y a 2 h

    const ctx = await store.getConversationContext(id, tenantId);
    expect(ctx?.windowOpen).toBe(false);
    // Et la date remontée est bien celle du WhatsApp, pas celle du RCS : l'écran affiche cette date.
    expect(new Date(ctx!.lastInboundAt!).getTime()).toBeLessThan(Date.now() - 40 * 3600 * 1000);
  });

  it('un entrant WhatsApp récent ouvre bien la fenêtre (non-régression du cas nominal)', async () => {
    const id = await conversation('33600000102');
    await message(id, 'in', 'whatsapp', 2);

    expect((await store.getConversationContext(id, tenantId))?.windowOpen).toBe(true);
  });

  it('une conversation qui n’a QUE des entrants RCS n’a jamais de fenêtre WhatsApp ouverte', async () => {
    const id = await conversation('33600000103');
    await message(id, 'in', 'rcs', 1);

    const ctx = await store.getConversationContext(id, tenantId);
    expect(ctx?.windowOpen).toBe(false);
    expect(ctx?.lastInboundAt).toBeNull();
  });

  it('nos propres envois n’ouvrent rien, quel que soit le canal', async () => {
    const id = await conversation('33600000104');
    await message(id, 'out', 'whatsapp', 1);
    await message(id, 'out', 'rcs', 1);

    expect((await store.getConversationContext(id, tenantId))?.windowOpen).toBe(false);
  });

  it('getWindowOpenByWaIds applique la MÊME règle (chemin /v1/sends, pas une seconde vérité)', async () => {
    const rcsSeul = await conversation('33600000105');
    await message(rcsSeul, 'in', 'whatsapp', 50);
    await message(rcsSeul, 'in', 'rcs', 1);
    const waRecent = await conversation('33600000106');
    await message(waRecent, 'in', 'whatsapp', 3);

    const map = await store.getWindowOpenByWaIds(tenantId, ['33600000105', '33600000106']);
    expect(map.get('33600000105')).toBe(false);
    expect(map.get('33600000106')).toBe(true);
  });
});
