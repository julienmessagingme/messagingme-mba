import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgInboxStore } from '../../src/inbox/store.pg';

const url = process.env.DATABASE_URL ?? '';

/**
 * Pagination de l'inbox : le curseur, contre une vraie base (migration 0069).
 *
 * Pourquoi en intégration : tout se joue dans une comparaison de TUPLE SQL
 * (`(last_message_at, id) < ($1, $2)`). Un faux store rendrait ce qu'on lui fait rendre, et ne dirait rien
 * du seul cas qui compte vraiment : deux conversations dont le dernier message porte le MÊME horodatage,
 * à cheval sur la frontière entre deux pages.
 */
describe.skipIf(!url)('PgInboxStore : pagination par curseur (Supabase)', () => {
  let pool: Pool;
  let tenantId: string;
  let store: PgInboxStore;
  /** 12 conversations, dont 4 qui partagent le MÊME horodatage : c'est là que le curseur se casse. */
  const TOTAL = 12;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-pagination') returning id`)).rows[0]!.id;
    store = new PgInboxStore(pool);

    for (let i = 0; i < TOTAL; i += 1) {
      // Les 4 dernières partagent le même instant. Les autres sont espacées d'une minute.
      const minute = i < TOTAL - 4 ? i : TOTAL - 4;
      const at = new Date(Date.UTC(2026, 7, 21, 10, minute, 0)).toISOString();
      // Une conversation sur trois est « à traiter » (le scénario ne la gère plus).
      const owner = i % 3 === 0 ? 'app_human' : 'app_workflow';
      // ⚠️ `last_direction` EST ECRIT, parce que toute conversation reelle en porte un : depuis le
      // 2026-09-23, « A traiter » exige un message (un fil qu'on vient d'ouvrir a la main n'y entre pas).
      // Une fixture sans sens decrirait un etat que la production n'a pas, et viderait ce dossier.
      await pool.query(
        `insert into conversations (tenant_id, wa_id, last_message_at, control_owner, last_direction) values ($1, $2, $3, $4, 'in')`,
        [tenantId, `3360000${String(i).padStart(4, '0')}`, at, owner],
      );
    }
  });
  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  /** Parcourt toutes les pages et rend les identifiants dans l'ordre rencontré. */
  async function toutesLesPages(taille: number, aTraiter = false): Promise<string[]> {
    const vus: string[] = [];
    let curseur: { at: string; id: string } | undefined;
    // Borne de sécurité : sans elle, un curseur qui n'avance pas ferait tourner le test à l'infini.
    for (let tour = 0; tour < 50; tour += 1) {
      const page = await store.listConversations(tenantId, {
        limit: taille,
        ...(curseur ? { before: curseur } : {}),
        ...(aTraiter ? { aTraiter: true } : {}),
      });
      vus.push(...page.map((c) => c.id));
      if (page.length < taille) break;
      const dernier = page[page.length - 1]!;
      curseur = { at: dernier.lastMessageAt, id: dernier.id };
    }
    return vus;
  }

  it('🔴 pagine sans DOUBLON ni TROU, y compris sur des horodatages identiques', async () => {
    const parPages = await toutesLesPages(5);
    expect(parPages).toHaveLength(TOTAL);
    expect(new Set(parPages).size).toBe(TOTAL); // aucun doublon

    // Même contenu, et même ORDRE, qu'une lecture en une seule fois : la pagination ne doit rien réordonner.
    const enUneFois = (await store.listConversations(tenantId, { limit: 200 })).map((c) => c.id);
    expect(parPages).toEqual(enUneFois);
  });

  it('la taille de page ne change RIEN au résultat', async () => {
    // Trois découpages différents doivent rendre exactement la même suite. Si le curseur était mal posé, une
    // taille tomberait pile sur la frontière des horodatages identiques et sauterait une ligne.
    const [p1, p3, p7] = await Promise.all([toutesLesPages(1), toutesLesPages(3), toutesLesPages(7)]);
    expect(p3).toEqual(p1);
    expect(p7).toEqual(p1);
  });

  it('le filtre « À traiter » s’applique en SQL, et se pagine aussi', async () => {
    const attendus = Math.ceil(TOTAL / 3); // une conversation sur trois
    const tout = await store.listConversations(tenantId, { limit: 200, aTraiter: true });
    expect(tout).toHaveLength(attendus);
    expect(tout.every((c) => c.controlOwner !== 'app_workflow')).toBe(true);
    // Et le même résultat en paginant deux par deux.
    expect(await toutesLesPages(2, true)).toEqual(tout.map((c) => c.id));
  });

  it('🔴 le compteur « À traiter » compte TOUTE la base, pas seulement une page', async () => {
    // C'est le défaut qu'on corrige : l'écran le calculait sur les conversations chargées, donc il
    // plafonnait à la taille de la page et affichait moins que la réalité.
    const petitePage = await store.listConversations(tenantId, { limit: 2, aTraiter: true });
    expect(petitePage).toHaveLength(2);
    expect(await store.countATraiter(tenantId)).toBe(Math.ceil(TOTAL / 3));
  });

  it('🔴 isolation : un AUTRE espace ne voit aucune de ces conversations', async () => {
    const autre = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-pagination-autre') returning id`)).rows[0]!.id;
    try {
      expect(await store.listConversations(autre, { limit: 200 })).toEqual([]);
      expect(await store.countATraiter(autre)).toBe(0);
    } finally {
      await pool.query('delete from tenants where id = $1', [autre]);
    }
  });

  it('limit hors bornes est ramené dans le domaine, jamais appliqué tel quel', async () => {
    // La valeur vient d'une query string : 0 viderait la page, un million ramènerait la table entière.
    expect((await store.listConversations(tenantId, { limit: 0 })).length).toBeGreaterThan(0);
    expect((await store.listConversations(tenantId, { limit: -3 })).length).toBeGreaterThan(0);
    expect((await store.listConversations(tenantId, { limit: 10_000 })).length).toBe(TOTAL);
  });
});

/**
 * Affectation d'une conversation (migration 0070), contre une vraie base.
 *
 * Pourquoi en intégration : l'essentiel se joue dans le SQL, notamment la sous-requête qui vérifie que
 * l'affectataire appartient bien au tenant. Un faux store rendrait ce qu'on lui fait rendre, et ne dirait
 * rien du cas qui compte : un identifiant d'utilisateur d'un AUTRE client.
 */
describe.skipIf(!url)('PgInboxStore : affectation (Supabase)', () => {
  let pool: Pool;
  let tenantId = '';
  let autreTenant = '';
  let store: PgInboxStore;
  let membre = '';
  let etranger = '';
  let conv = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-affect') returning id`)).rows[0]!.id;
    autreTenant = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-affect-autre') returning id`)).rows[0]!.id;
    store = new PgInboxStore(pool);
    const user = async (t: string, email: string) => (await pool.query<{ id: string }>(
      `insert into users (tenant_id, email, role, password_hash) values ($1, $2, 'agent', 'x') returning id`, [t, email],
    )).rows[0]!.id;
    membre = await user(tenantId, `membre-${Date.now()}@itest.test`);
    etranger = await user(autreTenant, `etranger-${Date.now()}@itest.test`);
    conv = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, last_message_at) values ($1, '33699999999', now()) returning id`, [tenantId],
    )).rows[0]!.id;
  });
  afterAll(async () => {
    for (const t of [tenantId, autreTenant]) if (t) await pool.query('delete from tenants where id = $1', [t]);
    await pool.end();
  });

  it('affecte, relit, puis libère', async () => {
    expect(await store.setAssignee(tenantId, conv, membre, membre)).toBe(true);
    expect(await store.getAssignee(tenantId, conv)).toBe(membre);
    expect(await store.setAssignee(tenantId, conv, null, membre)).toBe(true);
    expect(await store.getAssignee(tenantId, conv)).toBeNull();
  });

  it('🔴 un membre d’un AUTRE espace est refusé', async () => {
    // Sans la vérification d'appartenance, la conversation deviendrait inaccessible à tout le monde :
    // plus personne du tenant ne correspondrait à l'affectataire.
    expect(await store.setAssignee(tenantId, conv, etranger, membre)).toBe(false);
    expect(await store.getAssignee(tenantId, conv)).toBeNull();
  });

  it('🔴 « conversation inconnue » et « affectée à personne » ne se confondent pas', async () => {
    // `undefined` vs `null` : les confondre laisserait écrire dans la conversation d'un autre espace,
    // puisque « personne » vaut « ouverte à tous ».
    expect(await store.getAssignee(autreTenant, conv)).toBeUndefined();
    expect(await store.getAssignee(tenantId, conv)).toBeNull();
  });

  it('la liste rend l’affectation et son NOM, et sait filtrer dessus', async () => {
    await pool.query(`update users set name = 'Bob Agent' where id = $1`, [membre]);
    await store.setAssignee(tenantId, conv, membre, membre);

    const tout = await store.listConversations(tenantId, { limit: 10 });
    expect(tout[0]).toMatchObject({ assignedTo: membre, assignedToName: 'Bob Agent' });

    expect(await store.listConversations(tenantId, { limit: 10, affectee: membre })).toHaveLength(1);
    expect(await store.listConversations(tenantId, { limit: 10, affectee: 'aucune' })).toHaveLength(0);
  });

  it('🔴 supprimer le membre LIBÈRE la conversation au lieu de l’emporter', async () => {
    // Une conversation que plus personne ne peut prendre serait invisible et sans réponse : le pire cas.
    await store.setAssignee(tenantId, conv, membre, membre);
    await pool.query('delete from users where id = $1', [membre]);
    expect(await store.getAssignee(tenantId, conv)).toBeNull();
    expect(await store.listConversations(tenantId, { limit: 10, affectee: 'aucune' })).toHaveLength(1);
  });
});

/**
 * DELTA du fil (lot 5 du programme II) : ne redemander que les messages postérieurs à celui qu'on a déjà.
 *
 * 🔴 Même raison d'être en intégration que la pagination ci-dessus, et même piège : tout se joue dans une
 * comparaison de TUPLE `(created_at, id) > ($1, $2)`. Le cas qui casse une comparaison sur l'horodatage SEUL
 * est celui de deux messages écrits à la MÊME milliseconde, ce qu'une salve de scénario produit tous les
 * jours. Un faux store ne dirait rien de tout ça.
 */
describe.skipIf(!url)('PgInboxStore : delta du fil (Supabase)', () => {
  let pool: Pool;
  let store: PgInboxStore;
  let tenantId = '';
  let conversationId = '';
  const T1 = '2026-06-01T10:00:00.000Z';
  const T2 = '2026-06-01T10:00:05.000Z';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    store = new PgInboxStore(pool);
    tenantId = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-delta-fil') returning id`,
    )).rows[0]!.id;
    conversationId = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, last_message_at) values ($1, '33600000095', $2) returning id`,
      [tenantId, T2],
    )).rows[0]!.id;
    // DEUX messages exactement au même instant, puis un troisième plus tard.
    for (const [corps, at] of [['a', T1], ['b', T1], ['c', T2]] as const) {
      await pool.query(
        `insert into conversation_messages (conversation_id, direction, body, created_at) values ($1, 'in', $2, $3)`,
        [conversationId, corps, at],
      );
    }
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  it('sans point de reprise : tout le fil, le plus récent en dernier', async () => {
    const tous = await store.getMessages(conversationId);
    expect(tous).toHaveLength(3);
    // ⚠️ Les DEUX messages du même horodatage sortent dans l'ordre de leur `id`, qui est un uuid ALÉATOIRE :
    // ce n'est pas l'ordre d'arrivée, et ça ne peut pas l'être (rien ne l'enregistre à la milliseconde près).
    // Ce test l'a appris en rougissant en CI sur `['b','a','c']`. Le tri reste DÉTERMINISTE, ce qui est ce
    // dont le curseur a besoin ; l'ordre d'affichage de deux messages simultanés, lui, est indifférent.
    expect(tous.slice(0, 2).map((m) => m.body).sort()).toEqual(['a', 'b']);
    expect(tous[2]!.body).toBe('c');
  });

  it('🔴 deux messages au MÊME horodatage : le second n’est pas escamoté', async () => {
    // C'est le cas que casserait une comparaison sur `created_at` seul : en repartant du premier des deux, un
    // `>` sur l'horodatage sauterait le second à jamais. Le contact aurait écrit, l'écran ne le montrerait
    // jamais, et personne ne saurait pourquoi.
    const tous = await store.getMessages(conversationId);
    const premier = tous[0]!;
    const suite = await store.getMessages(conversationId, { at: premier.createdAt, id: premier.id });
    // Les DEUX autres, quel que soit lequel des jumeaux était premier : c'est bien qu'aucun n'est sauté.
    expect(suite).toHaveLength(2);
    expect(suite.map((m) => m.body).sort()).toEqual([tous[1]!.body, 'c'].sort());
  });

  it('à jour : le delta est VIDE (c’est le cas courant, quinze fois par minute)', async () => {
    const tous = await store.getMessages(conversationId);
    const dernier = tous[tous.length - 1]!;
    expect(await store.getMessages(conversationId, { at: dernier.createdAt, id: dernier.id })).toEqual([]);
  });
});
