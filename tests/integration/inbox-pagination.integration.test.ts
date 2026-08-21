import 'dotenv/config';
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
      await pool.query(
        `insert into conversations (tenant_id, wa_id, last_message_at, control_owner) values ($1, $2, $3, $4)`,
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
