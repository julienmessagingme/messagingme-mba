import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgInboxStore } from '../../src/inbox/store.pg';

/**
 * Le statut « Traité » d'une conversation (colonne `traitee_le`, migration 0160, demande de Julien du
 * 2026-09-19 : « et si qqun revient pour parler, évidemment on enlève le statut et on repasse en à traiter »).
 *
 * 🔴 CE QUE CES TESTS PROTÈGENT, ET QU'AUCUN TEST UNITAIRE NE PEUT VOIR. Trois écritures SQL décident de tout :
 * le fragment `A_TRAITER_SQL` qui exclut une conversation traitée, le `case when` de l'upsert partagé qui
 * efface le statut au message du CONTACT et seulement à lui, et le compteur du menu. Une chaîne de requête
 * relue ne prouve rien de son exécution : seule la vraie base le fait.
 *
 * ⚠️ Ne PAS le lancer en local : le `DATABASE_URL` du `.env` local pointe sur la base de PRODUCTION, et ce
 * fichier crée et supprime des tenants. La CI monte un Postgres jetable pour ça (job `integration`).
 */
const url = process.env.DATABASE_URL ?? '';

const WA_ID = '33600000160';
const entrant = (messageId: string, body: string) => ({
  phoneNumberId: 'pn-itest', waId: WA_ID, messageId, type: 'text', body, buttonPayload: null, profileName: null,
  field: 'messages',
});

describe.skipIf(!url)('le statut « Traité » d une conversation', () => {
  let pool: Pool;
  let store: PgInboxStore;
  let tenantId = '';
  let autreTenantId = '';
  let convId = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    store = new PgInboxStore(pool);
    tenantId = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-inbox-traite') returning id`,
    )).rows[0]!.id;
    autreTenantId = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-inbox-traite-autre') returning id`,
    )).rows[0]!.id;
  });

  afterAll(async () => {
    for (const t of [tenantId, autreTenantId]) if (t) await pool.query('delete from tenants where id = $1', [t]);
    await pool.end();
  });

  // Une conversation NEUVE à chaque cas, et tenue par un HUMAIN : c'est la seule situation où elle est « À
  // traiter » (le fragment exclut ce que le scénario tient), donc la seule où le statut a un effet visible.
  beforeEach(async () => {
    await pool.query('delete from conversations where tenant_id = $1', [tenantId]);
    await store.recordInbound(tenantId, entrant('wamid.itest-traite-init', 'merci, bonne journée'));
    convId = (await pool.query<{ id: string }>(
      'select id from conversations where tenant_id = $1 and wa_id = $2', [tenantId, WA_ID],
    )).rows[0]!.id;
    await pool.query(`update conversations set control_owner = 'app_human' where id = $1`, [convId]);
  });

  const ids = async (opts?: { aTraiter?: boolean; traitees?: boolean; archivees?: boolean }): Promise<string[]> =>
    (await store.listConversations(tenantId, opts)).map((c) => c.id);

  it('la situation de départ : le contact a écrit en dernier, la conversation est À traiter', async () => {
    // Sans ce cas, tous les suivants pourraient passer sur une conversation qui n'a jamais été dans le
    // dossier, et « elle en sort » ne prouverait rien.
    expect(await ids({ aTraiter: true })).toEqual([convId]);
    expect((await store.compterConversations(tenantId)).aTraiter).toBe(1);
  });

  it('🔴 marquer « Traité » sort d’« À traiter », laisse dans « Tout », et remplit « Traité »', async () => {
    expect(await store.marquerTraitee(tenantId, convId, true)).toBe(true);
    expect(await ids({ aTraiter: true })).toEqual([]);
    // L'arbitrage qui distingue « Traité » d'« Archivé » : la conversation reste dans « Tout ».
    expect(await ids()).toEqual([convId]);
    expect(await ids({ traitees: true })).toEqual([convId]);
    const c = await store.compterConversations(tenantId);
    expect({ tout: c.tout, aTraiter: c.aTraiter, traitees: c.traitees }).toEqual({ tout: 1, aTraiter: 0, traitees: 1 });
    // Et la ligne le dit, pour la pastille.
    expect((await store.listConversations(tenantId))[0]!.traitee).toBe(true);
  });

  it('🔴 un MESSAGE DU CONTACT retire le statut et la remet dans « À traiter »', async () => {
    // La demande de Julien, mot pour mot. C'est l'écriture qui enregistre le message qui le fait, dans le
    // même `update` : deux écritures laisseraient un message neuf dormir dans un dossier « traité ».
    await store.marquerTraitee(tenantId, convId, true);
    await store.recordInbound(tenantId, entrant('wamid.itest-traite-retour', 'en fait, une question'));
    expect(await ids({ aTraiter: true })).toEqual([convId]);
    expect(await ids({ traitees: true })).toEqual([]);
    expect((await store.listConversations(tenantId))[0]!.traitee).toBe(false);
  });

  it('🔴 PREUVE INVERSE : un envoi SORTANT automatisé ne retire PAS le statut', async () => {
    // Même upsert que l'entrant. Sans la décision du CHEMIN appelant, une campagne effacerait le statut de
    // toutes les conversations qu'elle touche, et le dossier « Traité » se viderait au premier envoi.
    await store.marquerTraitee(tenantId, convId, true);
    await store.recordOutboundByWaId(tenantId, WA_ID, {
      body: 'notre promo du mois', messageId: 'wamid.itest-traite-promo', origine: 'campagne',
    });
    expect(await ids({ traitees: true })).toEqual([convId]);
  });

  it('🔴 une RÉACTION du contact (👍) ne retire PAS le statut', async () => {
    // L'arbitrage de Julien du 2026-09-19 : « merci 👍 » en réponse à notre « bonne journée » est précisément
    // le cas que « Traité » règle. La conversation reste traitée, donc hors d'« À traiter ».
    await store.marquerTraitee(tenantId, convId, true);
    await store.recordInbound(tenantId, {
      phoneNumberId: 'pn-itest', waId: WA_ID, messageId: 'wamid.itest-traite-pouce', type: 'reaction', body: '👍',
      buttonPayload: 'wamid.notre-message', profileName: null, field: 'messages',
    });
    expect(await ids({ traitees: true })).toEqual([convId]);
    expect(await ids({ aTraiter: true })).toEqual([]);
  });

  it('une réaction sort quand même d’Archivé : l’arbitrage ne porte que sur « Traité »', async () => {
    await store.archiverConversation(tenantId, convId, true);
    await store.recordInbound(tenantId, {
      phoneNumberId: 'pn-itest', waId: WA_ID, messageId: 'wamid.itest-traite-pouce-archive', type: 'reaction', body: '👍',
      buttonPayload: 'wamid.notre-message', profileName: null, field: 'messages',
    });
    expect(await ids({ archivees: true })).toEqual([]);
  });

  it('ne plus marquer traité la rend au dossier que son dernier message désigne', async () => {
    await store.marquerTraitee(tenantId, convId, true);
    expect(await store.marquerTraitee(tenantId, convId, false)).toBe(true);
    // Le contact a écrit en dernier : elle revient dans « À traiter ».
    expect(await ids({ aTraiter: true })).toEqual([convId]);
    expect(await ids({ traitees: true })).toEqual([]);
  });

  it('une conversation archivée ET traitée n’est comptée que dans Archivé', async () => {
    // « Traité » exclut les archivées, comme tous les dossiers ordinaires : sinon une même conversation
    // serait comptée à deux endroits, et le menu additionnerait des choses qui ne s'additionnent pas.
    await store.marquerTraitee(tenantId, convId, true);
    await store.archiverConversation(tenantId, convId, true);
    expect(await ids({ traitees: true })).toEqual([]);
    const c = await store.compterConversations(tenantId);
    expect({ traitees: c.traitees, archivees: c.archivees }).toEqual({ traitees: 0, archivees: 1 });
    // Et le message du contact efface les DEUX rangements d'un coup.
    await store.recordInbound(tenantId, entrant('wamid.itest-traite-archive', 'coucou'));
    expect(await ids({ aTraiter: true })).toEqual([convId]);
  });

  it('🔴 une conversation d’un AUTRE espace ne se marque pas', async () => {
    // Le pooler est superuser, la RLS est contournée : le `tenant_id` du `where` est LE contrôle.
    expect(await store.marquerTraitee(autreTenantId, convId, true)).toBe(false);
    expect(await ids({ traitees: true })).toEqual([]);
  });

  it('une conversation inconnue rend false, pour que la route en fasse un 404', async () => {
    expect(await store.marquerTraitee(tenantId, '00000000-0000-4000-8000-000000000000', true)).toBe(false);
  });
});
