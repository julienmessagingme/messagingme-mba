import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgWorkflowRunStore } from '../../src/workflow/run-store.pg';

const url = process.env.DATABASE_URL ?? '';

/**
 * La RÉSERVATION du tour d'avance, contre une vraie base (migration 0104).
 *
 * 🔴 EN INTÉGRATION parce que c'est Postgres qui rend le verrou vrai : l'atomicité de l'`update ... returning`
 * est ce qui empêche deux avances concurrentes d'envoyer toutes les deux. Un faux prouve ma lecture du SQL,
 * pas le SQL. Et ce trou-là est le plus cher du produit : il fait recevoir à un client un message qu'il ne
 * devait jamais voir.
 *
 * Jamais joué en local (le DATABASE_URL local pointe la PRODUCTION), joué par le job `integration`.
 */
describe.skipIf(!url)('réservation du tour d’avance (Postgres)', () => {
  let pool: Pool;
  let store: PgWorkflowRunStore;
  let tenantId = '';
  let workflowId = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 3 });
    store = new PgWorkflowRunStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-avance') returning id`)).rows[0]!.id;
    workflowId = (await pool.query<{ id: string }>(
      `insert into workflows (tenant_id, name, graph) values ($1, 'itest', '{"nodes":[],"edges":[]}'::jsonb) returning id`,
      [tenantId],
    )).rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]).catch(() => {});
    await pool.end().catch(() => {});
  });

  /** Un run en attente sur le bloc `a`. */
  async function runEnAttente(waId: string): Promise<string> {
    const { id } = await store.start(tenantId, workflowId, waId, null, { currentNode: 'a', status: 'waiting' });
    return id;
  }

  it('🔴 deux réservations SIMULTANÉES : une seule est accordée', async () => {
    // C'est la propriété qui ferme le double envoi. Sans l'atomicité, les deux passent et les deux envoient.
    const id = await runEnAttente('33600000201');
    const [a, b] = await Promise.all([
      store.reserverAvance(tenantId, id, 'a', 60),
      store.reserverAvance(tenantId, id, 'a', 60),
    ]);
    expect([a, b].filter((x) => x !== null)).toHaveLength(1);
  });

  it('🔴 le tour LIBÉRÉ est reprenable tout de suite : le contact ne doit pas attendre le bail', async () => {
    const id = await runEnAttente('33600000202');
    const jeton = await store.reserverAvance(tenantId, id, 'a', 60);
    expect(jeton).not.toBeNull();
    expect(await store.reserverAvance(tenantId, id, 'a', 60)).toBeNull();
    await store.libererAvance(id, jeton!);
    expect(await store.reserverAvance(tenantId, id, 'a', 60)).not.toBeNull();
  });

  it('🔴 un JETON PÉRIMÉ ne libère pas le verrou de celui qui l’a repris', async () => {
    // Sans cette garde, un traitement lent revenu en retard ferait sauter la protection d'un autre, qui
    // enverrait alors en même temps qu'un troisième. C'est la même règle que le verrou de run de campagne.
    const id = await runEnAttente('33600000203');
    const ancien = await store.reserverAvance(tenantId, id, 'a', -1); // bail déjà expiré
    const neuf = await store.reserverAvance(tenantId, id, 'a', 60); // repris par un autre
    expect(neuf).not.toBeNull();
    await store.libererAvance(id, ancien!); // l'ancien revient trop tard et tente de libérer
    // Le verrou du NOUVEAU tient toujours.
    expect(await store.reserverAvance(tenantId, id, 'a', 60)).toBeNull();
  });

  it('🔴 un BAIL expiré est repris : un worker tué ne bloque pas le parcours à vie', async () => {
    const id = await runEnAttente('33600000204');
    expect(await store.reserverAvance(tenantId, id, 'a', -1)).not.toBeNull();
    expect(await store.reserverAvance(tenantId, id, 'a', 60)).not.toBeNull();
  });

  it('le tour est refusé si le parcours a BOUGÉ depuis la lecture', async () => {
    // La garde sur `current_node` : réserver un tour sur un bloc qu'on ne tient plus n'aurait aucun sens.
    const id = await runEnAttente('33600000205');
    expect(await store.reserverAvance(tenantId, id, 'un-autre-bloc', 60)).toBeNull();
  });

  /**
   * LE RENOUVELLEMENT DU BAIL (lot 1 du plan post-audit, 2026-09-02).
   *
   * 🔴 Ce que ça ferme, et que la réservation seule ne fermait pas : le porteur LENT. Un envoi Meta qui
   * rejoue ses tentatives peut durer ~154 s, une avance peut en enchaîner plusieurs, donc le bail expirait
   * pendant qu'on travaillait encore. Un autre reprenait le tour, et LES DEUX envoyaient.
   */
  describe('renouvellement du bail', () => {
    it('🔴 prolonger REPOUSSE le bail : le tour cesse d’être reprenable', async () => {
      const id = await runEnAttente('33600000207');
      // Bail déjà expiré : sans prolongation, n'importe qui reprend le tour à l'instant même.
      const jeton = await store.reserverAvance(tenantId, id, 'a', -1);
      expect(jeton).not.toBeNull();
      expect(await store.prolongerAvance(id, jeton!, 60)).toBe(true);
      // Et voilà le point : le tour n'est plus libre alors qu'il l'était une ligne plus haut.
      expect(await store.reserverAvance(tenantId, id, 'a', 60)).toBeNull();
    });

    it('🔴 un jeton PÉRIMÉ ne prolonge rien, et ne vole pas le bail de celui qui a repris', async () => {
      // Sans cette garde, le porteur lent repousserait le bail du NOUVEAU porteur et les deux se croiraient
      // légitimes. C'est la même règle que pour la libération, et elle doit tenir dans les deux sens.
      const id = await runEnAttente('33600000208');
      const ancien = await store.reserverAvance(tenantId, id, 'a', -1);
      const neuf = await store.reserverAvance(tenantId, id, 'a', 60);
      expect(neuf).not.toBeNull();
      expect(await store.prolongerAvance(id, ancien!, 600)).toBe(false);
      // Le bail du nouveau est intact : il tient toujours, et c'est bien LUI qui peut le prolonger.
      expect(await store.reserverAvance(tenantId, id, 'a', 60)).toBeNull();
      expect(await store.prolongerAvance(id, neuf!, 60)).toBe(true);
    });
  });

  /**
   * L'ÉCRITURE D'ÉTAT EST CLÔTURÉE PAR LE JETON (lot 1 du plan post-audit, 2026-09-02).
   *
   * Avant, `setStateSiEncoreSur` filtrait sur `id`, `tenant_id`, `status` et `current_node`, jamais sur
   * `avance_token` : un porteur de bail périmé pouvait donc écrire l'état par-dessus celui qui avait repris
   * le tour. La réservation protégeait les envois, l'écriture restait ouverte.
   */
  describe('écriture d’état clôturée par le jeton', () => {
    it('🔴 un porteur PÉRIMÉ ne peut plus écrire l’état', async () => {
      const id = await runEnAttente('33600000209');
      const ancien = await store.reserverAvance(tenantId, id, 'a', -1);
      const neuf = await store.reserverAvance(tenantId, id, 'a', 60);
      expect(neuf).not.toBeNull();
      // L'ancien revient de son envoi lent et tente d'écrire : refusé.
      expect(await store.setStateSiEncoreSur(tenantId, id, 'a', { currentNode: 'b', status: 'waiting' }, ancien!)).toBe(false);
      // Le porteur légitime, lui, écrit.
      expect(await store.setStateSiEncoreSur(tenantId, id, 'a', { currentNode: 'b', status: 'waiting' }, neuf!)).toBe(true);
    });

    it('sans jeton, la garde garde son comportement d’avant (fixtures, e2e)', async () => {
      // La compatibilité est délibérée : un store qui ne réserve pas ne doit pas cesser d'écrire, sinon on
      // figerait les parcours des câblages qui ne posent pas de réservation.
      const id = await runEnAttente('33600000210');
      await store.reserverAvance(tenantId, id, 'a', 60);
      expect(await store.setStateSiEncoreSur(tenantId, id, 'a', { currentNode: 'b', status: 'waiting' })).toBe(true);
    });
  });

  it('le tour est refusé pour un AUTRE espace', async () => {
    // Scope tenant, comme toute écriture : le pooler est superuser, la RLS ne joue pas.
    const id = await runEnAttente('33600000206');
    const autre = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-avance-2') returning id`)).rows[0]!.id;
    try {
      expect(await store.reserverAvance(autre, id, 'a', 60)).toBeNull();
    } finally {
      await pool.query('delete from tenants where id = $1', [autre]).catch(() => {});
    }
  });
});
