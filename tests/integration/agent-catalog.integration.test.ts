import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgJournalAppels, PgToolCatalog } from '../../src/agent/catalog.pg';
import { PgAgentSessionStore } from '../../src/agent/session-store.pg';

const url = process.env.DATABASE_URL ?? '';

/**
 * Le catalogue d'outils et le journal d'appels. Ces deux-là ne font que du SQL, donc leur seule preuve
 * honnête est de tourner contre un vrai Postgres : c'est la clause `where` qui porte l'isolation entre
 * clients et le filtre `actif`, pas le code au-dessus.
 *
 * Jamais joué en local (le DATABASE_URL local pointe la PRODUCTION), joué par le job `integration`.
 */
describe.skipIf(!url)('catalogue d outils et journal d appels (Postgres)', () => {
  let pool: Pool;
  let catalogue: PgToolCatalog;
  let journal: PgJournalAppels;
  let sessions: PgAgentSessionStore;
  let tenantId: string;
  let autreTenantId: string;
  let agentId: string;
  let autreAgentId: string;
  let sessionId: string;
  let adminId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    catalogue = new PgToolCatalog(pool);
    journal = new PgJournalAppels(pool);
    sessions = new PgAgentSessionStore(pool);

    const t = await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-agent-catalog') returning id`);
    tenantId = t.rows[0]!.id;
    const t2 = await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-agent-catalog-autre') returning id`);
    autreTenantId = t2.rows[0]!.id;

    const u = await pool.query<{ id: string }>(
      `insert into users (tenant_id, email, role, password_hash) values ($1, 'itest-catalog@example.test', 'admin', 'x') returning id`,
      [tenantId],
    );
    adminId = u.rows[0]!.id;

    const a = await pool.query<{ id: string }>(
      `insert into agents (tenant_id, label, mention_ia, modele) values ($1, 'itest-cat', 'Je suis une IA.', 'm') returning id`,
      [tenantId],
    );
    agentId = a.rows[0]!.id;
    const a2 = await pool.query<{ id: string }>(
      `insert into agents (tenant_id, label, mention_ia, modele) values ($1, 'itest-cat-2', 'Je suis une IA.', 'm') returning id`,
      [tenantId],
    );
    autreAgentId = a2.rows[0]!.id;

    // Un outil ACTIF (activé par un humain, comme la contrainte l'exige) et un outil ÉTEINT.
    await pool.query(
      `insert into agent_tools (tenant_id, agent_id, origin, name, title, description, ne_pas_utiliser,
                                params, binding, output_paths, risk, timeout_ms, max_bytes, actif, active_par)
       values ($1, $2, 'mba', 'lire_commande', 'Lire', 'lit une commande', 'jamais pour annuler',
               $3::jsonb, $4::jsonb, array['data.statut'], 'read', 4000, 2048, true, $5)`,
      [tenantId, agentId,
        JSON.stringify([{ name: 'reference', type: 'string', source: 'modele', required: true }]),
        JSON.stringify({ handler: 'lire_contact' }), adminId],
    );
    await pool.query(
      `insert into agent_tools (tenant_id, agent_id, origin, name, title, description, ne_pas_utiliser, risk, actif)
       values ($1, $2, 'mba', 'outil_eteint', 'Éteint', 'inactif', 'jamais', 'read', false)`,
      [tenantId, agentId],
    );

    const w = await pool.query<{ id: string }>(
      `insert into workflows (tenant_id, name) values ($1, 'itest-agent-catalog') returning id`,
      [tenantId],
    );
    const r = await pool.query<{ id: string }>(
      `insert into workflow_runs (workflow_id, tenant_id, wa_id, current_node, status)
       values ($1, $2, '33600000001', 'a', 'waiting') returning id`,
      [w.rows[0]!.id, tenantId],
    );
    const s = await sessions.open({ tenantId, runId: r.rows[0]!.id, agentId, nodeId: 'a', waId: '33600000001' });
    sessionId = s.id;
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    if (autreTenantId) await pool.query('delete from tenants where id = $1', [autreTenantId]);
    await pool.end();
  });

  it('lit un outil actif avec ses colonnes de garde', async () => {
    const o = await catalogue.byName(tenantId, agentId, 'lire_commande');
    expect(o).toMatchObject({
      origin: 'mba', name: 'lire_commande', risk: 'read', timeoutMs: 4000, maxBytes: 2048, autonome: false,
      outputPaths: ['data.statut'],
    });
    expect(o?.binding).toEqual({ handler: 'lire_contact' });
  });

  it('🔴 un outil ÉTEINT est invisible : l autorisation se relit en base, pas dans la liste exposée', async () => {
    // `vercel/ai#8653` documente exactement le cas où le filtrage d'exposition marchait pendant que
    // l'exécuteur tapait dans le catalogue complet.
    expect(await catalogue.byName(tenantId, agentId, 'outil_eteint')).toBeNull();
    expect((await catalogue.listActifs(tenantId, agentId)).map((o) => o.name)).toEqual(['lire_commande']);
  });

  it('🔴 un AUTRE tenant, ou un AUTRE agent du même tenant, ne voit pas cet outil', async () => {
    expect(await catalogue.byName(autreTenantId, agentId, 'lire_commande')).toBeNull();
    expect(await catalogue.byName(tenantId, autreAgentId, 'lire_commande')).toBeNull();
    expect(await catalogue.listActifs(autreTenantId, agentId)).toEqual([]);
  });

  it('un nom inconnu rend null, sans lever', async () => {
    expect(await catalogue.byName(tenantId, agentId, 'jamais_declare')).toBeNull();
  });

  it('le journal ouvre en « refuse » puis se clôt avec son issue', async () => {
    // Ouvrir en `refuse` fait qu'une ligne que rien ne vient clore (process tué en plein appel) reste lisible
    // comme « tentée, jamais aboutie » plutôt que de se faire passer pour un succès.
    const id = await journal.ouvrir({
      tenantId, sessionId, toolId: null, toolName: 'lire_commande', origin: 'mba', argsRediges: { reference: 'X' },
    });
    const avant = await pool.query<{ status: string }>('select status from agent_tool_calls where id = $1', [id]);
    expect(avant.rows[0]?.status).toBe('refuse');

    await journal.clore({ tenantId, id, status: 'ok', dureeMs: 42, tailleReponse: 128 });
    const apres = await pool.query<{ status: string; duree_ms: number; taille_reponse: number; args_rediges: unknown }>(
      'select status, duree_ms, taille_reponse, args_rediges from agent_tool_calls where id = $1', [id],
    );
    expect(apres.rows[0]).toMatchObject({ status: 'ok', duree_ms: 42, taille_reponse: 128 });
    expect(apres.rows[0]?.args_rediges).toEqual({ reference: 'X' });
  });

  it('🔴 clore avec un AUTRE tenant ne touche pas la ligne (isolation)', async () => {
    const id = await journal.ouvrir({ tenantId, sessionId, toolId: null, toolName: 'x', origin: 'mba', argsRediges: null });
    await journal.clore({ tenantId: autreTenantId, id, status: 'ok', dureeMs: 1 });
    const res = await pool.query<{ status: string }>('select status from agent_tool_calls where id = $1', [id]);
    expect(res.rows[0]?.status).toBe('refuse'); // inchangée
  });

  it('compterAppel incrémente le compteur de la session, même close', async () => {
    // C'est ce compteur qui rend effectif le plafond d'appels lu par `runTurn` d'un tour sur l'autre.
    await sessions.compterAppel(tenantId, sessionId);
    await sessions.compterAppel(tenantId, sessionId);
    const res = await pool.query<{ appels_outils: number }>('select appels_outils from agent_sessions where id = $1', [sessionId]);
    expect(res.rows[0]?.appels_outils).toBe(2);

    await sessions.clore(tenantId, sessionId, 'sortie', 'humain');
    await sessions.compterAppel(tenantId, sessionId);
    const apres = await pool.query<{ appels_outils: number }>('select appels_outils from agent_sessions where id = $1', [sessionId]);
    expect(apres.rows[0]?.appels_outils).toBe(3);
  });

  it('🔴 compterAppel d un AUTRE tenant ne compte rien (isolation)', async () => {
    await sessions.compterAppel(autreTenantId, sessionId);
    const res = await pool.query<{ appels_outils: number }>('select appels_outils from agent_sessions where id = $1', [sessionId]);
    expect(res.rows[0]?.appels_outils).toBe(3);
  });
});
