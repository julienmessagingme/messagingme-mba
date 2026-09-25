import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgWorkflowNodeEventStore } from '../../src/workflow/node-events.pg';
import { PgWorkflowRunStore } from '../../src/workflow/run-store.pg';
import { PgTrackedLinkStore } from '../../src/links/tracked-links.pg';
import { PgAuditStore } from '../../src/audit/store.pg';

const url = process.env.DATABASE_URL ?? '';

/**
 * RÉTENTION des quatre dernières tables non bornées (programme II, lot 4).
 *
 * 🔴 POURQUOI EN INTÉGRATION. Ce qui doit être prouvé est dans le SQL : QUELLES lignes partent, et surtout
 * lesquelles ne partent JAMAIS. Un faux store rendrait ce qu'on lui fait rendre, alors que les deux garanties
 * qui comptent ici sont des garanties de NON-effacement : un parcours vivant n'est jamais supprimé, et un lien
 * tracé n'est jamais emporté par la purge de ses clics. La seconde est irréparable si elle tombe.
 *
 * Jamais joué en local (le DATABASE_URL local pointe la PRODUCTION), joué par le job `integration`.
 */
describe.skipIf(!url)('rétention générale (Postgres)', () => {
  let pool: Pool;
  let tenantId = '';
  let workflowId = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    tenantId = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-retention-generale') returning id`,
    )).rows[0]!.id;
    workflowId = (await pool.query<{ id: string }>(
      `insert into workflows (tenant_id, name) values ($1, 'itest-wf') returning id`, [tenantId],
    )).rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  it('🔴 un parcours VIVANT n’est jamais effacé, même vieux d’un an ; un parcours TERMINÉ l’est', async () => {
    const store = new PgWorkflowRunStore(pool);
    const run = async (status: string, ageJours: number): Promise<string> => (await pool.query<{ id: string }>(
      `insert into workflow_runs (workflow_id, tenant_id, wa_id, status, updated_at)
       values ($1, $2, $3, $4, now() - make_interval(days => $5)) returning id`,
      [workflowId, tenantId, '3360000090' + ageJours, status, ageJours],
    )).rows[0]!.id;

    const vieuxEnAttente = await run('waiting', 400);
    const vieuxTermine = await run('done', 400);
    const vieuxRendu = await run('inbox', 400);
    const recentTermine = await run('done', 10);

    expect(await store.purgeTerminesOlderThan(90)).toBe(2);
    const restants = (await pool.query<{ id: string }>(
      `select id from workflow_runs where tenant_id = $1`, [tenantId],
    )).rows.map((r) => r.id);
    // Le parcours en attente a survécu : c'est un contact qui attend une réponse, pas une trace morte.
    expect(restants).toContain(vieuxEnAttente);
    expect(restants).toContain(recentTermine);
    expect(restants).not.toContain(vieuxTermine);
    expect(restants).not.toContain(vieuxRendu);
  });

  it('🔴 purger les CLICS ne touche JAMAIS les liens (porte à sens unique)', async () => {
    const store = new PgTrackedLinkStore(pool);
    await pool.query(
      `insert into tracked_links (code, tenant_id, template_name, template_language, button_index, destination, confirmed_at)
       values ('itestret1', $1, 'promo', 'fr', 0, 'https://exemple.test/offre', now())`,
      [tenantId],
    );
    for (const age of [800, 800, 10]) {
      await pool.query(
        `insert into tracked_link_clicks (code, tenant_id, at) values ('itestret1', $1, now() - make_interval(days => $2))`,
        [tenantId, age],
      );
    }

    expect(await store.purgeClicsOlderThan(730)).toBe(2);
    // Le lien est INTACT. S'il partait, l'adresse `/r/itestret1` deviendrait morte dans des messages déjà
    // livrés, chez des contacts qui les ont encore sous les yeux, et rien ne le rattraperait.
    const lien = await pool.query(`select code from tracked_links where code = 'itestret1'`);
    expect(lien.rowCount).toBe(1);
    const clics = await pool.query(`select id from tracked_link_clicks where code = 'itestret1'`);
    expect(clics.rowCount).toBe(1); // le clic récent est resté
  });

  it('🔴 les événements de blocs sont ANONYMISÉS, pas supprimés : les compteurs restent justes', async () => {
    const store = new PgWorkflowNodeEventStore(pool);
    const ev = async (ageJours: number): Promise<void> => {
      await pool.query(
        `insert into workflow_node_events (tenant_id, workflow_id, node_id, wa_id, kind, at)
         values ($1, $2, 'n1', '33600000091', 'sent', now() - make_interval(days => $3))`,
        [tenantId, workflowId, ageJours],
      );
    };
    await ev(400);
    await ev(400);
    await ev(10);

    expect(await store.anonymiserAnciens(365)).toBe(2);
    const lignes = await pool.query<{ wa_id: string }>(
      `select wa_id from workflow_node_events where tenant_id = $1 order by wa_id`, [tenantId],
    );
    // TROIS lignes, toujours : c'est la mesure du client, et il n'existe aucune statistique rétroactive.
    expect(lignes.rowCount).toBe(3);
    expect(lignes.rows.filter((r) => r.wa_id === 'anonyme')).toHaveLength(2);
    expect(lignes.rows.filter((r) => r.wa_id === '33600000091')).toHaveLength(1);
    // Idempotent : une seconde passe ne retouche pas ce qui est déjà anonyme.
    expect(await store.anonymiserAnciens(365)).toBe(0);
  });

  it('le journal d’audit se purge par date', async () => {
    const store = new PgAuditStore(pool);
    for (const age of [900, 10]) {
      await pool.query(
        `insert into audit_log (tenant_id, action, target_kind, target_id, at)
         values ($1, 'contact.created', 'contact', 'x', now() - make_interval(days => $2))`,
        [tenantId, age],
      );
    }
    expect(await store.purgeOlderThan(730)).toBe(1);
    expect((await pool.query(`select id from audit_log where tenant_id = $1`, [tenantId])).rowCount).toBe(1);
  });

  it('🔴 une rétention à ZÉRO ne purge RIEN (et surtout pas tout)', async () => {
    // Le piège que ce test ferme : `make_interval(days => 0)` vaut « maintenant », donc `at < now()` est vrai
    // pour TOUTE ligne. Sans le `if (days <= 0) return 0`, régler une rétention à 0 en croyant la désactiver
    // viderait la table entière, immédiatement et sans retour.
    const runs = new PgWorkflowRunStore(pool);
    const clics = new PgTrackedLinkStore(pool);
    const audit = new PgAuditStore(pool);
    const blocs = new PgWorkflowNodeEventStore(pool);
    expect(await runs.purgeTerminesOlderThan(0)).toBe(0);
    expect(await clics.purgeClicsOlderThan(0)).toBe(0);
    expect(await audit.purgeOlderThan(0)).toBe(0);
    expect(await blocs.anonymiserAnciens(0)).toBe(0);
    // Rien n'a bougé : les lignes récentes des tests précédents sont toujours là.
    expect((await pool.query(`select id from audit_log where tenant_id = $1`, [tenantId])).rowCount).toBe(1);
    expect((await pool.query(`select id from workflow_node_events where tenant_id = $1`, [tenantId])).rowCount).toBe(3);
  });
});
