import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgAgentStore } from '../../src/agent/agent-store.pg';
import { PgWorkflowRunStore } from '../../src/workflow/run-store.pg';

const url = process.env.DATABASE_URL ?? '';

/**
 * La plomberie de lecture du tour d'agent : les plafonds de la fiche, et la relecture d'un run par son id.
 * Ces deux lectures ne font que du SQL, donc leur seule preuve honnête est de tourner contre un vrai
 * Postgres. Jamais joué en local (le DATABASE_URL local pointe la PRODUCTION), joué par le job `integration`.
 */
describe.skipIf(!url)('plomberie de lecture de l agent (Postgres)', () => {
  let pool: Pool;
  let agents: PgAgentStore;
  let runs: PgWorkflowRunStore;
  let tenantId: string;
  let autreTenantId: string;
  let agentId: string;
  let runId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    agents = new PgAgentStore(pool);
    runs = new PgWorkflowRunStore(pool);
    const t = await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-agent-store') returning id`);
    tenantId = t.rows[0]!.id;
    const t2 = await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-agent-store-autre') returning id`);
    autreTenantId = t2.rows[0]!.id;
    const a = await pool.query<{ id: string }>(
      `insert into agents (tenant_id, label, mention_ia, modele, max_tours, max_appels_outils, budget_micro_eur, inactivite_minutes)
       values ($1, 'itest', 'Je suis une IA.', 'modele-test', 5, 7, 12345, 42) returning id`,
      [tenantId],
    );
    agentId = a.rows[0]!.id;
    const w = await pool.query<{ id: string }>(
      `insert into workflows (tenant_id, name) values ($1, 'itest-agent-store') returning id`,
      [tenantId],
    );
    const r = await pool.query<{ id: string }>(
      `insert into workflow_runs (workflow_id, tenant_id, wa_id, current_node, status) values ($1, $2, '33600000000', 'a', 'waiting') returning id`,
      [w.rows[0]!.id, tenantId],
    );
    runId = r.rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    if (autreTenantId) await pool.query('delete from tenants where id = $1', [autreTenantId]);
    await pool.end();
  });

  it('lit les plafonds de la fiche, avec le budget converti en number', async () => {
    const f = await agents.byId(tenantId, agentId);
    expect(f?.plafonds).toEqual({ maxTours: 5, maxAppelsOutils: 7, budgetMicroEur: 12345 });
    expect(typeof f?.plafonds.budgetMicroEur).toBe('number'); // et non un BigInt, que JSON.stringify refuserait
    expect(f?.mentionIa).toBe('Je suis une IA.');
    expect(f?.inactiviteMinutes).toBe(42);
    expect(f?.status).toBe('draft');
  });

  it('🔴 une fiche d un AUTRE tenant rend null (node.data.agentId vient du client)', async () => {
    expect(await agents.byId(autreTenantId, agentId)).toBeNull();
  });

  it('fiche inexistante rend null, sans lever', async () => {
    expect(await agents.byId(tenantId, '00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('🔴 listActifs ne rend que les agents ACTIFS, avec leurs règles d arrêt', async () => {
    // C'est cette liste qui GRISE ou non la brique « Agent IA » dans le builder. Un brouillon proposé
    // promettrait une conversation qui n'aurait pas lieu ; et le filtre `status` est du SQL, donc sa seule
    // preuve honnête est de tourner contre un vrai Postgres.
    const fiche = JSON.stringify({ sorties: [{ code: 'besoin_cerne', label: 'Besoin cerné' }, { code: 'X Y' }] });
    await pool.query(
      `insert into agents (tenant_id, label, mention_ia, modele, status, fiche)
       values ($1, 'itest-actif', 'Je suis une IA.', 'm', 'active', $2::jsonb)`,
      [tenantId, fiche],
    );
    await pool.query(
      `insert into agents (tenant_id, label, mention_ia, modele, status) values ($1, 'itest-desactive', 'x', 'm', 'disabled')`,
      [tenantId],
    );
    const liste = await agents.listActifs(tenantId);
    // L'agent créé en `beforeAll` est un brouillon (statut par défaut) : il ne doit pas non plus remonter.
    expect(liste.map((a) => a.label)).toEqual(['itest-actif']);
    // Le code mal formé (« X Y ») est écarté à la lecture : il ne pourrait pas servir de handle d'arête.
    expect(liste[0]?.sorties).toEqual([{ code: 'besoin_cerne', label: 'Besoin cerné' }]);
  });

  it('🔴 listActifs d un AUTRE tenant ne voit rien (le filtrage en code est le seul contrôle)', async () => {
    expect(await agents.listActifs(autreTenantId)).toEqual([]);
  });

  it('byId sur un run rend sa position et son statut', async () => {
    const r = await runs.byId(tenantId, runId);
    expect(r).toMatchObject({ id: runId, currentNode: 'a', status: 'waiting', waId: '33600000000' });
  });

  it('🔴 byId lit TOUS les statuts : le tour doit distinguer un run MORT d un run introuvable', async () => {
    await pool.query(`update workflow_runs set status = 'done', current_node = null where id = $1`, [runId]);
    const r = await runs.byId(tenantId, runId);
    expect(r).not.toBeNull();
    expect(r?.status).toBe('done');
    expect(r?.currentNode).toBeNull();
  });

  it('🔴 byId d un AUTRE tenant rend null (isolation)', async () => {
    expect(await runs.byId(autreTenantId, runId)).toBeNull();
  });

  it('byId d un run inexistant rend null', async () => {
    expect(await runs.byId(tenantId, '00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});
