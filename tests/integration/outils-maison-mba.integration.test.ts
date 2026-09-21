import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgToolCatalog } from '../../src/agent/catalog.pg';
import { PgAgentStore } from '../../src/agent/agent-store.pg';
import { NomOutilDejaPris } from '../../src/agent/catalog';
import { consommateurMba, consommateurAgent } from '../../src/agent/consommateur';

/**
 * Les outils maison de l'agent de Meta, contre une vraie base (migration 0162, spec
 * docs/superpowers/specs/2026-09-21-outils-maison-mba-design.md).
 *
 * ⚠️ CI SEULEMENT : le DATABASE_URL local est la production.
 */
const url = process.env.DATABASE_URL ?? '';

describe.skipIf(!url)('0162 : les contraintes', () => {
  let pool: Pool;
  let tenantId = '';
  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    tenantId = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-outils-maison-mba') returning id`,
    )).rows[0]!.id;
  });
  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  const inserer = (name: string, pourAgentMeta: boolean, origin = 'mba') => pool.query(
    `insert into agent_tools (tenant_id, origin, name, title, description, ne_pas_utiliser, params, binding, risk, pour_agent_meta)
     values ($1, $2, $3, 'T', 'D', 'N', '[]'::jsonb, '{"handler":"tag_fixe","tag":"vip"}'::jsonb, 'write', $4)`,
    [tenantId, origin, name, pourAgentMeta],
  );

  it('🔴 un outil maison SANS agent et SANS le drapeau reste refusé (0159 tient toujours)', async () => {
    await expect(inserer('orphelin', false)).rejects.toMatchObject({ code: '23514', constraint: 'agent_tools_action_par_agent_chk' });
  });

  it('un outil maison de l’agent de Meta est accepté', async () => {
    await expect(inserer('pose_vip', true)).resolves.toBeTruthy();
  });

  it('🔴 le drapeau sur un connecteur est refusé', async () => {
    // Refusé par 0088 (un connecteur exige une source) ou par 0162 : les deux disent non, c'est ce qui compte.
    await expect(inserer('faux_connecteur', true, 'http')).rejects.toMatchObject({ code: '23514' });
  });
});

describe.skipIf(!url)('le magasin des outils de l’agent de Meta', () => {
  const PN = '1234840649713976';
  let pool: Pool;
  let cat: PgToolCatalog;
  let tenantId = '';
  let userId = '';
  let agentId = '';
  let sourceId = '';
  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    cat = new PgToolCatalog(pool);
    tenantId = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-magasin-maison-mba') returning id`,
    )).rows[0]!.id;
    userId = (await pool.query<{ id: string }>(
      `insert into users (tenant_id, email, role, password_hash) values ($1, 'itest-maison-mba@example.test', 'admin', 'x') returning id`,
      [tenantId],
    )).rows[0]!.id;
    agentId = (await pool.query<{ id: string }>(
      `insert into agents (tenant_id, label, mention_ia, modele) values ($1, 'itest-maison-mba', 'Je suis une IA.', 'm') returning id`,
      [tenantId],
    )).rows[0]!.id;
    sourceId = (await pool.query<{ id: string }>(
      `insert into agent_tool_sources (tenant_id, kind, label, base_url, auth_kind, status)
       values ($1, 'http', 'itest-src', 'https://exemple.test/api', 'none', 'active') returning id`,
      [tenantId],
    )).rows[0]!.id;
  });
  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  const nouvel = (name: string) => ({
    name, title: 'Marquer VIP', description: 'Appelle cet outil dès que le client le demande.', nePasUtiliser: 'Jamais sans demande.',
    cible: { handler: 'tag_fixe' as const, tag: 'vip' },
  });
  const duMba = async (name: string) =>
    (await cat.listToutesConsommateur(tenantId, consommateurMba(PN))).find((x) => x.name === name);

  it('🔴 crée l’outil ET l’expose, actif, au nom de l’administrateur', async () => {
    const o = await cat.ajouterMaisonPourMba(tenantId, PN, nouvel('marquer_vip'), userId);
    expect(o).toMatchObject({ origin: 'mba', name: 'marquer_vip', actif: true, binding: { handler: 'tag_fixe', tag: 'vip' } });
    expect(await duMba('marquer_vip')).toBeDefined();
  });

  it('🔴 il N’APPARAÎT PAS dans la bibliothèque proposée aux agents IA', async () => {
    expect((await cat.listCatalogue(tenantId)).map((x) => x.name)).not.toContain('marquer_vip');
  });

  it('🔴 il ne se rattache PAS à un agent IA', async () => {
    const o = await duMba('marquer_vip');
    expect(await cat.rattacherConsommateur(tenantId, consommateurAgent(agentId), o!.id)).toBe(false);
  });

  it('modifie la cible et les mots, sans toucher au consentement', async () => {
    const o = await duMba('marquer_vip');
    const p = await cat.patchMaisonPourMba(tenantId, PN, o!.id, { title: 'Client VIP', cible: { handler: 'tag_fixe', tag: 'client_vip' } });
    expect(p).toMatchObject({ title: 'Client VIP', binding: { tag: 'client_vip' }, actif: true });
  });

  it('🔴 un nom déjà pris par un connecteur de l’espace est refusé', async () => {
    await pool.query(
      `insert into agent_tools (tenant_id, origin, source_id, source_kind, name, title, description, ne_pas_utiliser, params, binding, risk)
       values ($1, 'http', $2, 'http', 'add_tag', 'x', 'x', 'x', '[]'::jsonb, '{}'::jsonb, 'write')`,
      [tenantId, sourceId],
    );
    await expect(cat.ajouterMaisonPourMba(tenantId, PN, nouvel('add_tag'), userId)).rejects.toBeInstanceOf(NomOutilDejaPris);
  });

  it('🔴 retirer un outil maison le SUPPRIME ; retirer un connecteur partagé ne fait que le DÉTACHER', async () => {
    const maison = await duMba('marquer_vip');
    expect(await cat.retirerDeMba(tenantId, PN, maison!.id)).toBe('supprime');
    expect((await pool.query('select 1 from agent_tools where id = $1', [maison!.id])).rowCount).toBe(0);
    const connecteur = (await pool.query<{ id: string }>(
      `select id from agent_tools where tenant_id = $1 and name = 'add_tag'`, [tenantId],
    )).rows[0]!.id;
    expect(await cat.rattacherConsommateur(tenantId, consommateurMba(PN), connecteur)).toBe(true);
    expect(await cat.rattacherConsommateur(tenantId, consommateurAgent(agentId), connecteur)).toBe(true);
    expect(await cat.retirerDeMba(tenantId, PN, connecteur)).toBe('detache');
    expect((await pool.query('select 1 from agent_tools where id = $1', [connecteur])).rowCount).toBe(1);
    expect(await cat.retirerDeMba(tenantId, PN, connecteur)).toBe('introuvable');
  });

  const connecteurNeuf = async (name: string): Promise<string> => (await pool.query<{ id: string }>(
    `insert into agent_tools (tenant_id, origin, source_id, source_kind, name, title, description, ne_pas_utiliser, params, binding, risk)
     values ($1, 'http', $2, 'http', $3, 'x', 'x', 'x', '[]'::jsonb, '{}'::jsonb, 'write') returning id`,
    [tenantId, sourceId, name],
  )).rows[0]!.id;

  it('🔴 un connecteur dont l’agent de Meta était le SEUL utilisateur part avec lui (décision du 2026-09-21)', async () => {
    const id = await connecteurNeuf('seul_mba');
    expect(await cat.rattacherConsommateur(tenantId, consommateurMba(PN), id)).toBe(true);
    expect(await cat.retirerDeMba(tenantId, PN, id)).toBe('supprime');
    expect((await pool.query('select 1 from agent_tools where id = $1', [id])).rowCount).toBe(0);
  });

  it('🔴 un outil MCP RESTE quand l’agent de Meta le retire : il doit rester branchable', async () => {
    const sourceMcp = (await pool.query<{ id: string }>(
      `insert into agent_tool_sources (tenant_id, kind, label, base_url, auth_kind, status)
       values ($1, 'mcp', 'itest-src-mcp-mba', 'https://exemple.test/mcp', 'none', 'active') returning id`,
      [tenantId],
    )).rows[0]!.id;
    const id = (await pool.query<{ id: string }>(
      `insert into agent_tools (tenant_id, origin, source_id, source_kind, name, title, description, ne_pas_utiliser, risk)
       values ($1, 'mcp', $2, 'mcp', 'mcp_mba_reste', 'MCP', 'm', '', 'read') returning id`,
      [tenantId, sourceMcp],
    )).rows[0]!.id;
    await pool.query(
      'insert into agent_tool_consommateurs (tenant_id, tool_id, consommateur) values ($1, $2, $3)',
      [tenantId, id, consommateurMba(PN)],
    );
    expect(await cat.retirerDeMba(tenantId, PN, id)).toBe('detache');
    expect((await pool.query('select 1 from agent_tools where id = $1', [id])).rowCount).toBe(1);
  });

  /**
   * 🔴 LE VERROU DE LA DÉFINITION (`verrouillerDefinitions`, revue finale du 2026-09-21). Un rattachement NON
   * VALIDÉ est invisible du `not exists` qui décide de l'effacement : sans verrou, le dernier détachement
   * effaçait la définition, et la cascade emportait le consentement qu'on venait de poser. Avec lui,
   * l'effacement ATTEND le rattachement, puis le voit.
   *
   * ⚠️ ON ATTEND LE BLOCAGE, PAS UN DÉLAI. Une attente fixe ne peut échouer que dans le mauvais sens : sur une
   * CI lente, l'effacement n'aurait pas encore atteint la définition quand le rattachement valide, le verrou
   * n'aurait rien eu à faire, et le test passerait même sans lui. `pg_stat_activity` dit quand une connexion
   * attend VRAIMENT un verrou sur cette table (avec ou sans le correctif, l'effacement finit par y attendre :
   * c'est ce qui se passe APRÈS qui les distingue).
   */
  const attendreUnVerrou = async (): Promise<void> => {
    for (let i = 0; i < 200; i += 1) {
      const r = await pool.query(
        `select 1 from pg_stat_activity
          where wait_event_type = 'Lock' and datname = current_database() and pid <> pg_backend_pid()
            and query ilike '%agent_tool%'`,
      );
      if ((r.rowCount ?? 0) > 0) return;
      await new Promise((ok) => setTimeout(ok, 25));
    }
    throw new Error('aucune connexion ne s’est bloquée sur un verrou : le test ne prouverait rien');
  };

  /** Un consentement posé dans une transaction laissée OUVERTE, le temps de lancer l'effacement concurrent. */
  const rattachementEnCours = async (id: string, consommateur: string, effacement: () => Promise<unknown>) => {
    const autre = await pool.connect();
    try {
      await autre.query('begin');
      await autre.query(
        'insert into agent_tool_consommateurs (tenant_id, tool_id, consommateur) values ($1, $2, $3)',
        [tenantId, id, consommateur],
      );
      const enCours = effacement();
      await attendreUnVerrou();
      await autre.query('commit');
      return await enCours;
    } finally {
      autre.release();
    }
  };
  const consommateursDe = async (id: string) =>
    (await pool.query<{ consommateur: string }>(
      'select consommateur from agent_tool_consommateurs where tool_id = $1 order by consommateur', [id],
    )).rows.map((r) => r.consommateur);
  const existe = async (id: string) =>
    ((await pool.query('select 1 from agent_tools where id = $1', [id])).rowCount ?? 0) > 0;

  it('🔴 un rattachement EN COURS n’est pas emporté par le dernier détachement (`detacher`)', async () => {
    const id = await connecteurNeuf('course_detacher');
    expect(await cat.rattacherConsommateur(tenantId, consommateurAgent(agentId), id)).toBe(true);
    expect(await rattachementEnCours(id, consommateurMba(PN), () => cat.detacher(tenantId, agentId, id))).toBe(true);
    expect(await existe(id)).toBe(true);
    expect(await consommateursDe(id)).toEqual([consommateurMba(PN)]);
  });

  it('🔴 … ni par le retrait de l’agent de Meta (`retirerDeMba`)', async () => {
    const id = await connecteurNeuf('course_retirer_mba');
    expect(await cat.rattacherConsommateur(tenantId, consommateurMba(PN), id)).toBe(true);
    expect(await rattachementEnCours(id, consommateurAgent(agentId), () => cat.retirerDeMba(tenantId, PN, id)))
      .toBe('detache');
    expect(await existe(id)).toBe(true);
    expect(await consommateursDe(id)).toEqual([consommateurAgent(agentId)]);
  });

  it('🔴 … ni par la suppression de son dernier agent (`PgAgentStore.remove`)', async () => {
    const partant = (await pool.query<{ id: string }>(
      `insert into agents (tenant_id, label, mention_ia, modele) values ($1, 'itest-partant', 'IA', 'm') returning id`,
      [tenantId],
    )).rows[0]!.id;
    const id = await connecteurNeuf('course_remove');
    expect(await cat.rattacherConsommateur(tenantId, consommateurAgent(partant), id)).toBe(true);
    const agents = new PgAgentStore(pool);
    expect(await rattachementEnCours(id, consommateurMba(PN), () => agents.remove(tenantId, partant))).toBe(true);
    expect(await existe(id)).toBe(true);
    expect(await consommateursDe(id)).toEqual([consommateurMba(PN)]);
  });

  /**
   * 🔴 LE CAS INVERSE : l'effacement tient déjà la définition quand le rattachement arrive. `for key share`
   * (`rattacherConsommateur`) le fait ATTENDRE, puis ne rien trouver : `false`, donc un 404 lisible. Sans lui,
   * l'insertion passait sa lecture, butait ensuite sur la clé étrangère de la définition effacée, et levait
   * 23503, donc un 500.
   */
  it('🔴 un rattachement qui arrive PENDANT un effacement rend `false`, jamais une erreur', async () => {
    const id = await connecteurNeuf('course_inverse');
    const effaceur = await pool.connect();
    try {
      await effaceur.query('begin');
      await effaceur.query('select 1 from agent_tools where tenant_id = $1 and id = $2 for update', [tenantId, id]);
      const rattachement = cat.rattacherConsommateur(tenantId, consommateurMba(PN), id);
      await attendreUnVerrou();
      await effaceur.query('delete from agent_tools where tenant_id = $1 and id = $2', [tenantId, id]);
      await effaceur.query('commit');
      expect(await rattachement).toBe(false);
    } finally {
      effaceur.release();
    }
    expect(await existe(id)).toBe(false);
  });
});
