import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgInboxStore } from '../../src/inbox/store.pg';

const url = process.env.DATABASE_URL ?? '';

/**
 * La MÉMOIRE d'un agent : la conversation qu'il lit avant de répondre.
 *
 * 🔴 POURQUOI EN INTÉGRATION. Tout se joue dans une clause `where` et dans un ordre de tri, et cette lecture
 * part DIRECTEMENT dans le contexte d'un modèle de langage. Trois choses ne peuvent être prouvées que contre
 * un vrai Postgres : le filtre `tenant_id` (un fil du mauvais client se retrouverait recopié chez le
 * fournisseur), la borne de temps (l'agent ne doit voir que ce qui s'est dit depuis qu'il a la main), et le
 * fait que la borne de NOMBRE garde les messages les plus RÉCENTS tout en les rendant dans l'ordre
 * chronologique. Un faux store rendrait ce qu'on lui fait rendre.
 *
 * Jamais joué en local (le DATABASE_URL local pointe la PRODUCTION), joué par le job `integration`.
 */
describe.skipIf(!url)('conversation lue par l agent (Postgres)', () => {
  let pool: Pool;
  let store: PgInboxStore;
  let tenantId: string;
  let autreTenantId: string;
  const WA = '33600000042';
  /** L'instant où l'agent prend la main. Ce qui précède ne doit JAMAIS lui parvenir. */
  const OUVERTURE = new Date(Date.UTC(2026, 7, 28, 12, 0, 0)).toISOString();

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    store = new PgInboxStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-agent-conv') returning id`)).rows[0]!.id;
    autreTenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-agent-conv-autre') returning id`)).rows[0]!.id;

    // Le MÊME wa_id chez les DEUX clients : c'est le cas que le filtre tenant doit trancher, et il est
    // réaliste (un numéro peut écrire à deux marques servies par la même console).
    const conv = async (tenant: string): Promise<string> => (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, last_message_at) values ($1, $2, now()) returning id`,
      [tenant, WA],
    )).rows[0]!.id;
    const mien = await conv(tenantId);
    const autre = await conv(autreTenantId);

    const msg = async (convId: string, direction: 'in' | 'out', body: string, at: string): Promise<void> => {
      await pool.query(
        `insert into conversation_messages (conversation_id, direction, type, body, created_at) values ($1, $2, 'text', $3, $4)`,
        [convId, direction, body, at],
      );
    };
    const t = (minutes: number) => new Date(Date.UTC(2026, 7, 28, 12, minutes, 0)).toISOString();

    // AVANT l'ouverture de la session : un échange avec un humain, que l'agent ne doit pas voir.
    await msg(mien, 'in', 'je vous ecris depuis des mois', new Date(Date.UTC(2026, 7, 28, 11, 0, 0)).toISOString());
    await msg(mien, 'out', 'reponse d un humain, il y a longtemps', new Date(Date.UTC(2026, 7, 28, 11, 1, 0)).toISOString());
    // DEPUIS l'ouverture : la conversation de l'agent.
    await msg(mien, 'in', 'bonjour, vous avez une piscine', t(0));
    await msg(mien, 'out', 'oui, ouverte de 9 h a 20 h', t(1));
    await msg(mien, 'in', 'et le parking', t(2));
    // Un message SANS corps (un accusé, un média sans légende) : il n'a rien à dire au modèle.
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, body, created_at) values ($1, 'in', 'image', null, $2)`,
      [mien, t(3)],
    );
    // Chez l'AUTRE client, sur le même numéro.
    await msg(autre, 'in', 'SECRET DE L AUTRE CLIENT', t(1));
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    if (autreTenantId) await pool.query('delete from tenants where id = $1', [autreTenantId]);
    await pool.end();
  });

  it('rend la conversation DEPUIS l ouverture, dans l ordre, sans les messages vides', async () => {
    const m = await store.messagesDepuis(tenantId, WA, OUVERTURE, 30);
    expect(m.map((x) => x.body)).toEqual([
      'bonjour, vous avez une piscine',
      'oui, ouverte de 9 h a 20 h',
      'et le parking',
    ]);
    expect(m.map((x) => x.direction)).toEqual(['in', 'out', 'in']);
  });

  it('🔴 ce qui précède l ouverture de la session n arrive JAMAIS au modèle', async () => {
    const m = await store.messagesDepuis(tenantId, WA, OUVERTURE, 30);
    expect(m.map((x) => x.body).join(' ')).not.toContain('depuis des mois');
    expect(m.map((x) => x.body).join(' ')).not.toContain('il y a longtemps');
  });

  it('🔴 le fil d un AUTRE client sur le MÊME numéro n arrive jamais non plus', async () => {
    // Le pooler est superuser, la RLS est bypassée : ce `where tenant_id` est le SEUL contrôle, et cette
    // lecture part chez un fournisseur de modèle.
    const m = await store.messagesDepuis(tenantId, WA, OUVERTURE, 30);
    expect(m.map((x) => x.body).join(' ')).not.toContain('SECRET DE L AUTRE CLIENT');
    // Et symétriquement.
    const chezLAutre = await store.messagesDepuis(autreTenantId, WA, OUVERTURE, 30);
    expect(chezLAutre.map((x) => x.body)).toEqual(['SECRET DE L AUTRE CLIENT']);
  });

  it('🔴 la borne de NOMBRE garde les plus RÉCENTS, et les rend dans l ordre chronologique', async () => {
    // Garder les plus anciens ferait répondre l'agent à une question déjà traitée ; les rendre à l'envers
    // lui ferait lire la conversation dans le désordre, ce qui est pire que de ne pas la lire.
    const m = await store.messagesDepuis(tenantId, WA, OUVERTURE, 2);
    expect(m.map((x) => x.body)).toEqual(['oui, ouverte de 9 h a 20 h', 'et le parking']);
  });

  it('un numéro sans conversation rend une liste vide, sans lever', async () => {
    expect(await store.messagesDepuis(tenantId, '33699999999', OUVERTURE, 30)).toEqual([]);
  });
});
