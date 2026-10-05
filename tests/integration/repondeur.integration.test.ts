import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgTenantSettingsStore } from '../../src/settings/store.pg';
import { PgWorkflowStore } from '../../src/workflow/store.pg';
import { PgWorkflowRunStore } from '../../src/workflow/run-store.pg';
import { PgInboxStore } from '../../src/inbox/store.pg';
import { PgListeStore } from '../../src/mba/liste.pg';
import { PgAlertesCreditStore } from '../../src/repondeur/alerte-credit';

const url = process.env.DATABASE_URL ?? '';

/**
 * LE RÉPONDEUR EN BASE (lot 5, migration 0209) : ce que les tests unitaires ne peuvent qu'affirmer, la base le fait.
 *
 *  - 🔴 une seule voix : le CHECK refuse les DEUX ordres (répondeur posé sur un agent de Meta allumé, agent de Meta
 *    allumé sur un répondeur posé), et le seul écrivain de `mba_enabled` l'allume sans 500 ;
 *  - la clé étrangère remet le réglage à nul quand l'agent est supprimé ;
 *  - le scénario système : une ligne par espace même sous deux démarrages simultanés, invisible de toutes les lectures
 *    publiques, et sans gêner un scénario du client qui porterait le même nom ;
 *  - 🔴 l'alerte de crédit : une insertion par espace et par jour, quel que soit le nombre de copies (cas 5 de la revue) ;
 *  - la frise : `sortie_agent` s'écrit sous le CHECK élargi, avec sa cause, dans le bon espace ;
 *  - le parcours naît en ayant reçu son message déclencheur (`last_message_id`).
 *
 * Jamais joué en local (le DATABASE_URL local pointe la PRODUCTION), joué par le job `integration`, sur une base migrée.
 */
describe.skipIf(!url)('le répondeur par défaut (Postgres)', () => {
  let pool: Pool;
  let tenantId: string;
  let autreTenantId: string;
  let agentId: string;
  let autreAgentId: string;
  const reglages = () => new PgTenantSettingsStore(pool);
  const WA = '33600000777';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-repondeur') returning id`)).rows[0]!.id;
    autreTenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-repondeur-autre') returning id`)).rows[0]!.id;
    agentId = (await pool.query<{ id: string }>(
      `insert into agents (tenant_id, label, mention_ia, modele, status) values ($1, 'itest-repondeur', 'IA.', 'm', 'active') returning id`, [tenantId],
    )).rows[0]!.id;
    autreAgentId = (await pool.query<{ id: string }>(
      `insert into agents (tenant_id, label, mention_ia, modele, status) values ($1, 'itest-repondeur-2', 'IA.', 'm', 'active') returning id`, [tenantId],
    )).rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    if (autreTenantId) await pool.query('delete from tenants where id = $1', [autreTenantId]);
    await pool.end();
  });

  describe('une seule voix', () => {
    it('🔴 le CHECK refuse un répondeur posé sur un agent de Meta allumé', async () => {
      await reglages().setMbaEnabled(tenantId, true);
      await expect(reglages().setRepondeur(tenantId, agentId)).rejects.toMatchObject({ code: '23514', constraint: 'tenant_settings_repondeur_une_voix_chk' });
      expect((await reglages().get(tenantId)).repondeurAgentId).toBeNull();
    });

    it('🔴 et l’agent de Meta allumé sur un répondeur posé, par une écriture qui ne passerait pas par l’écrivain unique', async () => {
      await reglages().setMbaEnabled(tenantId, false);
      await reglages().setRepondeur(tenantId, agentId);
      await expect(pool.query('update tenant_settings set mba_enabled = true where tenant_id = $1', [tenantId]))
        .rejects.toMatchObject({ code: '23514' });
    });

    it('🔴 l’écrivain unique allume l’agent de Meta SANS 500 : le répondeur retombe à nul dans la même instruction', async () => {
      await reglages().setRepondeur(tenantId, agentId);
      await reglages().setMbaEnabled(tenantId, true);
      expect(await reglages().get(tenantId)).toMatchObject({ mbaEnabled: true, repondeurAgentId: null });
      // Éteindre ne touche pas au répondeur.
      await reglages().setMbaEnabled(tenantId, false);
      await reglages().setRepondeur(tenantId, agentId);
      await reglages().setMbaEnabled(tenantId, false);
      expect((await reglages().get(tenantId)).repondeurAgentId).toBe(agentId);
    });

    it('oublierRepondeurSi : seulement l’agent désigné, et la suppression de l’agent remet le réglage à nul', async () => {
      await reglages().setRepondeur(tenantId, agentId);
      expect(await reglages().oublierRepondeurSi(tenantId, autreAgentId)).toBe(false);
      expect((await reglages().get(tenantId)).repondeurAgentId).toBe(agentId);
      expect(await reglages().oublierRepondeurSi(tenantId, agentId)).toBe(true);
      expect((await reglages().get(tenantId)).repondeurAgentId).toBeNull();
      await reglages().setRepondeur(tenantId, autreAgentId);
      await pool.query('delete from agents where id = $1 and tenant_id = $2', [autreAgentId, tenantId]);
      expect((await reglages().get(tenantId)).repondeurAgentId, 'on delete set null').toBeNull();
    });
  });

  describe('le scénario système', () => {
    it('🔴 deux démarrages simultanés : UNE ligne, le même identifiant', async () => {
      const store = new PgWorkflowStore(pool);
      const [a, b] = await Promise.all([store.assurerScenarioSysteme(tenantId, 'repondeur'), store.assurerScenarioSysteme(tenantId, 'repondeur')]);
      expect(a).toBe(b);
      const n = await pool.query(`select count(*)::int as n from workflows where tenant_id = $1 and systeme = 'repondeur'`, [tenantId]);
      expect(n.rows[0]!.n).toBe(1);
      expect(await store.assurerScenarioSysteme(tenantId, 'repondeur')).toBe(a);
    });

    it('🔴 invisible de toutes les lectures publiques ; un scénario du client du même nom n’est pas gêné', async () => {
      const store = new PgWorkflowStore(pool);
      const sys = await store.assurerScenarioSysteme(tenantId, 'repondeur');
      await pool.query(`update workflows set graph = '{"nodes":[{"id":"a","type":"tag","position":{"x":0,"y":0},"data":{"tag":"x"}}],"edges":[]}'::jsonb, test_token = 'itest-jeton-sys' where id = $1`, [sys]);
      const client = (await store.insert(tenantId, 'Répondeur automatique', { nodes: [], edges: [] })).id;
      expect((await store.listResume(tenantId)).map((w) => w.id)).toEqual([client]);
      expect((await store.list(tenantId)).map((w) => w.id)).toEqual([client]);
      expect(await store.listPublies(tenantId)).toEqual([]);
      expect(await store.getById(sys, tenantId)).toBeNull();
      expect(await store.findByTestToken('itest-jeton-sys')).toBeNull();
      expect(await store.update(sys, tenantId, { name: 'pirate' })).toEqual({ trouve: false, brouillon: false });
      expect(await store.publish(sys, tenantId)).toBeNull();
      expect(await store.remove(sys, tenantId)).toBe(false);
      expect(await store.ensureTestToken(sys, tenantId, 'autre')).toBeNull();
      // La frise, elle, le nomme.
      expect(await store.designation(sys, tenantId)).toEqual({ nom: 'Répondeur automatique', systeme: 'repondeur' });
      expect(await store.designation(sys, autreTenantId)).toBeNull();
    });

    it('le parcours du répondeur naît en ayant reçu son message déclencheur, avec son graphe figé', async () => {
      const sys = await new PgWorkflowStore(pool).assurerScenarioSysteme(tenantId, 'repondeur');
      const runs = new PgWorkflowRunStore(pool);
      const graphe = { nodes: [{ id: 'agent', type: 'agent' as const, position: { x: 0, y: 0 }, data: { agentId } }], edges: [] };
      const { id } = await runs.start(tenantId, sys, WA, null, { currentNode: 'agent', status: 'waiting', lastMessageId: 'wamid.declencheur' }, graphe);
      expect(await runs.byId(tenantId, id)).toMatchObject({ lastMessageId: 'wamid.declencheur', grapheFige: graphe });
    });
  });

  it('🔴 l’alerte de crédit : une ligne par espace et par jour, quel que soit le nombre de copies (cas 5)', async () => {
    const alertes = new PgAlertesCreditStore(pool);
    const prises = await Promise.all([1, 2, 3].map(() => alertes.marquerLeJour(tenantId, '2026-10-05')));
    expect(prises.filter(Boolean)).toHaveLength(1);
    expect(await alertes.marquerLeJour(tenantId, '2026-10-06')).toBe(true);
    expect(await alertes.marquerLeJour(autreTenantId, '2026-10-05')).toBe(true);
    // Les admins ACTIFS de l'espace, et eux seuls.
    await pool.query(`insert into users (tenant_id, email, role, password_hash) values ($1, 'itest-rep-admin@example.test', 'admin', 'x'), ($1, 'itest-rep-agent@example.test', 'agent', 'x')`, [tenantId]);
    await pool.query(`insert into users (tenant_id, email, role, password_hash, disabled_at) values ($1, 'itest-rep-parti@example.test', 'admin', 'x', now())`, [tenantId]);
    expect(await alertes.admins(tenantId)).toEqual(['itest-rep-admin@example.test']);
    expect(await alertes.admins(autreTenantId)).toEqual([]);
  });

  it('🔴 la frise : `sortie_agent` passe le CHECK élargi, avec sa règle dans la cause, et dans son espace seulement', async () => {
    const conv = (await pool.query<{ id: string }>(`insert into conversations (tenant_id, wa_id, last_message_at) values ($1, $2, now()) returning id`, [tenantId, WA])).rows[0]!.id;
    await pool.query(`insert into conversations (tenant_id, wa_id, last_message_at) values ($1, $2, now())`, [autreTenantId, WA]);
    await new PgInboxStore(pool).noterSortieAgent(tenantId, WA, 'rdv_pris');
    const lignes = await pool.query<{ tenant_id: string; conversation_id: string; cause: string }>(
      `select tenant_id, conversation_id, cause from conversation_evenements where type = 'sortie_agent' and tenant_id = any($1::uuid[])`,
      [[tenantId, autreTenantId]],
    );
    expect(lignes.rows).toEqual([{ tenant_id: tenantId, conversation_id: conv, cause: 'automatique : règle d’arrêt rdv_pris' }]);
  });

  it('la liste de l’agent de Meta se lit par paquets, par clé, dans son espace', async () => {
    const liste = new PgListeStore(pool);
    for (const w of ['336001', '336002', '336003']) await liste.poser(tenantId, w, 'pn', `e-${w}`);
    await liste.poser(autreTenantId, '336000', 'pn', 'e-autre');
    expect(await liste.lister(tenantId, null, 2)).toEqual(['336001', '336002']);
    expect(await liste.lister(tenantId, '336002', 2)).toEqual(['336003']);
  });
});
