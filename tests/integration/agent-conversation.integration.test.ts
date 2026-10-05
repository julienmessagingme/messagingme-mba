import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgInboxStore } from '../../src/inbox/store.pg';
import { MEMOIRE_JOURS } from '../../src/agent/run-turn';

const url = process.env.DATABASE_URL ?? '';

/**
 * La MÉMOIRE d'un agent : la conversation qu'il lit avant de répondre.
 *
 * 🔴 POURQUOI EN INTÉGRATION. Tout se joue dans une clause `where` et dans un ordre de tri, et cette lecture
 * part DIRECTEMENT dans le contexte d'un modèle de langage. Trois choses ne peuvent être prouvées que contre
 * un vrai Postgres : le filtre `tenant_id` (un fil du mauvais client se retrouverait recopié chez le
 * fournisseur), la borne de temps (trente jours, `MEMOIRE_JOURS`, depuis le lot 5), et le fait que la borne de NOMBRE
 * garde les messages les plus RÉCENTS tout en les rendant dans l'ordre chronologique. Un faux store rendrait ce
 * qu'on lui fait rendre.
 *
 * 🔴 CE QUE CE FICHIER MASQUAIT AVANT LE LOT 5. Il posait le premier message À l'instant d'ouverture de la session,
 * alors que le message qui déclenche un parcours est enregistré AVANT qu'elle s'ouvre : la borne d'alors (l'ouverture)
 * l'excluait, et le premier tour parlait à froid. Les messages sont désormais datés comme en production, le
 * déclencheur avant l'ouverture.
 *
 * Jamais joué en local (le DATABASE_URL local pointe la PRODUCTION), joué par le job `integration`.
 */
describe.skipIf(!url)('conversation lue par l agent (Postgres)', () => {
  let pool: Pool;
  let store: PgInboxStore;
  let tenantId: string;
  let autreTenantId: string;
  const WA = '33600000042';
  const WA_LONG = '33600000043';
  const MAINTENANT = Date.now();
  /** Il y a `minutes` minutes. */
  const il_y_a = (minutes: number): string => new Date(MAINTENANT - minutes * 60_000).toISOString();
  /** La borne que le tour pose (`src/agent/run-turn.ts`) : trente jours en arrière. */
  const BORNE = new Date(MAINTENANT - MEMOIRE_JOURS * 86_400_000).toISOString();
  /** L'instant où la session s'ouvre : APRÈS l'enregistrement du message qui a démarré le parcours. */
  const OUVERTURE = il_y_a(1);

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    store = new PgInboxStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-agent-conv') returning id`)).rows[0]!.id;
    autreTenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-agent-conv-autre') returning id`)).rows[0]!.id;

    // Le MÊME wa_id chez les DEUX clients : c'est le cas que le filtre tenant doit trancher, et il est
    // réaliste (un numéro peut écrire à deux marques servies par la même console).
    const conv = async (tenant: string, wa = WA): Promise<string> => (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, last_message_at) values ($1, $2, now()) returning id`,
      [tenant, wa],
    )).rows[0]!.id;
    const mien = await conv(tenantId);
    const autre = await conv(autreTenantId);
    const long = await conv(tenantId, WA_LONG);

    const msg = async (convId: string, direction: 'in' | 'out', body: string, at: string): Promise<void> => {
      await pool.query(
        `insert into conversation_messages (conversation_id, direction, type, body, created_at) values ($1, $2, 'text', $3, $4)`,
        [convId, direction, body, at],
      );
    };

    // Il y a trente et un jours : hors de la mémoire.
    await msg(mien, 'in', 'message d il y a trente et un jours', il_y_a(31 * 24 * 60));
    // Il y a trois jours : un échange avec un humain, dans la mémoire.
    await msg(mien, 'in', 'je reviens vers vous', il_y_a(3 * 24 * 60));
    await msg(mien, 'out', 'reponse d un humain il y a trois jours', il_y_a(3 * 24 * 60 - 1));
    // Le message qui DÉCLENCHE le parcours, enregistré avant l'ouverture de la session.
    await msg(mien, 'in', 'vous avez une piscine', il_y_a(2));
    // Un message SANS corps (un accusé, un média sans légende) : il n'a rien à dire au modèle.
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, body, created_at) values ($1, 'in', 'image', null, $2)`,
      [mien, il_y_a(1)],
    );
    // Chez l'AUTRE client, sur le même numéro.
    await msg(autre, 'in', 'SECRET DE L AUTRE CLIENT', il_y_a(2));
    // Quarante messages récents sur un autre contact : la borne de NOMBRE.
    for (let i = 0; i < 40; i++) await msg(long, i % 2 === 0 ? 'in' : 'out', `m${String(i).padStart(2, '0')}`, il_y_a(40 - i));
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    if (autreTenantId) await pool.query('delete from tenants where id = $1', [autreTenantId]);
    await pool.end();
  });

  it('🔴 le message DÉCLENCHEUR, posé avant l’ouverture de la session, est lu par le premier tour', async () => {
    const m = await store.messagesDepuis(tenantId, WA, BORNE, 30);
    expect(m.map((x) => x.body)).toEqual(['je reviens vers vous', 'reponse d un humain il y a trois jours', 'vous avez une piscine']);
    expect(m.map((x) => x.direction)).toEqual(['in', 'out', 'in']);
    // Chaque entrée porte son instant : le cerveau y lit ce qui précède la session (l'annonce d'IA n'en compte rien).
    expect(m.every((x) => typeof x.at === 'string' && !Number.isNaN(Date.parse(x.at)))).toBe(true);
    // La borne d'avant le lot 5 (l'ouverture de la session) l'excluait : c'est le défaut réparé.
    expect((await store.messagesDepuis(tenantId, WA, OUVERTURE, 30)).map((x) => x.body)).not.toContain('vous avez une piscine');
  });

  it('🔴 un message de plus de trente jours n’arrive JAMAIS au modèle', async () => {
    const m = await store.messagesDepuis(tenantId, WA, BORNE, 30);
    expect(m.map((x) => x.body).join(' ')).not.toContain('trente et un jours');
  });

  it('🔴 le fil d un AUTRE client sur le MÊME numéro n arrive jamais non plus', async () => {
    // Le pooler est superuser, la RLS est bypassée : ce `where tenant_id` est le SEUL contrôle, et cette
    // lecture part chez un fournisseur de modèle.
    const m = await store.messagesDepuis(tenantId, WA, BORNE, 30);
    expect(m.map((x) => x.body).join(' ')).not.toContain('SECRET DE L AUTRE CLIENT');
    // Et symétriquement.
    const chezLAutre = await store.messagesDepuis(autreTenantId, WA, BORNE, 30);
    expect(chezLAutre.map((x) => x.body)).toEqual(['SECRET DE L AUTRE CLIENT']);
  });

  it('🔴 quarante messages récents : les TRENTE derniers, dans l’ordre chronologique', async () => {
    // Garder les plus anciens ferait répondre l'agent à une question déjà traitée ; les rendre à l'envers
    // lui ferait lire la conversation dans le désordre, ce qui est pire que de ne pas la lire.
    const m = await store.messagesDepuis(tenantId, WA_LONG, BORNE, 30);
    expect(m.map((x) => x.body)).toEqual(Array.from({ length: 30 }, (_, i) => `m${String(i + 10).padStart(2, '0')}`));
  });

  it('un numéro sans conversation rend une liste vide, sans lever', async () => {
    expect(await store.messagesDepuis(tenantId, '33699999999', BORNE, 30)).toEqual([]);
  });
});
