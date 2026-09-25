import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgInboxStore } from '../../src/inbox/store.pg';

const url = process.env.DATABASE_URL ?? '';

/**
 * LA PRÉCISION DES CURSEURS KEYSET, contre une vraie base.
 *
 * 🔴 Le défaut, constaté en production le 2026-09-02. Postgres stocke un `timestamptz` à la MICROSECONDE
 * (`17:34:16.043689`), le pilote `pg` le rend dans un `Date` JavaScript qui n'a que la MILLISECONDE, et
 * `toISOString()` ne peut donc écrire que `.043`. L'écran renvoyait cette valeur comme point de reprise, et la
 * comparaison retombait sur le mauvais côté de la frontière. Mesuré sur la base réelle : 126 messages sur 127
 * portaient une précision sous la milliseconde, donc le défaut se produisait quasiment toujours.
 *
 * Il se manifestait dans les DEUX SENS, et le second est le plus grave :
 *  - fil d'une conversation (`>`), le dernier message REVENAIT à chaque rafraîchissement de 4 s, se ré-ajoutait
 *    au fil et faisait défiler l'écran tout seul ;
 *  - liste des conversations (`<`), une conversation active dans la même milliseconde que le point d'arrêt
 *    n'apparaissait sur AUCUNE page, sans que rien ne le signale.
 *
 * 🔴 POURQUOI EN INTÉGRATION, ET PAS AILLEURS. Le défaut ne vit ni dans le SQL ni dans le TypeScript, mais
 * dans la CONVERSION entre les deux. Un faux store rendrait ce qu'on lui fait rendre, avec la précision du
 * langage de test, et ne pourrait par construction rien prouver. Ce test-ci force donc des horodatages à la
 * microseconde, et vérifie le comportement des DEUX curseurs, l'ancien et le nouveau, sur la même donnée.
 *
 * Jamais joué en local (le `DATABASE_URL` local pointe la PRODUCTION), joué par le job `integration`.
 */
describe.skipIf(!url)('curseurs keyset : la microseconde ne doit pas se perdre (Postgres)', () => {
  let pool: Pool;
  let store: PgInboxStore;
  let tenantId = '';
  let conversationId = '';
  let dernierId = '';

  /** Un instant à la MICROSECONDE, dont les trois derniers chiffres sont non nuls : c'est là que ça casse. */
  const INSTANT = '2026-09-02T10:00:00.043689Z';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 3 });
    store = new PgInboxStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-curseur') returning id`)).rows[0]!.id;
    conversationId = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, last_message_at) values ($1, '33600009001', $2::timestamptz) returning id`,
      [tenantId, INSTANT],
    )).rows[0]!.id;
    dernierId = (await pool.query<{ id: string }>(
      `insert into conversation_messages (conversation_id, direction, type, body, created_at)
       values ($1, 'in', 'text', 'bonjour', $2::timestamptz) returning id`,
      [conversationId, INSTANT],
    )).rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]).catch(() => {});
    await pool.end().catch(() => {});
  });

  it('le fil rend un curseur à la MICROSECONDE, distinct de createdAt', async () => {
    const [m] = await store.getMessages(conversationId);
    expect(m).toBeDefined();
    // `createdAt` a traversé un Date : il est tronqué, et c'est normal, il sert à AFFICHER.
    expect(m!.createdAt).toBe('2026-09-02T10:00:00.043Z');
    // Le curseur, lui, garde tout. C'est toute la différence entre les deux champs.
    expect(m!.curseur).toBe('2026-09-02T10:00:00.043689Z');
  });

  it('🔴 le curseur du serveur ne ramène PAS le message déjà vu', async () => {
    const [m] = await store.getMessages(conversationId);
    const suite = await store.getMessages(conversationId, { at: m!.curseur!, id: m!.id });
    expect(suite).toHaveLength(0);
  });

  it('🔴 et l’ancien curseur, lui, le ramenait : la preuve que ce test mord', async () => {
    // Le sens INVERSE, sans lequel le test précédent ne prouverait rien : on rejoue exactement ce que faisait
    // l'écran avant le correctif, et on constate le message qui revient. S'il cessait de revenir, ce serait
    // que la donnée de ce test a perdu sa microseconde, donc que le test ne prouve plus rien.
    const [m] = await store.getMessages(conversationId);
    const suite = await store.getMessages(conversationId, { at: m!.createdAt, id: m!.id });
    expect(suite).toHaveLength(1);
    expect(suite[0]!.id).toBe(dernierId);
  });

  it('la liste des conversations rend elle aussi un curseur à la microseconde', async () => {
    const [c] = await store.listConversations(tenantId, { limit: 10 });
    expect(c).toBeDefined();
    expect(c!.lastMessageAt).toBe('2026-09-02T10:00:00.043Z');
    expect(c!.curseur).toBe('2026-09-02T10:00:00.043689Z');
  });

  it('🔴 une conversation dans la MÊME milliseconde que le point d’arrêt n’est pas escamotée', async () => {
    // Le cas qui faisait disparaître des conversations : deux fils actifs dans la même milliseconde, ce
    // qu'une rafale de campagne produit. Le second est PLUS ANCIEN que le premier, donc il doit sortir sur la
    // page suivante ; avec le curseur tronqué à `.043`, il était plus RÉCENT que le point d'arrêt et
    // n'apparaissait nulle part.
    const plusAncien = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, last_message_at) values ($1, '33600009002', $2::timestamptz) returning id`,
      [tenantId, '2026-09-02T10:00:00.043200Z'],
    )).rows[0]!.id;
    try {
      const page1 = await store.listConversations(tenantId, { limit: 1 });
      expect(page1[0]!.id).toBe(conversationId); // le plus récent des deux

      const page2 = await store.listConversations(tenantId, { limit: 10, before: { at: page1[0]!.curseur!, id: page1[0]!.id } });
      expect(page2.map((c) => c.id), 'la conversation de la même milliseconde doit sortir').toContain(plusAncien);

      // Le sens INVERSE : avec l'ancien curseur, elle disparaissait. Si un jour cette assertion tombe, c'est
      // que la troncature a cessé d'être un problème, et ce test peut alors être retiré en conscience.
      const ancien = await store.listConversations(tenantId, { limit: 10, before: { at: page1[0]!.lastMessageAt, id: page1[0]!.id } });
      expect(ancien.map((c) => c.id), 'l’ancien curseur escamotait bien cette conversation').not.toContain(plusAncien);
    } finally {
      await pool.query('delete from conversations where id = $1', [plusAncien]).catch(() => {});
    }
  });
});
