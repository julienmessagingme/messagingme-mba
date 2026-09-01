import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgWorkflowStore, grapheEditable } from '../../src/workflow/store.pg';
import type { WorkflowGraph } from '../../src/workflow/graph';

const url = process.env.DATABASE_URL ?? '';

/**
 * BROUILLON / PUBLIÉ des scénarios (lot 7, migration 0095).
 *
 * 🔴 POURQUOI EN INTÉGRATION. Ce qui doit être prouvé est dans le SQL, pas dans le code : quelle colonne
 * l'éditeur écrit, laquelle l'exécution lit, et les deux `case` qui décident du reste. Un faux store rendrait
 * ce qu'on lui fait rendre. Or la promesse du lot tient en une phrase vérifiable ici et nulle part ailleurs :
 * enregistrer ne change RIEN pour les contacts, seul « Publier » le fait.
 *
 * Jamais joué en local (le DATABASE_URL local pointe la PRODUCTION), joué par le job `integration`.
 */
describe.skipIf(!url)('publication des scénarios (Postgres)', () => {
  let pool: Pool;
  let store: PgWorkflowStore;
  let tenantId: string;

  const graphe = (tag: string): WorkflowGraph => ({
    nodes: [{ id: 'n1', type: 'tag', position: { x: 0, y: 0 }, data: { tag } }],
    edges: [],
  });

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    store = new PgWorkflowStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-publication') returning id`)).rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  it('un scénario NEUF n’est pas en ligne : son graphe part en brouillon, le publié reste vide', async () => {
    const { id } = await store.insert(tenantId, 'neuf', graphe('v1'));
    const row = (await store.getById(id, tenantId))!;
    expect(row.graph.nodes).toHaveLength(0);
    expect(row.draftGraph?.nodes).toHaveLength(1);
    expect(row.publishedAt).toBeNull();
    expect(grapheEditable(row).nodes[0]!.data.tag).toBe('v1');
  });

  it('🔴 enregistrer NE TOUCHE PAS la version en ligne, et publier la remplace', async () => {
    const { id } = await store.insert(tenantId, 'cycle', graphe('v1'));
    await store.publish(id, tenantId);
    const enLigne = (await store.getById(id, tenantId))!;
    expect(enLigne.graph.nodes[0]!.data.tag).toBe('v1');
    expect(enLigne.draftGraph).toBeNull();
    expect(enLigne.publishedAt).not.toBeNull();

    // L'éditeur enregistre une v2. C'est TOUTE la promesse du lot : la v1 continue de tourner.
    const maj = await store.update(id, tenantId, { graph: graphe('v2') });
    expect(maj).toEqual({ trouve: true, brouillon: true });
    const pendant = (await store.getById(id, tenantId))!;
    expect(pendant.graph.nodes[0]!.data.tag).toBe('v1');
    expect(pendant.draftGraph!.nodes[0]!.data.tag).toBe('v2');

    const publie = (await store.publish(id, tenantId))!;
    expect(publie.graph.nodes[0]!.data.tag).toBe('v2');
    expect(publie.draftGraph).toBeNull();
    expect(new Date(publie.publishedAt!).getTime()).toBeGreaterThan(new Date(enLigne.publishedAt!).getTime());
  });

  it('🔴 republier sans brouillon n’efface pas la version en ligne, et ne redate pas la publication', async () => {
    const { id } = await store.insert(tenantId, 'republier', graphe('v1'));
    const premiere = (await store.publish(id, tenantId))!;
    // Sans le `coalesce`, ce second appel écraserait `graph` par NULL : le scénario disparaîtrait de la
    // production sur un double-clic, sans le moindre message.
    const seconde = (await store.publish(id, tenantId))!;
    expect(seconde.graph.nodes[0]!.data.tag).toBe('v1');
    expect(seconde.publishedAt).toBe(premiere.publishedAt);
  });

  it('un enregistrement IDENTIQUE au publié ne laisse aucun brouillon (l’ouverture d’un scénario en produit un)', async () => {
    const { id } = await store.insert(tenantId, 'identique', graphe('v1'));
    await store.publish(id, tenantId);
    const publie = (await store.getById(id, tenantId))!;

    const maj = await store.update(id, tenantId, { graph: publie.graph });
    expect(maj).toEqual({ trouve: true, brouillon: false });
    expect((await store.getById(id, tenantId))!.draftGraph).toBeNull();
  });

  it('un scénario d’un AUTRE espace ne se met à jour ni ne se publie', async () => {
    const { id } = await store.insert(tenantId, 'isolation', graphe('v1'));
    const autre = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-publication-autre') returning id`)).rows[0]!.id;
    try {
      expect(await store.update(id, autre, { graph: graphe('vole') })).toEqual({ trouve: false, brouillon: false });
      expect(await store.publish(id, autre)).toBeNull();
      expect((await store.getById(id, tenantId))!.draftGraph!.nodes[0]!.data.tag).toBe('v1');
    } finally {
      await pool.query('delete from tenants where id = $1', [autre]);
    }
  });
});
