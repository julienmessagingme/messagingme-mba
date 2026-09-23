import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgInboxStore } from '../../src/inbox/store.pg';

// Ne PAS lancer ce fichier en local : le DATABASE_URL du .env local pointe sur la base de PRODUCTION
// (cf. CLAUDE.md du repo), et ce fichier cree/supprime des tenants. La CI monte un Postgres jetable pour ca.
const url = process.env.DATABASE_URL ?? '';

/**
 * OUVRIR LA CONVERSATION D'UN CONTACT (lot 6 de la liste de Julien du 2026-09-23).
 *
 * 🔴 POURQUOI EN INTEGRATION. Tout ce qui peut casser ici est en base : la cle unique `(tenant_id, wa_id)`
 * qui rend le geste idempotent, la derivation du `wa_id` depuis le contact, et surtout le fait qu'un fil
 * SANS message n'entre pas dans « A traiter ». Ce dernier point est une modification de `A_TRAITER_SQL`,
 * c'est-a-dire du fragment le plus lu du produit : un faux pool prouverait sa forme, pas son effet.
 *
 * ⚠️ MESURE FAITE AVANT D'Y TOUCHER, en production le 2026-09-23 : les 15 conversations portent toutes un
 * sens de dernier message, donc ZERO fil ne sort du dossier par ce changement. Un `last_direction` nul ne
 * veut plus dire « on ne sait pas » (la reprise de 0130 les a tous renseignes) mais « aucun message ».
 */
describe.skipIf(!url)('Ouvrir la conversation d un contact (Postgres reel)', () => {
  let pool: Pool;
  let store: PgInboxStore;
  let tenantId: string;
  let avecNumero: string;
  let sansIdentite: string;
  let supprime: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 2 });
    store = new PgInboxStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-ouvrir-conv') returning id`)).rows[0]!.id;
    const ins = async (sql: string, params: unknown[]) => (await pool.query<{ id: string }>(sql, params)).rows[0]!.id;
    avecNumero = await ins(`insert into contacts (tenant_id, phone_e164) values ($1, '+33600000601') returning id`, [tenantId]);
    // ⚠️ `contacts_identity_present` (0001) exige un telephone OU un bsuid : « sans identite » veut donc dire
    // un contact qui n'a QUE son bsuid vide de sens pour WhatsApp... impossible en base. On prend donc le cas
    // reellement atteignable : un contact SUPPRIME, que ce geste doit refuser.
    sansIdentite = await ins(`insert into contacts (tenant_id, bsuid) values ($1, 'bsuid-itest-601') returning id`, [tenantId]);
    supprime = await ins(`insert into contacts (tenant_id, phone_e164, deleted_at) values ($1, '+33600000602', now()) returning id`, [tenantId]);
  });

  afterAll(async () => {
    if (tenantId) {
      await pool.query(`delete from conversations where tenant_id = $1`, [tenantId]);
      await pool.query(`delete from contacts where tenant_id = $1`, [tenantId]);
      await pool.query(`delete from tenants where id = $1`, [tenantId]);
    }
    await pool.end();
  });

  it('cree le fil d un contact qui n a jamais parle, avec le wa_id derive de son numero', async () => {
    const id = await store.ouvrirConversationDuContact(tenantId, avecNumero);
    expect(id).toBeTruthy();
    const { rows } = await pool.query<{ wa_id: string; contact_id: string | null; last_direction: string | null }>(
      `select wa_id, contact_id::text as contact_id, last_direction from conversations where id = $1::uuid`, [id],
    );
    // Les chiffres nus, sans le « + » : c'est la forme que porte le webhook entrant, donc la seule qui
    // retrouvera ce meme fil quand le contact repondra.
    expect(rows[0]).toMatchObject({ wa_id: '33600000601', contact_id: avecNumero, last_direction: null });
  });

  it('🔴 IDEMPOTENT : deux ouvertures rendent le MEME fil, et n en creent pas un second', async () => {
    const un = await store.ouvrirConversationDuContact(tenantId, avecNumero);
    const deux = await store.ouvrirConversationDuContact(tenantId, avecNumero);
    expect(deux).toBe(un);
    const { rows } = await pool.query<{ n: string }>(
      `select count(*) as n from conversations where tenant_id = $1 and wa_id = '33600000601'`, [tenantId],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('🔴 un fil SANS message n entre PAS dans « A traiter »', async () => {
    // Le dossier veut dire « la balle est dans notre camp ». Ouvrir un fil soi-meme ne met la balle dans
    // aucun camp : personne n'a rien demande, et l'y faire entrer remplirait la file de travail de fils ou
    // il n'y a rien a faire.
    await store.ouvrirConversationDuContact(tenantId, avecNumero);
    const liste = await store.listConversations(tenantId, { aTraiter: true });
    expect(liste).toHaveLength(0);
    // ...mais il EXISTE, et le dossier « Toutes » le montre : sinon le bouton mènerait nulle part.
    const toutes = await store.listConversations(tenantId, {});
    expect(toutes.some((c) => c.waId === '33600000601')).toBe(true);
  });

  it('le fil se retrouve PAR SON IDENTIFIANT, hors de toute page et de tout dossier', async () => {
    const id = await store.ouvrirConversationDuContact(tenantId, avecNumero);
    const r = await store.listConversations(tenantId, { id: id! });
    expect(r).toHaveLength(1);
    expect(r[0]!.id).toBe(id);
  });

  it('🔴 y compris un fil ARCHIVE, que le filtre par defaut ecartait en silence', async () => {
    // Le test du dessus s'intitulait « de tout dossier » et n'archivait jamais rien : le filtre d'archivage
    // etait pousse INCONDITIONNELLEMENT, donc `?id=` d'un fil archive rendait zero ligne et le bouton
    // « Ouvrir la conversation » menait a une Inbox vide. Trois textes promettaient deja l'inverse, ce qui
    // est la pire forme du defaut : on croit la doc, on ne relit pas le SQL. Releve en relecture le
    // 2026-09-23.
    const id = await store.ouvrirConversationDuContact(tenantId, avecNumero);
    await pool.query(`update conversations set archived_at = now() where id = $1::uuid`, [id]);
    try {
      const r = await store.listConversations(tenantId, { id: id! });
      expect(r, 'le fil archive se retrouve par son identifiant').toHaveLength(1);
      // ...et il reste ABSENT des dossiers ordinaires, qui excluent les archivees. Les deux a la fois :
      // c'est ce qui distingue « demander CE fil » de « elargir un dossier ».
      const ordinaires = await store.listConversations(tenantId, {});
      expect(ordinaires.some((c) => c.id === id)).toBe(false);
    } finally {
      await pool.query(`update conversations set archived_at = null where id = $1::uuid`, [id]);
    }
  });

  it('🔴 un identifiant VIDE se comporte comme aucun identifiant, archivage compris', async () => {
    // Le filtre par identifiant s'armait sur « une chaine non vide », celui de l'archivage sur « pas
    // undefined » : `{ id: '' }` ne demandait donc AUCUN fil precis tout en DESARMANT l'exclusion des
    // archivees. Le symptome n'est pas une erreur, c'est une page ordinaire ou les fils ranges reapparaissent.
    // Les deux conditions lisent desormais la meme variable. Aucune route ne produit ce cas (`estUuid` ecarte
    // la chaine vide) : ce test tient la PROPRIETE, pour le quatrieme appelant qui n'existe pas encore.
    const id = await store.ouvrirConversationDuContact(tenantId, avecNumero);
    await pool.query(`update conversations set archived_at = now() where id = $1::uuid`, [id]);
    try {
      const vide = await store.listConversations(tenantId, { id: '' });
      expect(vide.some((c) => c.id === id), 'un id vide ne doit pas faire remonter les archivees').toBe(false);
      // ...et il rend bien la MEME chose qu'un appel sans option du tout.
      const sansOption = await store.listConversations(tenantId, {});
      expect(vide.map((c) => c.id)).toEqual(sansOption.map((c) => c.id));
    } finally {
      await pool.query(`update conversations set archived_at = null where id = $1::uuid`, [id]);
    }
  });

  it('🔴 un contact BLOQUE n ouvre aucun fil, au lieu d un cul-de-sac silencieux', async () => {
    // La liste ecarte les contacts bloques de TOUS les dossiers (« il n'apparait nulle part », regle du
    // produit) : rendre un identifiant aurait envoye l'operateur sur un ecran qui ne montre rien. On refuse,
    // et la route le DIT.
    const bloque = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164, blocked_at) values ($1, '+33600000603', now()) returning id`,
      [tenantId],
    )).rows[0]!.id;
    expect(await store.ouvrirConversationDuContact(tenantId, bloque)).toBeNull();
  });

  it('un contact d un bsuid ouvre un fil sur ce bsuid', async () => {
    const id = await store.ouvrirConversationDuContact(tenantId, sansIdentite);
    const { rows } = await pool.query<{ wa_id: string }>(`select wa_id from conversations where id = $1::uuid`, [id]);
    expect(rows[0]!.wa_id).toBe('bsuid-itest-601');
  });

  it('🔴 un contact SUPPRIME n ouvre aucun fil', async () => {
    expect(await store.ouvrirConversationDuContact(tenantId, supprime)).toBeNull();
  });

  it('🔴 un contact d un AUTRE espace n ouvre aucun fil', async () => {
    const autre = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-ouvrir-conv-autre') returning id`)).rows[0]!.id;
    try {
      expect(await store.ouvrirConversationDuContact(autre, avecNumero)).toBeNull();
    } finally {
      await pool.query(`delete from tenants where id = $1`, [autre]);
    }
  });
});
