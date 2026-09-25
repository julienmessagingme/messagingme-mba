// tests/integration/v1-catalogues.integration.test.ts
import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgWorkflowStore } from '../../src/workflow/store.pg';
import { PgTemplateHintStore } from '../../src/crm/template-hints.pg';
import type { WorkflowGraph } from '../../src/workflow/graph';

const url = process.env.DATABASE_URL ?? '';

/**
 * LES DEUX LECTURES DES CATALOGUES DE L'API PUBLIQUE (lot 4).
 *
 * 🔴 CE QUI SE PROUVE ICI EST DANS LE SQL : « publié » veut dire « le graphe PUBLIÉ porte au moins un
 * bloc », jamais « un brouillon existe » ; et chaque ligne rendue appartient à l'espace demandé. Un faux
 * store rendrait ce qu'on lui fait rendre.
 *
 * Jamais joué en local (le DATABASE_URL local pointe la PRODUCTION), joué par le job `integration`.
 */
describe.skipIf(!url)('les lectures des catalogues de l’API publique (Postgres)', () => {
  let pool: Pool;
  let espaceA = '';
  let espaceB = '';
  const graphe: WorkflowGraph = {
    nodes: [{ id: 'n1', type: 'template', position: { x: 0, y: 0 }, data: { templateName: 'promo' } }],
    edges: [],
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    espaceA = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-catalogues-a') returning id`)).rows[0]!.id;
    espaceB = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-catalogues-b') returning id`)).rows[0]!.id;
  });

  afterAll(async () => {
    await pool.query('delete from tenants where id = any($1::uuid[])', [[espaceA, espaceB].filter((x) => x !== '')]);
    await pool.end();
  });

  it('🔴 listPublies : seuls les scénarios EN LIGNE de CET espace, triés par nom', async () => {
    const store = new PgWorkflowStore(pool);
    // Jamais publié : le graphe part en brouillon, le publié reste vide. Un envoi n'aurait rien à jouer.
    await store.insert(espaceA, 'b-brouillon-seul', graphe);
    const enLigne = await store.insert(espaceA, 'a-en-ligne', graphe);
    await store.publish(enLigne.id, espaceA);
    const ailleurs = await store.insert(espaceB, 'c-autre-espace', graphe);
    await store.publish(ailleurs.id, espaceB);

    const lignes = await store.listPublies(espaceA);
    expect(lignes.map((l) => l.name)).toEqual(['a-en-ligne']);
    expect(lignes[0]!.graph.nodes).toHaveLength(1);
    expect(lignes[0]!.publishedAt).not.toBeNull();
    expect(lignes[0]!.code).toMatch(/^scn_/);
  });

  it('🔴 listPublies lit le PUBLIÉ : un brouillon posé par-dessus ne change rien', async () => {
    const store = new PgWorkflowStore(pool);
    const s = await store.insert(espaceA, 'd-en-ligne-avec-brouillon', graphe);
    await store.publish(s.id, espaceA);
    // Un brouillon VIDE : si la lecture prenait le brouillon, le scénario disparaîtrait du catalogue.
    await store.update(s.id, espaceA, { graph: { nodes: [], edges: [] } });
    const ligne = (await store.listPublies(espaceA)).find((l) => l.name === 'd-en-ligne-avec-brouillon');
    expect(ligne?.graph.nodes).toHaveLength(1);
  });

  it('🔴 listerParEspace : tous les indices de l’espace, triés, et aucun d’un autre espace', async () => {
    const indices = new PgTemplateHintStore(pool);
    await indices.save(espaceA, 'confirmation', 'fr', [{ position: 1, source: { type: 'field', key: 'prenom' } }]);
    await indices.save(espaceA, 'confirmation', 'en', [{ position: 2, source: { type: 'attribute', key: 'name' } }]);
    await indices.save(espaceB, 'confirmation', 'fr', [{ position: 1, source: { type: 'literal', value: 'ne doit pas sortir' } }]);

    expect(await indices.listerParEspace(espaceA)).toEqual([
      { name: 'confirmation', language: 'en', position: 2, source: { type: 'attribute', key: 'name' } },
      { name: 'confirmation', language: 'fr', position: 1, source: { type: 'field', key: 'prenom' } },
    ]);
  });
});
