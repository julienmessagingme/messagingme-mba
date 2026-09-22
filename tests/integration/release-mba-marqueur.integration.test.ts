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
 * 🔴 ET LA PREMIÈRE PROPRIÉTÉ EST LE CŒUR DU CORRECTIF. Un parcours envoie plusieurs messages, et l'accusé du
 * PREMIER message arrive souvent APRÈS que le dernier soit parti (ce texte l'attribuait à un retard de Meta de deux
 * minutes : c'était notre file d'accusés). Attendre n'importe quel accusé reproduirait la course qu'on répare.
 *
 * 🔴 ET DEPUIS LE LOT 4 DES OUTILS MAISON, LE MARQUEUR NE SE POSE PLUS SUR UN ENVOI DÉJÀ TRAITÉ PAR META : le client
 * a écrit depuis (la réponse « à côté »), l'accusé est déjà là (`accuse_le`, 0162), ou l'envoi n'est plus récent.
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

  /**
   * ⚠️ CAS RÉÉCRIT AU LOT 4 (spec 2026-09-21-outils-maison-mba, § 5.1). Il plaçait l'entrant APRÈS notre envoi et
   * attendait encore le marqueur, ce que la règle inverse délibérément (cas suivant). Ce qu'il protégeait est
   * gardé : le marqueur désigne NOTRE envoi, jamais l'identifiant d'un message entrant.
   */
  it('⚠️ un message ENTRANT n’est jamais attendu : le marqueur désigne NOTRE envoi', async () => {
    const waId = '33600000105';
    const conv = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id) values ($1, $2) returning id`, [tenantId, waId],
    )).rows[0]!.id;
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, body, meta_message_id, created_at)
       values ($1, 'in', 'text', 'bonjour', 'wamid.DENTRANT', now() - interval '10 seconds'),
              ($1, 'out', 'text', 'coucou', 'wamid.D1', now())`,
      [conv],
    );
    expect(await store.demanderReleaseMba(tenantId, waId)).toBe('wamid.D1');
  });

  it('🔴 le client a écrit APRÈS notre envoi (réponse « à côté ») : aucun marqueur, on rend tout de suite', async () => {
    // Son message prouve que notre envoi est traité. Attendre son accusé, déjà reçu depuis longtemps, gelait le
    // fil en `app_human` jusqu'au balayage.
    const waId = '33600000106';
    const conv = await conversation(waId, ['wamid.F1']);
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, body, meta_message_id, created_at)
       values ($1, 'in', 'text', 'vous êtes ouverts dimanche ?', 'wamid.FENTRANT', now() + interval '10 seconds')`,
      [conv],
    );
    expect(await store.demanderReleaseMba(tenantId, waId)).toBeNull();
  });

  it('🔴 notre dernier envoi est DÉJÀ acquitté (question expirée) : aucun marqueur', async () => {
    const waId = '33600000107';
    await conversation(waId, ['wamid.E1']);
    await pool.query(`update conversation_messages set accuse_le = now() where meta_message_id = 'wamid.E1'`);
    expect(await store.demanderReleaseMba(tenantId, waId)).toBeNull();
  });

  it('🔴 un envoi ANCIEN n’est plus en vol : aucun marqueur, même sans accusé écrit', async () => {
    // Les envois antérieurs au lot 4 ont été acquittés sans que personne n'écrive `accuse_le` : pour eux, `null`
    // ne veut pas dire « pas encore acquitté ». Meta acquitte en une seconde ; au-delà de la borne, attendre
    // l'accusé, c'est attendre ce qui est déjà passé.
    const waId = '33600000109';
    const conv = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id) values ($1, $2) returning id`, [tenantId, waId],
    )).rows[0]!.id;
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, body, meta_message_id, created_at)
       values ($1, 'out', 'text', 'question', 'wamid.H1', now() - interval '11 minutes')`,
      [conv],
    );
    expect(await store.demanderReleaseMba(tenantId, waId)).toBeNull();
  });

  it('🔴 tout statut pose l’accusé, même attendu par personne, et le premier seulement', async () => {
    const waId = '33600000108';
    await conversation(waId, ['wamid.G1']);
    expect(await store.consommerReleaseMba('wamid.G1')).toBeNull(); // personne n'attendait
    const premier = (await pool.query<{ accuse_le: Date | null }>(
      `select accuse_le from conversation_messages where meta_message_id = 'wamid.G1'`,
    )).rows[0]!.accuse_le;
    expect(premier).not.toBeNull();
    await new Promise((r) => { setTimeout(r, 20); });
    await store.consommerReleaseMba('wamid.G1');
    const second = (await pool.query<{ accuse_le: Date }>(
      `select accuse_le from conversation_messages where meta_message_id = 'wamid.G1'`,
    )).rows[0]!.accuse_le;
    expect(second.getTime()).toBe(premier!.getTime());
    // Et un release demandé ensuite n'attend plus rien : l'accusé est déjà là.
    expect(await store.demanderReleaseMba(tenantId, waId)).toBeNull();
  });

  it('🔴 le dernier message de l’agent de Meta : SON écho le plus récent, jamais le nôtre ni celui du client', async () => {
    // Lu par `attendreFinDuTour` (src/mba/fin-de-tour.ts) : un identifiant qui change dit que l'agent a parlé.
    const waId = '33600000110';
    const conv = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id) values ($1, $2) returning id`, [tenantId, waId],
    )).rows[0]!.id;
    expect(await store.dernierMessageDeLAgent(tenantId, waId)).toBeNull();
    const ecrire = async (direction: string, type: string, decalage: number) => (await pool.query<{ id: string }>(
      `insert into conversation_messages (conversation_id, direction, type, body, created_at)
       values ($1, $2, $3, 'x', now() + ($4 || ' seconds')::interval) returning id`,
      [conv, direction, type, String(decalage)],
    )).rows[0]!.id;
    const premier = await ecrire('out', 'mba', 0);
    await ecrire('out', 'text', 1); // NOTRE envoi
    await ecrire('in', 'text', 2); // le client
    expect(await store.dernierMessageDeLAgent(tenantId, waId)).toBe(premier);
    const second = await ecrire('out', 'mba', 3);
    expect(await store.dernierMessageDeLAgent(tenantId, waId)).toBe(second);
    // Isolé par espace : le même numéro dans un autre espace ne voit rien.
    expect(await store.dernierMessageDeLAgent('00000000-0000-4000-8000-000000000000', waId)).toBeNull();
  });
});
