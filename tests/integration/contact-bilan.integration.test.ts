import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgContactHistoryStore } from '../../src/crm/contact-history.pg';
import { entonnoirEngagement } from '../../src/stats/cost';

/**
 * L'ENTONNOIR D'ENGAGEMENT D'UN CONTACT : jusqu'où il est allé, parcours par parcours.
 *
 * 🔴 CE QUE CES TESTS PROTÈGENT, ET POURQUOI AUCUN TEST UNITAIRE NE LE PEUT. Toute la règle vit dans des
 * FENÊTRES SQL : un parcours va du départ d'une campagne au départ de la suivante, et au plus 24 h ; une
 * sollicitation est un sortant AUTOMATIQUE ; une réaction est un entrant ou un clic attribué, dans la
 * fenêtre de CETTE sollicitation. Un faux dépôt monterait ses propres fenêtres, donc ne prouverait rien.
 *
 * 🔴 LES TROIS CAS ICI SONT DES DÉFAUTS RÉELLEMENT COMMIS le 2026-09-11, pas des hypothèses. Deux ont été
 * trouvés en revue APRÈS déploiement, et le second surestimait l'entonnoir d'un facteur deux sur les
 * données réelles d'un client (16/7/2 annoncés là où la vérité est 9/1/1).
 *
 * ⚠️ Ne PAS le lancer en local : le `DATABASE_URL` du `.env` local pointe sur la PRODUCTION. La CI monte un
 * Postgres jetable pour ça (job `integration`).
 */
const url = process.env.DATABASE_URL ?? '';

describe.skipIf(!url)('l’entonnoir d’engagement d’un contact', () => {
  let pool: Pool;
  let store: PgContactHistoryStore;
  let tenantId = '';
  let contactId = '';
  let conversationId = '';
  let campagneA = '';
  let campagneB = '';
  /** Un opérateur RÉEL : `conversation_messages.sender_user_id` porte une clé étrangère, un identifiant
   *  inventé ferait échouer l'insertion et le test ne dirait rien de ce qu'il prétend éprouver. */
  let operateur = '';

  /** `t0` sert d'origine à tout le scénario : les dates sont posées à la main, jamais `now()`. */
  const t0 = new Date('2026-06-01T09:00:00.000Z');
  const a = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    store = new PgContactHistoryStore(pool);

    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-bilan') returning id`)).rows[0]!.id;
    contactId = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164, opt_in_status) values ($1, '+33600000777', 'opted_in') returning id`, [tenantId],
    )).rows[0]!.id;
    operateur = (await pool.query<{ id: string }>(
      `insert into users (tenant_id, email, role, password_hash) values ($1, 'itest-bilan@example.test', 'admin', 'x') returning id`, [tenantId],
    )).rows[0]!.id;
    conversationId = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, contact_id) values ($1, '33600000777', $2) returning id`, [tenantId, contactId],
    )).rows[0]!.id;

    const campagne = async (nom: string, categorie: string) => (await pool.query<{ id: string }>(
      `insert into campaigns (tenant_id, name, category, status) values ($1, $2, $3, 'completed') returning id`,
      [tenantId, nom, categorie],
    )).rows[0]!.id;
    campagneA = await campagne('itest-A', 'marketing');
    campagneB = await campagne('itest-B', 'marketing');

    const envoi = async (campaignId: string, quand: Date) => pool.query(
      `insert into campaign_recipients (campaign_id, contact_id, to_e164, status, sent_at)
       values ($1, $2, '+33600000777', 'sent', $3)`,
      [campaignId, contactId, quand],
    );
    const message = async (sens: 'in' | 'out', quand: Date, humain = false) => pool.query(
      `insert into conversation_messages (conversation_id, direction, type, body, created_at, sender_user_id)
       values ($1, $2, 'text', 'x', $3, $4)`,
      [conversationId, sens, quand, humain ? operateur : null],
    );

    // PARCOURS A, à t0 : deux sollicitations automatiques, le contact réagit aux deux -> niveau 2.
    await envoi(campagneA, a(0));
    await message('out', a(0));
    await message('in', a(5));
    await message('out', a(10));
    await message('in', a(15));
    // ⚠️ UN SORTANT HUMAIN au milieu : il ne doit PAS compter comme une sollicitation de plus, sinon le
    // niveau grimperait au seul motif qu'un opérateur a discuté avec le contact.
    await message('out', a(20), true);
    await message('in', a(25));

    // PARCOURS B, 3 h plus tard, donc DANS les 24 h du dernier message du parcours A.
    // 🔴 C'est le piège : la réaction ci-dessous répond à la campagne B, et elle ne doit PAS créditer le
    // dernier message de A, dont la fenêtre n'était bornée que par 24 h avant le correctif.
    await envoi(campagneB, a(180));
    await message('out', a(180));
    await message('in', a(185));
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  it('🔴 un sortant HUMAIN n’est pas une sollicitation : le parcours A plafonne au niveau 2', async () => {
    const bilan = await store.bilanContact(tenantId, contactId);
    expect(bilan).not.toBeNull();
    // A atteint 2 (jamais 3, malgré le troisième entrant qui répond à un message d'opérateur), B atteint 1.
    expect([...bilan!.profondeurs].sort()).toEqual([1, 2]);
  });

  it('🔴 la réaction à la campagne SUIVANTE ne crédite pas le parcours précédent', async () => {
    // Le défaut trouvé en revue : la DERNIÈRE sollicitation d'un parcours n'était bornée que par 24 h, pas
    // par le départ du parcours suivant. Sans le correctif, A remonterait à 3.
    const bilan = await store.bilanContact(tenantId, contactId);
    expect(Math.max(...bilan!.profondeurs)).toBe(2);
  });

  it('l’entonnoir cumulé se lit « au moins N »', async () => {
    const bilan = await store.bilanContact(tenantId, contactId);
    expect(entonnoirEngagement(bilan!.profondeurs).slice(0, 3)).toEqual([
      { niveau: 1, parcours: 2 },
      { niveau: 2, parcours: 1 },
      { niveau: 3, parcours: 0 },
    ]);
  });

  it('les envois remontent par catégorie, pour le coût', async () => {
    const bilan = await store.bilanContact(tenantId, contactId);
    expect(bilan!.envois).toEqual([{ category: 'marketing', count: 2 }]);
  });

  it('🔴 un contact d’un AUTRE espace rend `null`, jamais un bilan vide', async () => {
    const autre = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-bilan-autre') returning id`)).rows[0]!.id;
    try {
      expect(await store.bilanContact(autre, contactId)).toBeNull();
    } finally {
      await pool.query('delete from tenants where id = $1', [autre]);
    }
  });
});
