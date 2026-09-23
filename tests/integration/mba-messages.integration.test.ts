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
 * formes (colonne `origin` et dérivation `type = 'mba'`), et le filtre d'ORIGINE du sous-select est bien
 * ACTIF : la conversation (b), qui n'a aucun message `mba`, ne doit PAS entrer dans le compte. Si ce filtre
 * disparaissait du sous-select, elle y entrerait et le total du premier cas passerait de 2 à 3 : ce test
 * tomberait. Et, depuis la revue finale du 2026-09-23, les DEUX clauses de FENÊTRE (celle qui borne les
 * messages comptés, celle qui borne « l'agent a répondu ici ») : les fixtures n'inséraient que des messages
 * à `now()`, donc les retirer laissait tout vert.
 *
 * ⚠️ Il ne prouve PAS que `not is_test` ou `tenant_id = $1` seraient nécessaires des DEUX côtés (sous-select
 * ET requête extérieure) : les deux filtrent la MÊME ligne de `conversations`, la double garde est
 * redondante par construction (cf. le commentaire de `messagesTenusParMba` dans `src/stats/store.pg.ts`),
 * et aucune fixture ne peut démontrer qu'un côté serait indépendamment requis.
 */
describe.skipIf(!url)('PgStatsStore.messagesTenusParMba (Postgres)', () => {
  let pool: Pool;
  let store: PgStatsStore;
  let tenantId: string;
  let tenantAncien: string;
  let autreTenantId: string;
  let tenantFenetre: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    store = new PgStatsStore(pool);
    const t = await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-mba-messages') returning id`);
    tenantId = t.rows[0]!.id;
    const t2 = await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-mba-messages-ancien') returning id`);
    tenantAncien = t2.rows[0]!.id;
    const t3 = await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-mba-messages-autre') returning id`);
    autreTenantId = t3.rows[0]!.id;
    // Un espace À PART pour la fenêtre : les autres cas ne nettoient rien entre eux (cascade au `afterAll`
    // seulement), et un compte absolu dépendrait alors de l'ordre d'exécution plutôt que du SQL testé.
    const t4 = await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-mba-messages-fenetre') returning id`);
    tenantFenetre = t4.rows[0]!.id;
  });

  afterAll(async () => {
    // Le cascade des tenants emporte conversations et messages.
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    if (tenantAncien) await pool.query('delete from tenants where id = $1', [tenantAncien]);
    if (autreTenantId) await pool.query('delete from tenants where id = $1', [autreTenantId]);
    if (tenantFenetre) await pool.query('delete from tenants where id = $1', [tenantFenetre]);
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

  /**
   * 🔴 LA FENÊTRE N'ÉTAIT GARDÉE PAR RIEN (revue finale du 2026-09-23). Toutes les fixtures ci-dessus
   * insèrent des messages SANS `created_at`, donc à `now()` : retirer les deux `created_at > now() -
   * make_interval(days => $2)` de cette requête laissait tous les cas VERTS, et le chiffre annoncé « sur
   * 30 jours » serait devenu « depuis toujours » sans qu'aucun test ne bouge.
   *
   * Les deux clauses sont gardées SÉPARÉMENT, parce qu'elles répondent à deux questions différentes :
   *  - (a) la fenêtre de la requête EXTÉRIEURE borne les messages COMPTÉS ;
   *  - (b) celle du SOUS-SELECT borne le « l'agent a répondu dans cette conversation » : une conversation
   *    que l'agent de Meta n'a plus touchée depuis deux mois n'est pas une conversation qu'il tient.
   */
  it('🔴 la FENÊTRE borne ce qui est compté, et ce qui compte comme « tenu »', async () => {
    // (a) conversation TENUE maintenant, avec un message hors fenêtre : seul le récent est compté.
    const recente = await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, is_test) values ($1, '33650000301', false) returning id`,
      [tenantFenetre],
    );
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, origin, body, created_at)
       values ($1, 'out', 'text', 'mba', 'réponse de l agent, cette semaine', now()),
              ($1, 'in', 'text', null, 'un message d il y a quarante jours', now() - interval '40 days')`,
      [recente.rows[0]!.id],
    );

    // (b) conversation dont le SEUL message de l'agent est hors fenêtre, plus un message récent : elle n'est
    // pas « tenue » sur la fenêtre, donc RIEN n'en est compté, pas même son message récent.
    const ancienne = await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, is_test) values ($1, '33650000302', false) returning id`,
      [tenantFenetre],
    );
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, origin, body, created_at)
       values ($1, 'out', 'text', 'mba', 'réponse de l agent, il y a quarante jours', now() - interval '40 days'),
              ($1, 'in', 'text', null, 'le client revient cette semaine', now())`,
      [ancienne.rows[0]!.id],
    );

    // 1, et pas 2 (la clause extérieure sauterait), pas 2 non plus par (b) (la clause du sous-select
    // sauterait), pas 4 si les deux sautaient.
    expect(await store.messagesTenusParMba(tenantFenetre, 30)).toBe(1);
  });
});
