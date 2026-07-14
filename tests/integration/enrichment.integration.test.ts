import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { getEnrichment } from '../../src/analysis/enrichment';

const url = process.env.DATABASE_URL ?? '';

// Lot A (côté mba) : la requête d'enrichissement que le push d'analyse envoie au connecteur.
describe.skipIf(!url)('getEnrichment (Supabase)', () => {
  let pool: Pool;
  let tenantId: string;
  let convId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-enrich') returning id`)).rows[0]!.id;
    await pool.query(`insert into waba (id, tenant_id, name) values ('itest-waba-enrich', $1, 'w')`, [tenantId]);
    await pool.query(`insert into phone_numbers (id, waba_id, tenant_id, display_phone_number) values ('itest-pn-enrich', 'itest-waba-enrich', $1, '+33525680250')`, [tenantId]);
    const contactId = (await pool.query<{ id: string }>(`insert into contacts (tenant_id, phone_e164, profile_name) values ($1, '+33600000009', 'Jean') returning id`, [tenantId])).rows[0]!.id;
    // wa_id = chiffres BRUTS sans `+` (forme réelle du webhook Meta) -> getEnrichment doit normaliser en E.164.
    convId = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, contact_id, last_message_at, analyzed_at) values ($1, '33600000009', $2, now(), now()) returning id`,
      [tenantId, contactId],
    )).rows[0]!.id;
    // un entrant ancien, un SORTANT récent (doit être ignoré), un entrant = le dernier message client
    await pool.query(`insert into conversation_messages (conversation_id, direction, type, body, created_at) values ($1,'in','text','a', now() - interval '3 min')`, [convId]);
    await pool.query(`insert into conversation_messages (conversation_id, direction, type, body, created_at) values ($1,'out','text','b', now())`, [convId]);
    await pool.query(`insert into conversation_messages (conversation_id, direction, type, body, created_at) values ($1,'in','text','c', now() - interval '1 min')`, [convId]);
  });
  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  it('renvoie identité + ligne WhatsApp + dernier message ENTRANT (le sortant est ignoré)', async () => {
    const e = await getEnrichment(pool, convId);
    expect(e).not.toBeNull();
    expect(e!.contactE164).toBe('+33600000009'); // normalisé depuis le wa_id brut '33600000009'
    expect(e!.profileName).toBe('Jean');
    expect(e!.whatsappLine).toBe('+33525680250');
    expect(e!.analyzedAt).not.toBeNull();
    // lastInboundAt = l'entrant à -1 min, PAS le sortant à now()
    const lastIn = (await pool.query<{ mx: string }>(`select max(created_at)::text mx from conversation_messages where conversation_id=$1 and direction='in'`, [convId])).rows[0]!.mx;
    expect(e!.lastInboundAt).toBe(lastIn);
  });

  it('conversation inexistante -> null', async () => {
    expect(await getEnrichment(pool, '00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});
