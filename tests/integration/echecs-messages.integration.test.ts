import '../../src/charger-env';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgEchecsMessagesStore } from '../../src/delivery/echecs-messages.pg';
import { PgErreursLivraisonStore } from '../../src/ops/erreurs-livraison.pg';

const url = process.env.DATABASE_URL ?? '';

/**
 * LES ÉCHECS DE LIVRAISON DES MESSAGES LIBRES (migration 0175, défaut 4 de la spec 2026-09-24).
 *
 * En intégration parce que tout ce qui compte est du SQL : retrouver le message par son identifiant, exclure
 * les entrants et les envois de campagne, l'idempotence par l'index unique, le rattachement du contact par la
 * règle de routage des entrants, le scope tenant et les filtres. Jamais joué en local.
 */
describe.skipIf(!url)('échecs des messages libres (Postgres)', () => {
  let pool: Pool;
  let store: PgEchecsMessagesStore;
  let tenantId = '';
  let autreTenant = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 3 });
    store = new PgEchecsMessagesStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-echecs-libres') returning id`)).rows[0]!.id;
    autreTenant = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-echecs-libres-2') returning id`)).rows[0]!.id;
  });

  afterAll(async () => {
    for (const t of [tenantId, autreTenant]) if (t) await pool.query('delete from tenants where id = $1', [t]).catch(() => {});
    await pool.end().catch(() => {});
  });

  /** Un message du fil de `waId`, comme l'écrit `recordOutbound`. Rend son identifiant. */
  async function message(tenant: string, waId: string, o: { canal?: 'whatsapp' | 'rcs'; origine?: string | null; direction?: 'in' | 'out' } = {}): Promise<string> {
    const conv = await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id) values ($1, $2)
       on conflict (tenant_id, wa_id) do update set wa_id = excluded.wa_id returning id`,
      [tenant, waId],
    );
    const id = `itest-${randomUUID()}`;
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, body, meta_message_id, channel, origin)
       values ($1, $2, 'text', 'Bonjour', $3, $4, $5)`,
      [conv.rows[0]!.id, o.direction ?? 'out', id, o.canal ?? 'whatsapp', o.direction === 'in' ? null : (o.origine === undefined ? 'api' : o.origine)],
    );
    return id;
  }

  it('🔴 un échec de message SORTANT est écrit, et relu avec l’origine « message »', async () => {
    const id = await message(tenantId, '33600000501', { canal: 'rcs', origine: 'api' });
    expect(await store.noter({ messageId: id, code: null, motif: 'UNDELIVERABLE' }))
      .toEqual({ tenantId, waId: '33600000501', canal: 'rcs', origine: 'api' });
    const ligne = (await store.lister(tenantId, {}, 100)).find((e) => e.telephone === '33600000501');
    expect(ligne).toMatchObject({ origine: 'message', origineMessage: 'api', canal: 'rcs', message: 'UNDELIVERABLE', code: null, campaignId: null });
  });

  it('le contact est rattaché par la règle de routage des entrants', async () => {
    await pool.query(`insert into contacts (tenant_id, phone_e164, profile_name) values ($1, '+33600000502', 'Alice Test')`, [tenantId]);
    const id = await message(tenantId, '33600000502');
    await store.noter({ messageId: id, code: 131026, motif: '131026 Message undeliverable' });
    expect((await store.lister(tenantId, {}, 100)).find((e) => e.telephone === '33600000502')?.contactNom).toBe('Alice Test');
  });

  it('🔴 idempotent : le même échec rejoué n’écrit qu’une ligne', async () => {
    const id = await message(tenantId, '33600000503');
    expect(await store.noter({ messageId: id, code: 131026, motif: 'x' })).not.toBeNull();
    expect(await store.noter({ messageId: id, code: 131026, motif: 'x' })).toBeNull();
    const n = await pool.query<{ n: number }>('select count(*)::int as n from echecs_messages where message_id = $1', [id]);
    expect(n.rows[0]!.n).toBe(1);
  });

  it('🔴 rien n’est écrit pour un entrant, un envoi de campagne ou un identifiant inconnu', async () => {
    const libre = await message(tenantId, '33600000504');
    const entrant = await message(tenantId, '33600000504', { direction: 'in' });
    const campagne = await message(tenantId, '33600000504', { origine: 'campagne' });
    expect(await store.noter({ messageId: entrant, code: null, motif: 'x' })).toBeNull();
    expect(await store.noter({ messageId: campagne, code: null, motif: 'x' })).toBeNull();
    expect(await store.noter({ messageId: `itest-${randomUUID()}`, code: null, motif: 'x' })).toBeNull();
    // Ancre positive : le même fil, un message libre, est bien noté.
    expect(await store.noter({ messageId: libre, code: null, motif: 'x' })).not.toBeNull();
  });

  it('🔴 noterSansMessage : un rapport arrivé AVANT l’inscription du message est écrit, origine inconnue', async () => {
    const id = `itest-${randomUUID()}`;
    const echec = { messageId: id, tenantId, waId: '33600000511', canal: 'rcs' as const, code: null, motif: 'UNDELIVERABLE' };
    expect(await store.noterSansMessage(echec)).toEqual({ tenantId, waId: '33600000511', canal: 'rcs', origine: null });
    expect((await store.lister(tenantId, {}, 100)).find((e) => e.telephone === '33600000511'))
      .toMatchObject({ origine: 'message', origineMessage: null, canal: 'rcs', message: 'UNDELIVERABLE' });
    // Rejoué par smsmode : rien de plus.
    expect(await store.noterSansMessage(echec)).toBeNull();
  });

  it('🔴 noterSansMessage n’écrit RIEN quand le message est inscrit : c’est `noter` qui en décide alors', async () => {
    const campagne = await message(tenantId, '33600000512', { origine: 'campagne' });
    expect(await store.noterSansMessage({ messageId: campagne, tenantId, waId: '33600000512', canal: 'rcs', code: null, motif: 'x' })).toBeNull();
    // Ancre positive : le même appel sur un identifiant qu'aucun message ne porte écrit bien.
    expect(await store.noterSansMessage({ messageId: `itest-${randomUUID()}`, tenantId, waId: '33600000512', canal: 'rcs', code: null, motif: 'x' })).not.toBeNull();
  });

  it('🔴 l’espace connu de l’appelant est un filtre : un message d’un autre espace n’est pas noté', async () => {
    const id = await message(autreTenant, '33600000505');
    expect(await store.noter({ messageId: id, code: null, motif: 'x', tenantId })).toBeNull();
    expect(await store.noter({ messageId: id, code: null, motif: 'x', tenantId: autreTenant })).not.toBeNull();
  });

  it('🔴 scope tenant à la lecture', async () => {
    const id = await message(autreTenant, '33600000506');
    await store.noter({ messageId: id, code: null, motif: 'chez le voisin' });
    expect((await store.lister(tenantId, {}, 100)).some((e) => e.telephone === '33600000506')).toBe(false);
    expect((await store.lister(autreTenant, {}, 100)).some((e) => e.telephone === '33600000506')).toBe(true);
  });

  it('les filtres : code, texte, numéro (avec ou sans +), campagne, campagnes seulement', async () => {
    const avecCode = await message(tenantId, '33600000507');
    const sansCode = await message(tenantId, '33600000508');
    await store.noter({ messageId: avecCode, code: 131049, motif: 'plafond marketing' });
    await store.noter({ messageId: sansCode, code: null, motif: 'INVALID_PHONE_NUMBER' });
    const parCode = await store.lister(tenantId, { code: 131049 }, 100);
    expect(parCode.some((e) => e.telephone === '33600000507')).toBe(true);
    expect(parCode.some((e) => e.telephone === '33600000508')).toBe(false);
    expect((await store.lister(tenantId, { q: 'INVALID_PHONE' }, 100)).map((e) => e.telephone)).toContain('33600000508');
    expect((await store.lister(tenantId, { telephone: '+33 6 00 00 05 08' }, 100)).map((e) => e.telephone)).toEqual(['33600000508']);
    expect(await store.lister(tenantId, { campaignIds: ['00000000-0000-0000-0000-000000000000'] }, 100)).toEqual([]);
    expect(await store.lister(tenantId, { campagnesSeulement: true }, 100)).toEqual([]);
  });

  it('la purge efface les vieux et épargne les récents', async () => {
    const recent = await message(tenantId, '33600000509');
    await store.noter({ messageId: recent, code: null, motif: 'frais' });
    await pool.query(
      `insert into echecs_messages (tenant_id, message_id, wa_id, canal, motif, at)
       values ($1, $2, '33600000510', 'whatsapp', 'très vieux', now() - interval '400 days')`,
      [tenantId, `itest-${randomUUID()}`],
    );
    expect(await store.purgerAvant(90)).toBeGreaterThanOrEqual(1);
    const restants = await store.lister(tenantId, {}, 1000);
    expect(restants.some((e) => e.telephone === '33600000510')).toBe(false);
    expect(restants.some((e) => e.telephone === '33600000509')).toBe(true);
  });
});

describe.skipIf(!url)('le journal des erreurs lit les messages libres (Postgres)', () => {
  let pool: Pool;
  let tenantId = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 3 });
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-journal-libres') returning id`)).rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]).catch(() => {});
    await pool.end().catch(() => {});
  });

  it('🔴 la quatrième source apparaît dans le journal, et Analytics l’exclut', async () => {
    const conv = await pool.query<{ id: string }>(`insert into conversations (tenant_id, wa_id) values ($1, '33600000601') returning id`, [tenantId]);
    const id = `itest-${randomUUID()}`;
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, body, meta_message_id, channel, origin)
       values ($1, 'out', 'text', 'Bonjour', $2, 'whatsapp', 'humain')`,
      [conv.rows[0]!.id, id],
    );
    const journal = new PgErreursLivraisonStore(pool);
    await new PgEchecsMessagesStore(pool).noter({ messageId: id, code: 131026, motif: '131026 Message undeliverable' });
    expect((await journal.lister(tenantId)).filter((e) => e.origine === 'message').map((e) => e.telephone)).toEqual(['33600000601']);
    // Même code, mais les seules campagnes : c'est ce que le compteur d'Analytics compte.
    expect((await journal.lister(tenantId, { code: 131026, campagnesSeulement: true })).some((e) => e.origine === 'message')).toBe(false);
    expect((await journal.lister(tenantId, { code: 131026 })).some((e) => e.origine === 'message')).toBe(true);
  });
});
