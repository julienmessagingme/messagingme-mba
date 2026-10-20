import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgInboxStore } from '../../src/inbox/store.pg';

const url = process.env.DATABASE_URL ?? '';

/**
 * LA PÉRIODE DU DERNIER MESSAGE ET LE CONTACT DE CHAQUE CONVERSATION (plan « Campagnes depuis Claude », tâche 3),
 * contre une vraie base : ce que l'assistant lit pour désigner les contacts d'un thème. `depuis` incluse, `jusqua`
 * exclue, la garde d'espace posée. Jamais joué en local (le `DATABASE_URL` local pointe la PRODUCTION), joué par le
 * job `integration`.
 */
describe.skipIf(!url)('PgInboxStore : période et contact (Postgres)', () => {
  let pool: Pool;
  let store: PgInboxStore;
  let tenantId = '';
  let autreTenant = '';
  let contactId = '';
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 3 });
    store = new PgInboxStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-periode') returning id`)).rows[0]!.id;
    autreTenant = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-periode-autre') returning id`)).rows[0]!.id;
    contactId = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164) values ($1, '+33600009101') returning id`, [tenantId],
    )).rows[0]!.id;
    const fil = async (tenant: string, wa: string, at: string, contact: string | null) => (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, contact_id, last_message_at, last_direction) values ($1, $2, $3, $4::timestamptz, 'in') returning id`,
      [tenant, wa, contact, at],
    )).rows[0]!.id;
    ids.avant = await fil(tenantId, '33600009100', '2026-10-12T21:59:59.999999Z', null);
    ids.debut = await fil(tenantId, '33600009101', '2026-10-12T22:00:00.000000Z', contactId);
    ids.milieu = await fil(tenantId, '33600009102', '2026-10-15T10:00:00.000000Z', null);
    ids.fin = await fil(tenantId, '33600009103', '2026-10-19T22:00:00.000000Z', null);
    ids.autre = await fil(autreTenant, '33600009104', '2026-10-15T10:00:00.000000Z', null);
  });

  afterAll(async () => {
    for (const t of [tenantId, autreTenant]) if (t) await pool.query('delete from tenants where id = $1', [t]).catch(() => {});
    await pool.end().catch(() => {});
  });

  it('depuis incluse, jusqua exclue, et rien d’un autre espace', async () => {
    const page = await store.listConversations(tenantId, { depuis: '2026-10-12T22:00:00.000Z', jusqua: '2026-10-19T22:00:00.000Z' });
    expect(page.map((c) => c.id)).toEqual([ids.milieu, ids.debut]);
  });

  it('chaque conversation rend sa fiche, null quand elle n’en a pas', async () => {
    const page = await store.listConversations(tenantId, { depuis: '2026-10-12T22:00:00.000Z', jusqua: '2026-10-19T22:00:00.000Z' });
    expect(page.find((c) => c.id === ids.debut)?.contactId).toBe(contactId);
    expect(page.find((c) => c.id === ids.milieu)?.contactId).toBeNull();
  });

  it('🔴 les fiches de conversations désignées : sans doublon, sans fiche nulle, rien d’un autre espace', async () => {
    expect(await store.contactIdsDesConversations(tenantId, [ids.debut!, ids.debut!, ids.milieu!, ids.autre!])).toEqual([contactId]);
    expect(await store.contactIdsDesConversations(autreTenant, [ids.debut!])).toEqual([]);
  });

  it('la période se combine avec le curseur : la page suivante reste dans la période', async () => {
    const p1 = await store.listConversations(tenantId, { depuis: '2026-10-12T22:00:00.000Z', limit: 1 });
    expect(p1.map((c) => c.id)).toEqual([ids.fin]);
    const p2 = await store.listConversations(tenantId, { depuis: '2026-10-12T22:00:00.000Z', limit: 5, before: { at: p1[0]!.curseur!, id: p1[0]!.id } });
    expect(p2.map((c) => c.id)).toEqual([ids.milieu, ids.debut]);
  });
});
