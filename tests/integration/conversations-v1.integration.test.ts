import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgConversationsV1 } from '../../src/api/conversations-v1.pg';
import { decoderCurseur } from '../../src/api/conversations-v1';

const url = process.env.DATABASE_URL ?? '';

/**
 * LA LECTURE DES FILS PAR L'API EN BASE (lot 13, domaine 1) : ce que le faux des routes ne peut qu'affirmer.
 *  - 🔴 l'isolation : un fil, un message, une page d'un autre espace ne se lisent pas, même par leur identifiant ;
 *  - 🔴 la pagination : le curseur reprend pile où la page s'est arrêtée, horodatages égaux compris ;
 *  - un contact bloqué disparaît, comme dans l'Inbox ;
 *  - un message se lit par l'identifiant de Meta comme par le nôtre préfixé.
 *
 * Jamais joué en local (le DATABASE_URL local pointe la PRODUCTION), joué par le job `integration`.
 */
describe.skipIf(!url)('la lecture des fils par l’API (Postgres)', () => {
  let pool: Pool;
  let t1: string;
  let t2: string;
  let conv: string;
  let convBloquee: string;
  let convAutre: string;
  const depot = () => new PgConversationsV1(pool, () => Date.parse('2026-10-08T12:00:00Z'));

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    t1 = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-conv-v1') returning id`)).rows[0]!.id;
    t2 = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-conv-v1-autre') returning id`)).rows[0]!.id;
    const contact = async (t: string, tel: string, bloque = false) => (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164, profile_name, blocked_at) values ($1, $2, 'Claire', $3) returning id`,
      [t, tel, bloque ? new Date() : null],
    )).rows[0]!.id;
    const fil = async (t: string, wa: string, contactId: string, dernier: string) => (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, contact_id, last_message_at, last_direction, control_owner)
       values ($1, $2, $3, $4, 'in', 'app_human') returning id`,
      [t, wa, contactId, dernier],
    )).rows[0]!.id;
    conv = await fil(t1, '33600001301', await contact(t1, '+33600001301'), '2026-10-08T11:00:00Z');
    convBloquee = await fil(t1, '33600001302', await contact(t1, '+33600001302', true), '2026-10-08T11:30:00Z');
    convAutre = await fil(t2, '33600001303', await contact(t2, '+33600001303'), '2026-10-08T11:45:00Z');
    // Cinq messages dont trois au MÊME instant : le curseur doit les départager par l'identifiant.
    for (const [i, at] of ['2026-10-08T10:00:00Z', '2026-10-08T10:30:00Z', '2026-10-08T10:30:00Z', '2026-10-08T10:30:00Z', '2026-10-08T11:00:00Z'].entries()) {
      await pool.query(
        `insert into conversation_messages (conversation_id, direction, type, body, meta_message_id, created_at, channel)
         values ($1, 'in', 'text', $2, $3, $4, 'whatsapp')`,
        [conv, `m${i}`, i === 4 ? 'wamid.itest-conv-v1-dernier' : null, at],
      );
    }
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, body, meta_message_id) values ($1, 'in', 'text', 'ailleurs', 'wamid.itest-conv-v1-autre')`,
      [convAutre],
    );
  });

  afterAll(async () => {
    for (const t of [t1, t2]) if (t) await pool.query('delete from tenants where id = $1', [t]);
    await pool.end();
  });

  it('🔴 la liste ne montre que l’espace de la clé, sans le contact bloqué ; la fenêtre et le responsable sont lus', async () => {
    const p = await depot().lister(t1, { limite: 50, avant: null, aTraiter: false });
    expect(p.data.map((c) => c.id)).toEqual([conv]);
    expect(p.data[0]).toMatchObject({
      contact: { phone: '+33600001301', name: 'Claire' }, handledBy: 'team', needsReply: true, archived: false,
      windowExpiresAt: '2026-10-09T11:00:00.000Z',
    });
    expect(p.nextCursor).toBeNull();
    expect((await depot().lister(t1, { limite: 50, avant: null, aTraiter: true })).data.map((c) => c.id)).toEqual([conv]);
  });

  it('🔴 un fil d’un autre espace, ou d’un contact bloqué, ne se lit pas, même par son identifiant', async () => {
    expect(await depot().lire(t1, convAutre)).toBeNull();
    expect(await depot().lire(t1, convBloquee)).toBeNull();
    expect(await depot().messages(t1, convAutre, { limite: 50, avant: null })).toBeNull();
    expect(await depot().message(t1, 'wamid.itest-conv-v1-autre')).toBeNull();
    expect(await depot().message(t2, 'wamid.itest-conv-v1-autre')).toMatchObject({ text: 'ailleurs' });
  });

  it('🔴 les messages par pages de deux : le curseur reprend pile, à horodatage égal, sans doublon ni trou', async () => {
    const vus: string[] = [];
    let avant = null;
    for (let tour = 0; tour < 4; tour += 1) {
      const p = await depot().messages(t1, conv, { limite: 2, avant });
      expect(p).not.toBeNull();
      vus.push(...p!.data.map((m) => m.text ?? ''));
      if (p!.nextCursor === null) break;
      avant = decoderCurseur(p!.nextCursor);
      expect(avant).not.toBeNull();
    }
    expect(vus).toHaveLength(5);
    expect(new Set(vus).size).toBe(5);
    expect(vus[0]).toBe('m4');
    expect(vus[4]).toBe('m0');
  });

  it('un message se lit par l’identifiant de Meta comme par le nôtre préfixé', async () => {
    const parMeta = await depot().message(t1, 'wamid.itest-conv-v1-dernier');
    expect(parMeta).toMatchObject({ id: 'wamid.itest-conv-v1-dernier', text: 'm4', conversationId: conv, media: null });
    const page = await depot().messages(t1, conv, { limite: 5, avant: null });
    const sansMeta = page!.data.find((m) => m.id.startsWith('msg_'))!;
    expect(await depot().message(t1, sansMeta.id)).toMatchObject({ id: sansMeta.id, text: sansMeta.text });
    expect(await depot().message(t2, sansMeta.id)).toBeNull();
  });
});
