import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgInboxStore } from '../../src/inbox/store.pg';
import { PgWorkflowRunStore } from '../../src/workflow/run-store.pg';
import { peutEcrire } from '../../src/inbox/assignment';

const url = process.env.DATABASE_URL ?? '';

/**
 * Conversations NON LUES : le SQL, contre une vraie base (migration 0055).
 *
 * Pourquoi en intégration et pas en unitaire : le calcul vit ENTIÈREMENT dans une requête (un `exists` sur
 * `conversation_messages` comparé à `conversations.last_read_at`). Un faux store dirait toujours ce qu'on
 * lui fait dire. C'est le même angle mort qui avait laissé passer un `resume_at` jamais écrit, le 2026-08-15.
 */
describe.skipIf(!url)('PgInboxStore : conversations non lues (Supabase)', () => {
  let pool: Pool;
  let tenantId: string;
  let store: PgInboxStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-unread') returning id`)).rows[0]!.id;
    store = new PgInboxStore(pool);
  });
  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  /** Crée une conversation et y pose un message, dans la direction demandée. Rend l'id de conversation. */
  async function conversationAvec(waId: string, direction: 'in' | 'out'): Promise<string> {
    const conv = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id) values ($1, $2) returning id`,
      [tenantId, waId],
    )).rows[0]!.id;
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, body) values ($1, $2, 'text', 'coucou')`,
      [conv, direction],
    );
    return conv;
  }

  /**
   * ⚠️ CES TESTS COMPTENT POUR UN ADMIN, et c'est ce qui leur fait garder EXACTEMENT le cas qu'ils
   * exerçaient : un admin voit tout, affecté ou non. La visibilité PAR MEMBRE a ses propres tests, plus bas.
   */
  const ADMIN = { userId: null, role: 'admin' };

  it('un message ENTRANT sur un fil jamais ouvert -> non lu', async () => {
    await conversationAvec('33600000001', 'in');
    expect(await store.countUnread(tenantId, ADMIN)).toBe(1);
    const liste = await store.listConversations(tenantId);
    expect(liste.find((c) => c.waId === '33600000001')?.unread).toBe(true);
  });

  it('nos propres envois ne rendent PAS un fil non lu (sinon toute campagne allumerait le compteur)', async () => {
    await conversationAvec('33600000002', 'out');
    // Toujours 1 : seule la conversation entrante du test précédent compte.
    expect(await store.countUnread(tenantId, ADMIN)).toBe(1);
    const liste = await store.listConversations(tenantId);
    expect(liste.find((c) => c.waId === '33600000002')?.unread).toBe(false);
  });

  it('marquer lu éteint le compteur', async () => {
    const conv = (await pool.query<{ id: string }>(
      `select id from conversations where tenant_id = $1 and wa_id = '33600000001'`, [tenantId],
    )).rows[0]!.id;
    await store.markConversationRead(tenantId, conv);
    expect(await store.countUnread(tenantId, ADMIN)).toBe(0);
  });

  it('un NOUVEAU message entrant après lecture rallume le compteur', async () => {
    const conv = (await pool.query<{ id: string }>(
      `select id from conversations where tenant_id = $1 and wa_id = '33600000001'`, [tenantId],
    )).rows[0]!.id;
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, body) values ($1, 'in', 'text', 'encore')`,
      [conv],
    );
    expect(await store.countUnread(tenantId, ADMIN)).toBe(1);
  });

  it('marquer lu depuis un AUTRE tenant ne touche rien (isolation)', async () => {
    const autre = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-unread-autre') returning id`)).rows[0]!.id;
    try {
      const conv = (await pool.query<{ id: string }>(
        `select id from conversations where tenant_id = $1 and wa_id = '33600000001'`, [tenantId],
      )).rows[0]!.id;
      await store.markConversationRead(autre, conv);
      expect(await store.countUnread(tenantId, ADMIN)).toBe(1); // toujours non lu : le tenant ne correspondait pas
    } finally {
      await pool.query('delete from tenants where id = $1', [autre]);
    }
  });

  it('le compteur ne voit QUE son tenant', async () => {
    const autre = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-unread-voisin') returning id`)).rows[0]!.id;
    try {
      const conv = (await pool.query<{ id: string }>(
        `insert into conversations (tenant_id, wa_id) values ($1, '33699999999') returning id`, [autre],
      )).rows[0]!.id;
      await pool.query(`insert into conversation_messages (conversation_id, direction, type, body) values ($1, 'in', 'text', 'chez le voisin')`, [conv]);
      expect(await store.countUnread(tenantId, ADMIN)).toBe(1); // inchangé
      expect(await store.countUnread(autre, ADMIN)).toBe(1);
    } finally {
      await pool.query('delete from tenants where id = $1', [autre]);
    }
  });
  /**
   * 🔴 LA PASTILLE EST CELLE DE L'UTILISATEUR, PAS CELLE DE L'ESPACE.
   *
   * Elle comptait TOUTES les conversations non lues du client, pour tout le monde : un agent voyait « 12 »
   * alors qu'aucune ne lui revenait, et il cessait de la regarder. La règle est celle de `peutEcrire`
   * (`src/inbox/assignment.ts`), demandée par Julien le 2026-09-10 : le pot commun pour tout le monde, le
   * reste pour son affectataire, et tout pour un manager ou un admin.
   */
  describe('🔴 la pastille suit QUI a le droit de traiter la conversation', () => {
    let espace = '';
    let anne = '';
    let bruno = '';
    let cheffe = '';

    beforeAll(async () => {
      espace = (await pool.query<{ id: string }>(
        `insert into tenants (name) values ('itest-unread-visibilite') returning id`,
      )).rows[0]!.id;
      const membre = async (email: string, role: string): Promise<string> => (await pool.query<{ id: string }>(
        `insert into users (tenant_id, email, password_hash, role) values ($1, $2, 'x', $3) returning id`,
        [espace, email, role],
      )).rows[0]!.id;
      anne = await membre('anne@itest.test', 'agent');
      bruno = await membre('bruno@itest.test', 'agent');
      cheffe = await membre('cheffe@itest.test', 'manager');

      // Trois conversations NON LUES : une au pot commun, une pour Anne, une pour Bruno.
      const poser = async (waId: string, affectee: string | null): Promise<void> => {
        const conv = (await pool.query<{ id: string }>(
          `insert into conversations (tenant_id, wa_id, assigned_to) values ($1, $2, $3) returning id`,
          [espace, waId, affectee],
        )).rows[0]!.id;
        await pool.query(
          `insert into conversation_messages (conversation_id, direction, type, body) values ($1, 'in', 'text', 'coucou')`,
          [conv],
        );
      };
      await poser('33620000001', null);
      await poser('33620000002', anne);
      await poser('33620000003', bruno);
    });
    afterAll(async () => {
      if (espace) await pool.query('delete from tenants where id = $1', [espace]);
    });

    it('🔴 un AGENT ne voit que le pot commun et ce qui lui revient', async () => {
      // Deux sur trois pour Anne : la non affectée et la sienne. Celle de Bruno ne l'allume pas.
      expect(await store.countUnread(espace, { userId: anne, role: 'agent' })).toBe(2);
      expect(await store.countUnread(espace, { userId: bruno, role: 'agent' })).toBe(2);
    });

    it('🔴 un MANAGER et un ADMIN voient tout', async () => {
      expect(await store.countUnread(espace, { userId: cheffe, role: 'manager' })).toBe(3);
      expect(await store.countUnread(espace, { userId: null, role: 'admin' })).toBe(3);
    });

    it('🔴 l’OBSERVATION depuis /ops (un admin dont l’identifiant n’est PAS un uuid) voit tout, sans planter', async () => {
      // `observerTenant` signe une session `userId: 'ops-observation'` : avant le correctif, la requête
      // convertissait cet identifiant en uuid même pour un acteur qui voit tout, et rendait 22P02 (500 à l'écran).
      expect(await store.countUnread(espace, { userId: 'ops-observation', role: 'admin' })).toBe(3);
    });

    it('⚠️ une conversation NON AFFECTÉE allume la pastille de TOUT LE MONDE', async () => {
      // Sinon elle n'allumerait celle de personne et resterait invisible jusqu'à ce qu'un manager la
      // distribue, ce qui est exactement la conversation qu'il ne faut pas perdre.
      const seule = (await pool.query<{ id: string }>(
        `insert into tenants (name) values ('itest-unread-pot-commun') returning id`,
      )).rows[0]!.id;
      try {
        const conv = (await pool.query<{ id: string }>(
          `insert into conversations (tenant_id, wa_id) values ($1, '33630000001') returning id`, [seule],
        )).rows[0]!.id;
        await pool.query(
          `insert into conversation_messages (conversation_id, direction, type, body) values ($1, 'in', 'text', 'x')`, [conv],
        );
        expect(await store.countUnread(seule, { userId: 'e1f0c0de-0000-4000-8000-000000000001', role: 'agent' })).toBe(1);
      } finally {
        await pool.query('delete from tenants where id = $1', [seule]);
      }
    });

    it('🔴 le bloc « passer à un humain » AFFECTE, et refuse un membre qui n’en est pas un', async () => {
      // Le moteur de scénario ne connaît que le numéro du contact, d'où l'affectation PAR wa_id. La garde sur
      // `users` est ce qui empêche un identifiant recopié dans un graphe d'affecter une conversation à
      // quelqu'un d'un AUTRE espace : elle disparaîtrait alors de la vue de tout le monde ici.
      // ⚠️ SON PROPRE ESPACE : le test voisin compte les conversations de `espace` une par une, et y ajouter
      // une ligne le casserait. Un test qui ajoute à une fixture partagée casse ses voisins.
      const seul = (await pool.query<{ id: string }>(
        `insert into tenants (name) values ('itest-affectation-noeud') returning id`,
      )).rows[0]!.id;
      try {
        const membre = (await pool.query<{ id: string }>(
          `insert into users (tenant_id, email, password_hash, role) values ($1, 'zoe@itest.test', 'x', 'agent') returning id`,
          [seul],
        )).rows[0]!.id;
        const conv = (await pool.query<{ id: string }>(
          `insert into conversations (tenant_id, wa_id) values ($1, '33640000001') returning id`, [seul],
        )).rows[0]!.id;

        expect(await store.setAssigneeByWaId(seul, '33640000001', membre)).toBe(true);
        const apres = await pool.query<{ assigned_to: string | null; assigned_by: string | null }>(
          'select assigned_to, assigned_by from conversations where id = $1', [conv],
        );
        expect(apres.rows[0]!.assigned_to).toBe(membre);
        // ⚠️ `assigned_by` reste NULL : personne n'a cliqué, c'est le scénario. Le journal distingue ainsi un
        // routage automatique d'une distribution faite à la main.
        expect(apres.rows[0]!.assigned_by).toBeNull();

        // Un membre d'un AUTRE espace : refus, et l'affectation précédente ne bouge pas.
        expect(await store.setAssigneeByWaId(seul, '33640000001', anne)).toBe(false);
        const encore = await pool.query<{ assigned_to: string | null }>(
          'select assigned_to from conversations where id = $1', [conv],
        );
        expect(encore.rows[0]!.assigned_to).toBe(membre);
      } finally {
        await pool.query('delete from tenants where id = $1', [seul]);
      }
    });

    it('🔴 le SQL et `peutEcrire` rendent le MÊME verdict sur les mêmes lignes', async () => {
      // La règle est écrite DEUX fois (une fonction pour les routes, un fragment SQL pour les compteurs) :
      // c'est assumé, mais ça ne tient que si les deux disent la même chose. Ce test les confronte sur
      // toutes les combinaisons qui existent dans l'espace de ce test.
      const lignes = (await pool.query<{ assigned_to: string | null }>(
        'select assigned_to from conversations where tenant_id = $1', [espace],
      )).rows;
      expect(lignes).toHaveLength(3);
      for (const acteur of [
        { userId: anne, role: 'agent' },
        { userId: bruno, role: 'agent' },
        { userId: cheffe, role: 'manager' },
        { userId: null, role: 'admin' },
      ]) {
        const attendu = lignes.filter((l) => peutEcrire(acteur, l.assigned_to)).length;
        expect(await store.countUnread(espace, acteur), `${acteur.role} ${acteur.userId ?? '-'}`).toBe(attendu);
      }
    });
  });
});

/**
 * Lancement MANUEL d'un scénario depuis l'Inbox : le parcours déjà en cours sur le contact doit être clos,
 * sinon les deux vivent en parallèle (le contact reçoit les messages des deux) et le plus ancien devient
 * orphelin pour toujours, `findWaitingByWaId` ne rendant que le plus récent.
 */
describe.skipIf(!url)('PgWorkflowRunStore.closeActiveByWaId (Supabase)', () => {
  let pool: Pool;
  let tenantId: string;
  let autreTenant: string;
  let workflowId: string;
  let store: PgWorkflowRunStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-close-runs') returning id`)).rows[0]!.id;
    autreTenant = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-close-runs-voisin') returning id`)).rows[0]!.id;
    workflowId = (await pool.query<{ id: string }>(
      `insert into workflows (tenant_id, name, graph) values ($1, 'itest', '{"nodes":[],"edges":[]}'::jsonb) returning id`,
      [tenantId],
    )).rows[0]!.id;
    store = new PgWorkflowRunStore(pool);
  });
  afterAll(async () => {
    for (const t of [tenantId, autreTenant]) if (t) await pool.query('delete from tenants where id = $1', [t]);
    await pool.end();
  });

  const statuts = async (tenant: string, waId: string): Promise<string[]> =>
    (await pool.query<{ status: string }>(
      `select status from workflow_runs where tenant_id = $1 and wa_id = $2 order by created_at`, [tenant, waId],
    )).rows.map((r) => r.status);

  it('clôt les parcours en attente ET endormis, et rend leur nombre', async () => {
    await store.start(tenantId, workflowId, '33600000010', null, { currentNode: 'n1', status: 'waiting' }, null);
    await store.start(tenantId, workflowId, '33600000010', null, { currentNode: 'n2', status: 'sleeping', resumeAt: new Date(Date.now() + 3_600_000) }, null);
    // 🔴 REND LES IDENTIFIANTS DES PARCOURS CLOS, plus leur nombre, depuis le 2026-09-07 : l appelant doit
    // pouvoir clore les SESSIONS D AGENT qui y sont rattachees. Le cas exerce est inchange (deux parcours,
    // en attente et endormi, tous deux clos), c est sa forme qui a change.
    // ⚠️ `tsc` ne pouvait pas voir cette rupture : `expect(...).toBe(2)` accepte n importe quel type.
    expect(await store.closeActiveByWaId(tenantId, '33600000010')).toHaveLength(2);
    expect(await statuts(tenantId, '33600000010')).toEqual(['done', 'done']);
  });

  it('efface aussi l’échéance de réveil (sinon le balayage reprendrait un run clos)', async () => {
    await store.start(tenantId, workflowId, '33600000011', null, { currentNode: 'n1', status: 'sleeping', resumeAt: new Date(Date.now() + 3_600_000) }, null);
    await store.closeActiveByWaId(tenantId, '33600000011');
    const { rows } = await pool.query<{ resume_at: Date | null }>(
      `select resume_at from workflow_runs where tenant_id = $1 and wa_id = $2`, [tenantId, '33600000011'],
    );
    expect(rows[0]?.resume_at).toBeNull();
  });

  it('ne touche PAS les parcours d’un autre tenant, ni ceux déjà clos', async () => {
    await store.start(tenantId, workflowId, '33600000012', null, { currentNode: null, status: 'done' }, null);
    const wfVoisin = (await pool.query<{ id: string }>(
      `insert into workflows (tenant_id, name, graph) values ($1, 'itest-voisin', '{"nodes":[],"edges":[]}'::jsonb) returning id`,
      [autreTenant],
    )).rows[0]!.id;
    await store.start(autreTenant, wfVoisin, '33600000012', null, { currentNode: 'n1', status: 'waiting' }, null);

    expect(await store.closeActiveByWaId(tenantId, '33600000012')).toEqual([]); // le sien était déjà clos
    expect(await statuts(autreTenant, '33600000012')).toEqual(['waiting']); // le voisin est intact
  });

  it('aucun parcours actif -> 0, sans erreur', async () => {
    expect(await store.closeActiveByWaId(tenantId, '33699999998')).toEqual([]);
  });

});
