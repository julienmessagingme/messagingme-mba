import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgInboxStore } from '../../src/inbox/store.pg';

const url = process.env.DATABASE_URL ?? '';

/**
 * LE MARQUEUR DE REMISE DU FIL À L'AGENT DE META, CONTRE UNE VRAIE BASE (migration 0149).
 *
 * 🔴 POURQUOI EN INTÉGRATION ET PAS EN UNITAIRE : les deux propriétés qui comptent vivent ENTIÈREMENT dans
 * du SQL. « Le DERNIER envoi, pas un envoi » est un `order by created_at desc limit 1` ; « une seule remise
 * pour plusieurs statuts du même message » est un `update ... where ... returning` qui ne rend une ligne
 * qu'au premier appelant. Un faux magasin dirait toujours ce qu'on lui fait dire.
 *
 * 🔴 ET LA PREMIÈRE PROPRIÉTÉ EST LE CŒUR DU CORRECTIF. Un parcours envoie plusieurs messages, et Meta
 * acquitte avec deux minutes de retard : l'accusé du PREMIER message arrive souvent APRÈS que le dernier
 * soit parti. Attendre n'importe quel accusé reproduirait exactement la course qu'on répare.
 */
describe.skipIf(!url)('PgInboxStore : le marqueur de remise à l’agent de Meta (Supabase)', () => {
  let pool: Pool;
  let tenantId: string;
  let store: PgInboxStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    tenantId = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-release-mba') returning id`,
    )).rows[0]!.id;
    store = new PgInboxStore(pool);
  });
  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  /** Une conversation, et les messages sortants demandés, dans l'ordre de leur envoi. */
  async function conversation(waId: string, envois: Array<string | null>): Promise<string> {
    const conv = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id) values ($1, $2) returning id`,
      [tenantId, waId],
    )).rows[0]!.id;
    for (let i = 0; i < envois.length; i += 1) {
      await pool.query(
        `insert into conversation_messages (conversation_id, direction, type, body, meta_message_id, created_at)
         values ($1, 'out', 'text', 'coucou', $2, now() + ($3 || ' seconds')::interval)`,
        [conv, envois[i], String(i)],
      );
    }
    return conv;
  }

  it('🔴 le marqueur vise le DERNIER envoi, pas le premier', async () => {
    const waId = '33600000101';
    await conversation(waId, ['wamid.A1', 'wamid.A2', 'wamid.A3']);
    expect(await store.demanderReleaseMba(tenantId, waId)).toBe('wamid.A3');
    // Et l'accusé d'un envoi PRÉCÉDENT ne rend rien : il arrive deux minutes après lui, donc souvent après
    // que le dernier soit parti. C'est précisément la course que ce marqueur existe pour éviter.
    expect(await store.consommerReleaseMba('wamid.A1')).toBeNull();
    expect(await store.consommerReleaseMba('wamid.A3')).toEqual({ tenantId, waId });
  });

  it('🔴 plusieurs statuts du même message ne rendent le fil QU’UNE FOIS', async () => {
    // Meta envoie `sent`, puis `delivered`, puis `read`. Aux deuxième et troisième, nous ne détenons plus le
    // fil : relâcher encore serait hors contrat.
    const waId = '33600000102';
    await conversation(waId, ['wamid.B1']);
    await store.demanderReleaseMba(tenantId, waId);
    expect(await store.consommerReleaseMba('wamid.B1')).toEqual({ tenantId, waId });
    expect(await store.consommerReleaseMba('wamid.B1')).toBeNull();
    expect(await store.consommerReleaseMba('wamid.B1')).toBeNull();
  });

  it('🔴 un parcours qui n’a RIEN envoyé rend null : l’appelant relâche tout de suite', async () => {
    // Attendre un accusé qui ne viendra jamais gèlerait le fil jusqu'au balayage.
    const waId = '33600000103';
    await conversation(waId, []);
    expect(await store.demanderReleaseMba(tenantId, waId)).toBeNull();
  });

  it('⚠️ un envoi SANS identifiant Meta est ignoré, et c’est le précédent qui est attendu', async () => {
    // `meta_message_id` est nullable : un envoi refusé ou journalisé avant réponse n'en porte pas, et il
    // n'aura donc jamais d'accusé. Le retenir bloquerait la remise pour toujours.
    const waId = '33600000104';
    await conversation(waId, ['wamid.C1', null]);
    expect(await store.demanderReleaseMba(tenantId, waId)).toBe('wamid.C1');
  });

  it('⚠️ un statut qui n’intéresse personne ne touche rien', async () => {
    // C'est le cas de l'écrasante majorité des accusés, et ce chemin est très chaud.
    expect(await store.consommerReleaseMba('wamid.INCONNU')).toBeNull();
  });

  it('⚠️ les messages ENTRANTS ne comptent pas : on attend l’accusé de NOTRE envoi', async () => {
    const waId = '33600000105';
    const conv = await conversation(waId, ['wamid.D1']);
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, body, meta_message_id, created_at)
       values ($1, 'in', 'text', 'merci', 'wamid.DENTRANT', now() + interval '10 seconds')`,
      [conv],
    );
    expect(await store.demanderReleaseMba(tenantId, waId)).toBe('wamid.D1');
  });
});
