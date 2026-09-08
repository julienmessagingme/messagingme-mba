import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgInboxStore } from '../../src/inbox/store.pg';

/**
 * Les compteurs du menu de dossiers de l'Inbox.
 *
 * 🔴 CE QUE CES TESTS PROTÈGENT. Un compteur faux est PIRE qu'un compteur absent, parce qu'on le croit. Ils
 * portent donc sur TOUTE la base et pas sur une page, ils s'accordent entre eux (la somme de « Tout » et
 * d'« Archivé » ne dépasse jamais le nombre de conversations), et ils appliquent EXACTEMENT les mêmes
 * filtres que la liste qu'ils commentent.
 *
 * ⚠️ Ce dernier point est une CORRECTION. L'ancien `countATraiter` ne retirait pas les contacts BLOQUÉS
 * alors que `listConversations` les retire : son chiffre pouvait dépasser le nombre de lignes affichées,
 * sans que rien ne l'explique. Le compteur unifié ferme cet écart, ce qui peut faire BAISSER le nombre chez
 * un client qui a des contacts bloqués.
 *
 * ⚠️ Ne PAS le lancer en local : le `DATABASE_URL` du `.env` local pointe sur la PRODUCTION. La CI monte un
 * Postgres jetable pour ça (job `integration`).
 */
const url = process.env.DATABASE_URL ?? '';

describe.skipIf(!url)('compteurs du menu de dossiers', () => {
  let pool: Pool;
  let store: PgInboxStore;
  let tenantId = '';
  let jean = '';
  let marie = '';
  let convBloquee = '';

  /** Une conversation prête à l'emploi : son contact, son détenteur, son affectation, son archivage. */
  async function conversation(waId: string, opts: {
    tenu?: boolean; signalee?: boolean; archivee?: boolean; affectee?: string; bloque?: boolean;
  } = {}): Promise<string> {
    const contact = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164, blocked_at)
       values ($1, $2, ${opts.bloque ? 'now()' : 'null'}) returning id`,
      [tenantId, `+${waId}`],
    )).rows[0]!.id;
    const conv = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, contact_id, last_message_at, control_owner, assigned_to, archived_at)
       values ($1, $2, $3, now(), $4, $5, ${opts.archivee ? 'now()' : 'null'}) returning id`,
      [tenantId, waId, contact, opts.tenu ? 'app_human' : 'app_workflow', opts.affectee ?? null],
    )).rows[0]!.id;
    if (opts.signalee) {
      await pool.query(
        // ⚠️ La table exige DOUZE colonnes non nulles : le schema d'analyse est complet par construction
        // (un LLM qui omet un champ ne doit pas produire une analyse a trous). Une fixture partielle fait
        // echouer le beforeAll entier, et vitest le rapporte comme « 6 skipped », ce qui ressemble a un
        // test desactive plutot qu a une erreur.
        `insert into conversation_analysis
           (conversation_id, tenant_id, sentiment, intent, topic, resolved, abusive,
            handled_by, exchanges_count, entities, action_suggestion, confidence, justification,
            llm_provider, llm_model)
         values ($1, $2, 'negatif', 'reclamation', 'insultes', false, true,
                 'humain', 2, '{}'::jsonb, 'escalader', 0.9, 'insultes envers le support',
                 'itest', 'itest')`,
        [conv, tenantId],
      );
    }
    return conv;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    store = new PgInboxStore(pool);
    tenantId = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-inbox-compteurs') returning id`,
    )).rows[0]!.id;
    const membre = async (email: string, nom: string): Promise<string> => (await pool.query<{ id: string }>(
      `insert into users (tenant_id, email, name, password_hash, role) values ($1, $2, $3, 'x', 'agent') returning id`,
      [tenantId, email, nom],
    )).rows[0]!.id;
    jean = await membre('jean@itest.test', 'Jean');
    marie = await membre('marie@itest.test', 'Marie');

    // Quatre NON archivées : deux tenues (dont une signalée), deux au scénario. Deux affectées à Jean.
    await conversation('33600000001', { tenu: true, affectee: jean });
    await conversation('33600000002', { tenu: true, signalee: true, affectee: jean });
    await conversation('33600000003', {});
    await conversation('33600000004', {});
    // Une archivée, tenue et affectée : elle ne doit compter QUE dans « Archivé ».
    await conversation('33600000005', { archivee: true, tenu: true, affectee: jean });
    // Une dont le contact est BLOQUÉ : elle ne doit compter nulle part.
    convBloquee = await conversation('33600000006', { tenu: true, bloque: true });
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  it('🔴 les cinq compteurs portent sur TOUTE la base, et s’accordent entre eux', async () => {
    const c = await store.compterConversations(tenantId);
    expect(c.tout).toBe(4);
    expect(c.aTraiter).toBe(2);
    expect(c.signalees).toBe(1);
    expect(c.archivees).toBe(1);
    expect(c.nonAffectees).toBe(2);
  });

  it('🔴 « Tout » EXCLUT les archivées : sinon deux dossiers compteraient la même conversation', async () => {
    const c = await store.compterConversations(tenantId);
    // Cinq conversations visibles en tout (la bloquée ne compte pas), réparties SANS recouvrement.
    expect(c.tout + c.archivees).toBe(5);
  });

  it('🔴 un contact BLOQUÉ ne compte NULLE PART, comme il n’apparaît nulle part', async () => {
    // C'est la correction : l'ancien `countATraiter` comptait cette conversation (elle est `app_human`)
    // alors que la liste ne la montre pas. Le compteur dépassait donc le nombre de lignes affichées.
    const c = await store.compterConversations(tenantId);
    const vues = (await store.listConversations(tenantId)).map((x) => x.id);
    expect(vues).not.toContain(convBloquee);
    expect(c.aTraiter).toBe(2); // et non 3
    expect(c.parMembre.every((m) => m.n <= 2)).toBe(true);
  });

  it('🔴 la charge par membre liste TOUS les membres, y compris ceux à ZÉRO', async () => {
    // C'est ce qui répond à la question du manager : un collaborateur sans conversation est une
    // information, et ne le montrer que lorsqu'il en a le rendrait invisible au moment où on le cherche.
    const c = await store.compterConversations(tenantId);
    expect(c.parMembre).toEqual([
      { userId: jean, nom: 'Jean', n: 2 },
      { userId: marie, nom: 'Marie', n: 0 },
    ]);
  });

  it('une conversation ARCHIVÉE ne compte pas dans la charge de son affectataire', async () => {
    // Jean en a trois affectées, dont une archivée : sa charge est de deux. Une charge qui compterait le
    // rangé annoncerait du travail qui n'existe plus.
    const c = await store.compterConversations(tenantId);
    expect(c.parMembre.find((m) => m.userId === jean)?.n).toBe(2);
  });

  it('🔴 un AUTRE espace ne voit rien de celui-ci', async () => {
    // Le pooler est superuser, la RLS est contournée : le `tenant_id` de chaque requête est LE contrôle.
    const autre = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-inbox-compteurs-autre') returning id`,
    )).rows[0]!.id;
    try {
      const c = await store.compterConversations(autre);
      expect(c).toEqual({ tout: 0, aTraiter: 0, signalees: 0, archivees: 0, nonAffectees: 0, parMembre: [] });
    } finally {
      await pool.query('delete from tenants where id = $1', [autre]);
    }
  });
});
