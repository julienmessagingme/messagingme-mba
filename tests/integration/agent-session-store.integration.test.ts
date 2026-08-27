import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgAgentSessionStore } from '../../src/agent/session-store.pg';

const url = process.env.DATABASE_URL ?? '';

/**
 * Ce store ne fait que du SQL : sa seule preuve honnête est de tourner contre un vrai Postgres. Ce fichier
 * n'est JAMAIS joué par `npm test` (vitest.config.ts exclut tests/integration/**) ni en local (le
 * DATABASE_URL local pointe la PRODUCTION) : il est joué par le job `integration` de la CI, sur un Postgres
 * jetable.
 *
 * Ce qu'il verrouille : le verrou optimiste (un job pg-boss rejoué ne doit pas jouer deux fois le même tour),
 * l'unicité d'une session vivante par parcours (index partiel en base, pas une convention), et l'isolation
 * par tenant (le pooler est superuser, la RLS est bypassée, le filtrage en code est le seul contrôle).
 */
describe.skipIf(!url)('PgAgentSessionStore (Postgres)', () => {
  let pool: Pool;
  let store: PgAgentSessionStore;
  let tenantId: string;
  let autreTenantId: string;
  let workflowId: string;
  let agentId: string;

  const nouveauRun = async (): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      `insert into workflow_runs (workflow_id, tenant_id, wa_id, status) values ($1, $2, '33600000000', 'waiting') returning id`,
      [workflowId, tenantId],
    );
    return r.rows[0]!.id;
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    store = new PgAgentSessionStore(pool);
    const t = await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-agent-sessions') returning id`);
    tenantId = t.rows[0]!.id;
    const t2 = await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-agent-sessions-autre') returning id`);
    autreTenantId = t2.rows[0]!.id;
    const w = await pool.query<{ id: string }>(
      `insert into workflows (tenant_id, name) values ($1, 'itest-agent') returning id`,
      [tenantId],
    );
    workflowId = w.rows[0]!.id;
    const a = await pool.query<{ id: string }>(
      `insert into agents (tenant_id, label, mention_ia, modele) values ($1, 'itest', 'Je suis une IA.', 'modele-test') returning id`,
      [tenantId],
    );
    agentId = a.rows[0]!.id;
  });

  afterAll(async () => {
    // Le cascade des tenants emporte workflows, runs, agents et sessions.
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    if (autreTenantId) await pool.query('delete from tenants where id = $1', [autreTenantId]);
    await pool.end();
  });

  it('open puis byRun rend la session, avec ses compteurs à zéro', async () => {
    const runId = await nouveauRun();
    const s = await store.open({ tenantId, runId, agentId, nodeId: 'n1', waId: '33600000000' });
    expect(s.tours).toBe(0);
    expect(s.appelsOutils).toBe(0);
    expect(s.coutMicroEur).toBe(0);
    expect(typeof s.coutMicroEur).toBe('number'); // et non un BigInt, que JSON.stringify refuserait
    expect(s.status).toBe('en_cours');

    const relu = await store.byRun(tenantId, runId);
    expect(relu?.id).toBe(s.id);
  });

  it('byRun avec un AUTRE tenant rend null (isolation)', async () => {
    const runId = await nouveauRun();
    await store.open({ tenantId, runId, agentId, nodeId: 'n1', waId: '33600000000' });
    expect(await store.byRun(autreTenantId, runId)).toBeNull();
  });

  it('🔴 prendreLeTour rend null au SECOND appel avec le même numéro de tour (rejeu neutralisé)', async () => {
    // pg-boss est at-least-once. Sans ce verrou, un job rejoué enverrait un second message WhatsApp et
    // rappellerait les outils.
    const runId = await nouveauRun();
    const s = await store.open({ tenantId, runId, agentId, nodeId: 'n1', waId: '33600000000' });

    const premier = await store.prendreLeTour(tenantId, s.id, 0);
    expect(premier?.tours).toBe(1);

    const rejeu = await store.prendreLeTour(tenantId, s.id, 0);
    expect(rejeu).toBeNull();

    // Le tour suivant, lui, passe : le verrou bloque le rejeu, pas la progression.
    const suivant = await store.prendreLeTour(tenantId, s.id, 1);
    expect(suivant?.tours).toBe(2);
  });

  it('🔴 prendreLeTour rend null avec un AUTRE tenant (isolation, le pooler est superuser)', async () => {
    const runId = await nouveauRun();
    const s = await store.open({ tenantId, runId, agentId, nodeId: 'n1', waId: '33600000000' });
    expect(await store.prendreLeTour(autreTenantId, s.id, 0)).toBeNull();
    // et le compteur n'a pas bougé
    expect((await store.byRun(tenantId, runId))?.tours).toBe(0);
  });

  it('prendreLeTour rend null sur une session CLOSE', async () => {
    const runId = await nouveauRun();
    const s = await store.open({ tenantId, runId, agentId, nodeId: 'n1', waId: '33600000000' });
    await store.clore(tenantId, s.id, 'sortie', 'sortie:fini');
    expect(await store.prendreLeTour(tenantId, s.id, 0)).toBeNull();
  });

  it('🔴 une seule session VIVANTE par parcours (index partiel en base)', async () => {
    const runId = await nouveauRun();
    await store.open({ tenantId, runId, agentId, nodeId: 'n1', waId: '33600000000' });
    await expect(store.open({ tenantId, runId, agentId, nodeId: 'n1', waId: '33600000000' })).rejects.toThrow();
  });

  it('clore libère le parcours : byRun ne la voit plus, et un nouvel open redevient possible', async () => {
    const runId = await nouveauRun();
    const s = await store.open({ tenantId, runId, agentId, nodeId: 'n1', waId: '33600000000' });
    await store.clore(tenantId, s.id, 'inactivite');
    expect(await store.byRun(tenantId, runId)).toBeNull();
    const seconde = await store.open({ tenantId, runId, agentId, nodeId: 'n1', waId: '33600000000' });
    expect(seconde.id).not.toBe(s.id);
  });

  it('clore n écrase pas la cause d une session DÉJÀ close (un rejeu ne transforme pas une sortie en erreur)', async () => {
    const runId = await nouveauRun();
    const s = await store.open({ tenantId, runId, agentId, nodeId: 'n1', waId: '33600000000' });
    await store.clore(tenantId, s.id, 'sortie', 'sortie:fini');
    await store.clore(tenantId, s.id, 'erreur');
    const r = await pool.query<{ status: string; sortie: string | null }>(
      'select status, sortie from agent_sessions where id = $1',
      [s.id],
    );
    expect(r.rows[0]?.status).toBe('sortie');
    expect(r.rows[0]?.sortie).toBe('sortie:fini');
  });

  it('ajouterAuTranscript empile, et n écrase pas l entrée précédente', async () => {
    const runId = await nouveauRun();
    const s = await store.open({ tenantId, runId, agentId, nodeId: 'n1', waId: '33600000000' });
    await store.ajouterAuTranscript(tenantId, s.id, { role: 'contact', texte: 'bonjour' });
    await store.ajouterAuTranscript(tenantId, s.id, { role: 'agent', texte: 'bonjour, en quoi puis-je aider ?' });
    const r = await pool.query<{ transcript: Array<{ role: string }> }>(
      'select transcript from agent_sessions where id = $1',
      [s.id],
    );
    expect(r.rows[0]?.transcript.map((e) => e.role)).toEqual(['contact', 'agent']);
  });

  it('ajouterAuTranscript avec un AUTRE tenant n écrit rien (isolation)', async () => {
    const runId = await nouveauRun();
    const s = await store.open({ tenantId, runId, agentId, nodeId: 'n1', waId: '33600000000' });
    await store.ajouterAuTranscript(autreTenantId, s.id, { role: 'contact', texte: 'injection' });
    const r = await pool.query<{ transcript: unknown[] }>('select transcript from agent_sessions where id = $1', [s.id]);
    expect(r.rows[0]?.transcript).toEqual([]);
  });
});
