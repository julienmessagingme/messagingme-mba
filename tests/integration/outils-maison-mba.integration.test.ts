import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgToolCatalog } from '../../src/agent/catalog.pg';
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
});
