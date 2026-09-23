import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgStatsStore } from '../../src/stats/store.pg';

const url = process.env.DATABASE_URL ?? '';

/**
 * Ce store ne fait que du SQL : sa seule preuve honnête est de tourner contre un vrai Postgres. Ce fichier
 * n'est JAMAIS joué par `npm test` (vitest.config.ts exclut tests/integration/**) ni en local (le
 * DATABASE_URL local pointe la PRODUCTION) : il est joué par le job `integration` de la CI, sur un Postgres
 * jetable.
 *
 * Ce qu'il verrouille : le fragment PARTAGÉ `ORIGINE_EFFECTIVE_SQL` reconnaît bien `mba` sous ses deux
 * formes (colonne `origin` et dérivation `type = 'mba'`), et les deux gardes `not is_test` /
 * `tenant_id = $1` du sous-select comme de la requête extérieure.
 */
describe.skipIf(!url)('PgStatsStore.messagesTenusParMba (Postgres)', () => {
  let pool: Pool;
  let store: PgStatsStore;
  let tenantId: string;
  let tenantAncien: string;
  let autreTenantId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    store = new PgStatsStore(pool);
    const t = await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-mba-messages') returning id`);
    tenantId = t.rows[0]!.id;
    const t2 = await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-mba-messages-ancien') returning id`);
    tenantAncien = t2.rows[0]!.id;
    const t3 = await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-mba-messages-autre') returning id`);
    autreTenantId = t3.rows[0]!.id;
  });

  afterAll(async () => {
    // Le cascade des tenants emporte conversations et messages.
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    if (tenantAncien) await pool.query('delete from tenants where id = $1', [tenantAncien]);
    if (autreTenantId) await pool.query('delete from tenants where id = $1', [autreTenantId]);
    await pool.end();
  });

  it('🔴 compte les deux sens des conversations où l agent de Meta a répondu, et rien d autre', async () => {
    // (a) une conversation avec un sortant `origin = 'mba'` plus un entrant du client -> 2
    const tenue = await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, is_test) values ($1, '33650000101', false) returning id`,
      [tenantId],
    );
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, origin, body)
       values ($1, 'in', 'text', null, 'bonjour'), ($1, 'out', 'text', 'mba', 'bonjour, en quoi puis-je aider ?')`,
      [tenue.rows[0]!.id],
    );

    // (b) une conversation du même espace sans aucun message `mba` -> 0
    const sansMba = await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, is_test) values ($1, '33650000102', false) returning id`,
      [tenantId],
    );
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, origin, body)
       values ($1, 'out', 'text', 'ia', 'réponse de l agent IA')`,
      [sansMba.rows[0]!.id],
    );

    // (c) une conversation `is_test` avec un message `mba` -> 0
    const test = await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, is_test) values ($1, '33650000103', true) returning id`,
      [tenantId],
    );
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, origin, body)
       values ($1, 'out', 'text', 'mba', 'essai depuis le bac à sable')`,
      [test.rows[0]!.id],
    );

    // (d) une conversation d'un AUTRE espace avec un message `mba` -> 0
    const autre = await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, is_test) values ($1, '33650000104', false) returning id`,
      [autreTenantId],
    );
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, origin, body)
       values ($1, 'out', 'text', 'mba', 'un autre client')`,
      [autre.rows[0]!.id],
    );

    expect(await store.messagesTenusParMba(tenantId, 30)).toBe(2);
  });

  it('🔴 reconnaît aussi l ancienne façon de marquer un message de l agent de Meta', async () => {
    // Avant la colonne `origin`, un message de l'agent de Meta se reconnaissait à `type = 'mba'`. Le
    // fragment partagé couvre les deux ; ce test empêche qu'on le remplace un jour par un simple
    // `m.origin = 'mba'`, qui perdrait tout l'historique sans qu'aucune erreur ne le dise.
    const conv = await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, is_test) values ($1, '33650000201', false) returning id`,
      [tenantAncien],
    );
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, origin, body)
       values ($1, 'out', 'mba', null, 'réponse historique de l agent de Meta')`,
      [conv.rows[0]!.id],
    );

    expect(await store.messagesTenusParMba(tenantAncien, 30)).toBe(1);
  });
});
