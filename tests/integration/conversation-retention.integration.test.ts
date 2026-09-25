import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgInboxStore } from '../../src/inbox/store.pg';

const url = process.env.DATABASE_URL ?? '';

/**
 * RÉTENTION des conversations (PLAN.md 5.2, lot 2).
 *
 * 🔴 POURQUOI EN INTÉGRATION, et pas contre un faux. Ce qui doit être prouvé n'est pas dans le code : ce sont
 * les CASCADES déclarées en base (migrations 0009 et 0027). Supprimer une conversation doit emporter ses
 * messages ET son analyse qualitative, sans une ligne de code applicatif pour le faire. Un faux store
 * rendrait ce qu'on lui fait rendre, et le jour où une cascade manquerait, il resterait du texte libre
 * produit à partir de ce que la personne a raconté, orphelin et invisible.
 *
 * Jamais joué en local (le DATABASE_URL local pointe la PRODUCTION), joué par le job `integration`.
 */
describe.skipIf(!url)('rétention des conversations (Postgres)', () => {
  let pool: Pool;
  let store: PgInboxStore;
  let tenantId: string;
  let vieille = '';
  let recente = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    store = new PgInboxStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-retention-conv') returning id`)).rows[0]!.id;

    const conv = async (waId: string, ageJours: number): Promise<string> => (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, last_message_at)
       values ($1, $2, now() - make_interval(days => $3)) returning id`,
      [tenantId, waId, ageJours],
    )).rows[0]!.id;
    vieille = await conv('33600000801', 400); // au-delà d'un an
    recente = await conv('33600000802', 10);

    for (const id of [vieille, recente]) {
      await pool.query(
        `insert into conversation_messages (conversation_id, direction, body) values ($1, 'in', 'je raconte ma vie')`,
        [id],
      );
      await pool.query(
        `insert into conversation_analysis (conversation_id, tenant_id, sentiment, intent, topic, resolved, handled_by,
           exchanges_count, action_suggestion, confidence, justification, llm_provider, llm_model)
         values ($1, $2, 'neutre', 'information', 'un sujet qui identifie la personne', true, 'humain', 2, 'aucune', 0.8,
                 'une justification qui reprend ses mots', 'itest', 'itest')`,
        [id, tenantId],
      );
    }
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  it('🔴 la conversation périmée part AVEC ses messages et son analyse (cascades en base)', async () => {
    const n = await store.purgeConversationsOlderThan(365);
    expect(n).toBeGreaterThanOrEqual(1);

    expect((await pool.query('select 1 from conversations where id = $1', [vieille])).rowCount).toBe(0);
    expect((await pool.query('select 1 from conversation_messages where conversation_id = $1', [vieille])).rowCount).toBe(0);
    expect((await pool.query('select 1 from conversation_analysis where conversation_id = $1', [vieille])).rowCount).toBe(0);
  });

  it('la conversation RÉCENTE est intacte, elle et tout ce qui la suit', async () => {
    expect((await pool.query('select 1 from conversations where id = $1', [recente])).rowCount).toBe(1);
    expect((await pool.query('select 1 from conversation_messages where conversation_id = $1', [recente])).rowCount).toBe(1);
    expect((await pool.query('select 1 from conversation_analysis where conversation_id = $1', [recente])).rowCount).toBe(1);
  });

  it('🔴 une rétention à 0 DÉSACTIVE la purge, elle n’efface pas tout', async () => {
    // `make_interval(days => 0)` viserait tout ce qui est antérieur à maintenant : sans le test explicite,
    // désactiver la rétention effacerait l'intégralité des conversations de tous les clients.
    const avant = (await pool.query('select count(*)::int as n from conversations where tenant_id = $1', [tenantId])).rows[0]!.n;
    expect(await store.purgeConversationsOlderThan(0)).toBe(0);
    const apres = (await pool.query('select count(*)::int as n from conversations where tenant_id = $1', [tenantId])).rows[0]!.n;
    expect(apres).toBe(avant);
  });

  it('🔴 la RETENTION DE L ESPACE gagne sur le defaut d instance (migration 0155)', async () => {
    // Le responsable de traitement est le CLIENT : quand il a regle une duree, c est la sienne qui
    // s'applique, pas celle de l'instance. Ici l'espace demande 30 jours alors que l'instance en annonce
    // 365 : une conversation de 100 jours doit partir.
    const id = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, last_message_at)
       values ($1, $2, now() - make_interval(days => 100)) returning id`,
      [tenantId, '33600009100'],
    )).rows[0]!.id;
    await pool.query(
      `insert into tenant_settings (tenant_id, conversation_retention_days) values ($1, 30)
       on conflict (tenant_id) do update set conversation_retention_days = 30`,
      [tenantId],
    );
    await store.purgeConversationsOlderThan(365);
    expect((await pool.query('select 1 from conversations where id = $1', [id])).rowCount).toBe(0);
    // ⚠️ ON REND L'ESPACE A SON DEFAUT : ces cas partagent un espace, et laisser 30 jours poses ferait
    // purger, chez le voisin, tout ce qui a plus d'un mois. Un test qui compte sur son successeur pour
    // nettoyer derriere lui n'est plus un test isole, c'est une sequence.
    await pool.query('update tenant_settings set conversation_retention_days = null where tenant_id = $1', [tenantId]);
  });

  it('🔴 un espace a ZERO n est JAMAIS purge, meme quand l instance purge', async () => {
    // Le zero PAR ESPACE desactive cet espace seul. Sans le test sur la valeur effective, il retomberait
    // sur le defaut d'instance et serait purge contre la volonte du client.
    const id = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, last_message_at)
       values ($1, $2, now() - make_interval(days => 500)) returning id`,
      [tenantId, '33600009200'],
    )).rows[0]!.id;
    await pool.query(
      `insert into tenant_settings (tenant_id, conversation_retention_days) values ($1, 0)
       on conflict (tenant_id) do update set conversation_retention_days = 0`,
      [tenantId],
    );
    await store.purgeConversationsOlderThan(365);
    expect((await pool.query('select 1 from conversations where id = $1', [id])).rowCount).toBe(1);
    /**
     * 🔴 ON REMET L'ESPACE AU DEFAUT **ET** ON EFFACE LA CONVERSATION, et oublier le second a casse le test
     * SUIVANT (CI du 2026-09-17). Ces cas partagent un espace : en laissant derriere lui une conversation
     * de 500 jours que ce test protege volontairement de la purge, il en offrait une de plus a celui qui
     * verifie le bornage par passage. Ce dernier supprimait donc deux conversations dont UNE seule etait
     * a lui, et trouvait deux survivantes la ou il en attendait une.
     *
     * ⚠️ C'est le corollaire (b) du CLAUDE.md pris a l'envers : un test ne doit pas changer le cas que son
     * VOISIN exerce. Et seul le job d'integration pouvait le voir, puisque `npm test` en local n'a pas de
     * base : c'est exactement pour ca qu'on regarde le run apres un push.
     */
    await pool.query('update tenant_settings set conversation_retention_days = null where tenant_id = $1', [tenantId]);
    await pool.query('delete from conversations where id = $1', [id]);
  });
  it('l’effacement est BORNÉ par passage (le balayage repasse)', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push((await pool.query<{ id: string }>(
        `insert into conversations (tenant_id, wa_id, last_message_at)
         values ($1, $2, now() - make_interval(days => 400)) returning id`,
        [tenantId, `3360000090${i}`],
      )).rows[0]!.id);
    }
    expect(await store.purgeConversationsOlderThan(365, 2)).toBe(2);
    expect((await pool.query('select 1 from conversations where id = any($1::uuid[])', [ids])).rowCount).toBe(1);
    expect(await store.purgeConversationsOlderThan(365, 2)).toBe(1);
  });
});
