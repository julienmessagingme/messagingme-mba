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
 * Ce qu'il verrouille (Julien, 2026-09-25) : le chiffre compte les messages ÉCRITS par l'agent de Meta, et
 * RIEN d'autre du fil (ni la réponse du client, ni l'équipe, ni la campagne, ni notre agent IA), sur les deux
 * formes que le fragment PARTAGÉ `ORIGINE_EFFECTIVE_SQL` reconnaît (colonne `origin` et historique
 * `type = 'mba'`), hors fils de test et hors autre espace, et SANS BORNE DE DATE : c'est un total.
 *
 * Chaque espace a SES fixtures : les cas ne nettoient rien entre eux (cascade au `afterAll` seulement), et un
 * compte absolu dépendrait sinon de l'ordre d'exécution plutôt que du SQL testé.
 */
describe.skipIf(!url)('PgStatsStore.messagesEcritsParMba (Postgres)', () => {
  let pool: Pool;
  let store: PgStatsStore;
  let tenantId: string;
  let tenantAncien: string;
  let autreTenantId: string;
  let tenantTotal: string;

  const espace = async (nom: string): Promise<string> =>
    (await pool.query<{ id: string }>(`insert into tenants (name) values ($1) returning id`, [nom])).rows[0]!.id;
  const fil = async (tenant: string, waId: string, isTest = false): Promise<string> =>
    (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, is_test) values ($1, $2, $3) returning id`,
      [tenant, waId, isTest],
    )).rows[0]!.id;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    store = new PgStatsStore(pool);
    tenantId = await espace('itest-mba-messages');
    tenantAncien = await espace('itest-mba-messages-ancien');
    autreTenantId = await espace('itest-mba-messages-autre');
    tenantTotal = await espace('itest-mba-messages-total');
  });

  afterAll(async () => {
    // Le cascade des tenants emporte conversations et messages.
    for (const id of [tenantId, tenantAncien, autreTenantId, tenantTotal]) {
      if (id) await pool.query('delete from tenants where id = $1', [id]);
    }
    await pool.end();
  });

  it('🔴 compte les seuls messages ÉCRITS par l agent de Meta, pas le reste du fil qu il a tenu', async () => {
    // (a) un fil tenu par l'agent : deux réponses de l'agent, et autour d'elles tout ce que l'ANCIEN chiffre
    // comptait aussi (le client, l'équipe après reprise, une campagne) -> 2, et pas 5.
    const tenu = await fil(tenantId, '33650000101');
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, origin, body)
       values ($1, 'in', 'text', null, 'bonjour'),
              ($1, 'out', 'text', 'mba', 'bonjour, en quoi puis-je aider ?'),
              ($1, 'out', 'text', 'mba', 'voici nos horaires'),
              ($1, 'out', 'text', 'humain', 'je prends le relais'),
              ($1, 'out', 'template', 'campagne', 'offre du mois')`,
      [tenu],
    );

    // (b) un fil du même espace sans aucun message `mba` (notre agent IA) -> 0
    const sansMba = await fil(tenantId, '33650000102');
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, origin, body)
       values ($1, 'out', 'text', 'ia', 'réponse de l agent IA')`,
      [sansMba],
    );

    // (c) un fil `is_test` avec un message `mba` -> 0
    const test = await fil(tenantId, '33650000103', true);
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, origin, body)
       values ($1, 'out', 'text', 'mba', 'essai depuis le bac à sable')`,
      [test],
    );

    // (d) un fil d'un AUTRE espace avec un message `mba` -> 0
    const autre = await fil(autreTenantId, '33650000104');
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, origin, body)
       values ($1, 'out', 'text', 'mba', 'un autre client')`,
      [autre],
    );

    expect(await store.messagesEcritsParMba(tenantId)).toBe(2);
  });

  it('🔴 reconnaît aussi l ancienne façon de marquer un message de l agent de Meta', async () => {
    // Avant la colonne `origin`, un message de l'agent de Meta se reconnaissait à `type = 'mba'`. Le
    // fragment partagé couvre les deux ; ce test empêche qu'on le remplace un jour par un simple
    // `m.origin = 'mba'`, qui perdrait tout l'historique sans qu'aucune erreur ne le dise.
    const conv = await fil(tenantAncien, '33650000201');
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, origin, body)
       values ($1, 'out', 'mba', null, 'réponse historique de l agent de Meta')`,
      [conv],
    );

    expect(await store.messagesEcritsParMba(tenantAncien)).toBe(1);
  });

  it('🔴 AUCUNE borne de date : un message de l agent vieux de plus d un an compte', async () => {
    // L'ancien chiffre était borné à 30 jours ; celui-ci est un total. Sans ce cas, une fenêtre réintroduite
    // laisserait tous les autres verts, leurs fixtures étant insérées à `now()`.
    const conv = await fil(tenantTotal, '33650000301');
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, origin, body, created_at)
       values ($1, 'out', 'text', 'mba', 'réponse de l agent, cette semaine', now()),
              ($1, 'out', 'text', 'mba', 'réponse de l agent, il y a quatre cents jours', now() - interval '400 days')`,
      [conv],
    );

    expect(await store.messagesEcritsParMba(tenantTotal)).toBe(2);
  });
});
