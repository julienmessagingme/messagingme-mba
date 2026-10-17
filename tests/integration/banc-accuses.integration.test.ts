import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgRecipientStore } from '../../src/campaign/store.pg';
import { PREFIXE, semerAccuses, wamidDe } from '../../scripts/banc-accuses';

// Ne PAS lancer ce fichier en local : le DATABASE_URL du .env local pointe sur la base de PRODUCTION
// (cf. CLAUDE.md du repo), et ce fichier cree/supprime des tenants. La CI monte un Postgres jetable pour ca.
const url = process.env.DATABASE_URL ?? '';

/**
 * 🔴 LE SEMIS DU BANC DES ACCUSÉS POSE CE QUE LA VRAIE MISE À JOUR TROUVE (point P1 de l'audit du 2026-10-17).
 *
 * Le banc du 14 octobre visait des messages inexistants : chaque accusé ne touchait aucune ligne. Ici, un accusé d'un
 * message semé doit toucher son destinataire de campagne, son envoi au journal et le statut du message, par la vraie
 * instruction (`PgRecipientStore.updateDeliveryByMessageId`), et un identifiant inventé ne doit rien toucher : les
 * deux cas ensemble disent que le banc mesurera le vrai travail.
 */
describe.skipIf(!url)('le semis du banc des accusés (Postgres)', () => {
  let pool: Pool;
  const K = 91;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 2 });
    expect(await semerAccuses(pool, K, 1, 3)).toBe(3);
  });

  afterAll(async () => {
    await pool.query('delete from tenants where name like $1', [`${PREFIXE}-%`]);
    await pool.end();
  });

  const statuts = async (wamid: string) => (await pool.query<{ r: string | null; e: string | null; m: string | null }>(
    `select (select delivery_status from campaign_recipients where message_id = $1) as r,
            (select delivery_status from campaign_envois where message_id = $1) as e,
            (select statut from conversation_messages where meta_message_id = $1 and direction = 'out') as m`,
    [wamid],
  )).rows[0]!;

  it('🔴 un accusé d’un message semé met à jour le destinataire, le journal des envois et le message', async () => {
    const touches = await new PgRecipientStore(pool).updateDeliveryByMessageId(wamidDe(K, 1), 'delivered', null, null, new Date().toISOString());
    expect(touches).toBe(1);
    expect(await statuts(wamidDe(K, 1))).toEqual({ r: 'delivered', e: 'delivered', m: 'delivered' });
  });

  it('un identifiant inventé, comme celui du banc du 14 octobre, ne touche rien', async () => {
    expect(await new PgRecipientStore(pool).updateDeliveryByMessageId(`wamid.${PREFIXE}.invente`, 'delivered', null, null, null)).toBe(0);
  });

  it('chaque message semé a son destinataire, son envoi et son message sortant', async () => {
    const r = await pool.query<{ n: string }>(
      `select count(*)::text as n from campaign_recipients cr
         join campaign_envois ce on ce.recipient_id = cr.id and ce.message_id = cr.message_id
         join conversation_messages cm on cm.meta_message_id = cr.message_id and cm.direction = 'out'
        where cr.message_id = any($1)`,
      [[0, 1, 2].map((j) => wamidDe(K, j))],
    );
    expect(Number(r.rows[0]!.n)).toBe(3);
  });
});
