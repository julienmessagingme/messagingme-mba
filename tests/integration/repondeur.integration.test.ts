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
import { PgContactStore } from '../../src/crm/contact-store.pg';
import { PgAdressesEvenementsStore } from '../../src/evenements/store.pg';

const url = process.env.DATABASE_URL ?? '';

/**
 * LE RÉPONDEUR EN BASE (lot 5, migration 0209 ; RC6, migration 0217) : ce que les tests unitaires ne peuvent
 * qu'affirmer, la base le fait.
 *
 *  - 🔴 qui répond au client (0217) : la contrainte d'une seule voix est partie, les CHECK à sens unique refusent une
 *    cible hors de son mode SANS empêcher la suppression d'un agent ou d'un scénario (la cible tombe à nul, le mode se
 *    lit « Équipe »), la règle de mode de `setMbaEnabled`, et la réclamation atomique du scénario répondeur ;
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
  /** Des numéros à part pour les cas de RC6 : les cas qui suivent créent leur propre conversation sur `WA`. */
  const WA_SCENARIO = '33600000778';
  const WA_FRISE = '33600000779';

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

  describe('qui répond au client (RC6, migration 0217)', () => {
    it('🔴 la fin d’une seule voix : un agent IA répondeur et l’agent de Meta allumé coexistent, l’agent en veille', async () => {
      await reglages().setMbaEnabled(tenantId, false);
      await reglages().setRepondeur(tenantId, { mode: 'agent', agentId });
      // L'ancienne contrainte aurait levé ici : elle est partie.
      await reglages().setMbaEnabled(tenantId, true);
      expect(await reglages().get(tenantId)).toMatchObject({ mbaEnabled: true, repondeurMode: 'agent', repondeurAgentId: agentId });
      const contrainte = await pool.query(`select 1 from pg_constraint where conname = 'tenant_settings_repondeur_une_voix_chk'`);
      expect(contrainte.rowCount).toBe(0);
    });

    it('🔴 la règle de l’écrivain unique de `mba_enabled` : allumer quand personne ne répond passe en `mba`, éteindre en `mba` passe en `equipe`', async () => {
      await reglages().setMbaEnabled(tenantId, false);
      await reglages().setRepondeur(tenantId, { mode: 'equipe' });
      await reglages().setMbaEnabled(tenantId, true);
      expect((await reglages().get(tenantId)).repondeurMode).toBe('mba');
      await reglages().setMbaEnabled(tenantId, false);
      expect((await reglages().get(tenantId)).repondeurMode).toBe('equipe');
      // Un espace sans ligne naît dans le mode que son drapeau dit.
      await reglages().setMbaEnabled(autreTenantId, true);
      expect(await reglages().get(autreTenantId)).toMatchObject({ mbaEnabled: true, repondeurMode: 'mba' });
      await pool.query('delete from tenant_settings where tenant_id = $1', [autreTenantId]);
    });

    it('🔴 les CHECK À SENS UNIQUE : une cible n’existe que dans son mode, sous leur nom', async () => {
      await reglages().setRepondeur(tenantId, { mode: 'equipe' });
      await expect(pool.query(`update tenant_settings set repondeur_agent_id = $2 where tenant_id = $1`, [tenantId, agentId]))
        .rejects.toMatchObject({ code: '23514', constraint: 'tenant_settings_repondeur_agent_chk' });
      const wf = (await new PgWorkflowStore(pool).insert(tenantId, 'itest-repondeur-chk', { nodes: [], edges: [] })).id;
      await reglages().setRepondeur(tenantId, { mode: 'agent', agentId });
      await expect(pool.query(`update tenant_settings set repondeur_workflow_id = $2 where tenant_id = $1`, [tenantId, wf]))
        .rejects.toMatchObject({ code: '23514', constraint: 'tenant_settings_repondeur_scenario_chk' });
      // Sans agent ni scénario, sinon un mode inconnu viole AUSSI le CHECK de l'agent, que Postgres signale en premier.
      await reglages().setRepondeur(tenantId, { mode: 'equipe' });
      // Le scénario de ce test ne doit pas survivre : le test du scénario système liste les scénarios de l'espace.
      await pool.query('delete from workflows where id = $1 and tenant_id = $2', [wf, tenantId]);
      await expect(pool.query(`update tenant_settings set repondeur_mode = 'robot' where tenant_id = $1`, [tenantId]))
        .rejects.toMatchObject({ code: '23514', constraint: 'tenant_settings_repondeur_mode_chk' });
      for (const s of [3599, 2_592_001]) {
        await expect(pool.query(`update tenant_settings set repondeur_delai_scenario_s = $2 where tenant_id = $1`, [tenantId, s]))
          .rejects.toMatchObject({ code: '23514', constraint: 'tenant_settings_repondeur_delai_chk' });
      }
    });

    it('🔴 supprimer l’agent ou le scénario répondeur NE lève PAS : la cible tombe à nul, le mode reste, et se lit « Équipe »', async () => {
      await reglages().setRepondeur(tenantId, { mode: 'agent', agentId: autreAgentId });
      await pool.query('delete from agents where id = $1 and tenant_id = $2', [autreAgentId, tenantId]);
      expect(await reglages().get(tenantId)).toMatchObject({ repondeurMode: 'agent', repondeurAgentId: null });
      const wf = (await new PgWorkflowStore(pool).insert(tenantId, 'itest-repondeur-sc', { nodes: [], edges: [] })).id;
      await reglages().setRepondeur(tenantId, { mode: 'scenario', workflowId: wf, delaiS: 7200 });
      expect(await reglages().get(tenantId)).toMatchObject({ repondeurMode: 'scenario', repondeurWorkflowId: wf, repondeurDelaiScenarioS: 7200 });
      await pool.query('delete from workflows where id = $1 and tenant_id = $2', [wf, tenantId]);
      expect(await reglages().get(tenantId)).toMatchObject({ repondeurMode: 'scenario', repondeurWorkflowId: null });
      expect((await reglages().modesParTenant([tenantId])).get(tenantId)).toBe('equipe');
    });

    it('🔴 le mode « application » (0224) : l’adresse s’écrit et se lit ; CHECK à sens unique ; supprimer l’adresse NE lève PAS, le mode se lit « Équipe »', async () => {
      const adresses = new PgAdressesEvenementsStore(pool);
      const a = await adresses.creer(tenantId, { url: 'https://app.client.fr/repond', description: '', types: ['message.received'], secretChiffre: 'c' });
      await reglages().setRepondeur(tenantId, { mode: 'equipe' });
      await expect(pool.query(`update tenant_settings set repondeur_adresse_id = $2 where tenant_id = $1`, [tenantId, a.id]))
        .rejects.toMatchObject({ code: '23514', constraint: 'tenant_settings_repondeur_adresse_chk' });
      await reglages().setRepondeur(tenantId, { mode: 'application', adresseId: a.id });
      expect(await reglages().get(tenantId)).toMatchObject({ repondeurMode: 'application', repondeurAdresseId: a.id, repondeurAgentId: null, repondeurWorkflowId: null });
      expect((await reglages().modesParTenant([tenantId])).get(tenantId)).toBe('application');
      // Allumer l'agent de Meta en mode application le laisse en veille : le mode ne bouge pas.
      await reglages().setMbaEnabled(tenantId, true);
      expect((await reglages().get(tenantId)).repondeurMode).toBe('application');
      await reglages().setMbaEnabled(tenantId, false);
      // Une clé étrangère en `set null` : la suppression passe, la cible tombe, le mode reste et se lit « Équipe ».
      expect(await adresses.supprimer(tenantId, a.id)).toBe(true);
      expect(await reglages().get(tenantId)).toMatchObject({ repondeurMode: 'application', repondeurAdresseId: null });
      expect((await reglages().modesParTenant([tenantId])).get(tenantId)).toBe('equipe');
      await reglages().setRepondeur(tenantId, { mode: 'equipe' });
    });

    it('oublierRepondeurSi : seulement l’agent désigné ; le mode reste `agent`, sans agent', async () => {
      await reglages().setRepondeur(tenantId, { mode: 'agent', agentId });
      expect(await reglages().oublierRepondeurSi(tenantId, '00000000-0000-4000-8000-000000000000')).toBe(false);
      expect((await reglages().get(tenantId)).repondeurAgentId).toBe(agentId);
      expect(await reglages().oublierRepondeurSi(tenantId, agentId)).toBe(true);
      expect(await reglages().get(tenantId)).toMatchObject({ repondeurMode: 'agent', repondeurAgentId: null });
    });

    it('modesParTenant : le mode qui s’APPLIQUE, en une lecture ; un espace sans ligne est absent', async () => {
      // En Entreprise : un espace neuf est en Base, où l'agent de Meta est gelé (lot 6, B2a, cas suivant).
      await pool.query('update tenants set offre_entreprise = true where id = $1', [tenantId]);
      try {
        await reglages().setMbaEnabled(tenantId, true);
        await reglages().setRepondeur(tenantId, { mode: 'mba' });
        const modes = await reglages().modesParTenant([tenantId, autreTenantId]);
        expect(modes.get(tenantId)).toBe('mba');
        expect(modes.has(autreTenantId)).toBe(false);
        await reglages().setMbaEnabled(tenantId, false);
        expect((await reglages().modesParTenant([tenantId])).get(tenantId)).toBe('equipe');
      } finally {
        await pool.query('update tenants set offre_entreprise = false where id = $1', [tenantId]);
      }
    });

    it('🔴 modesParTenant sous l’offre (lot 6, B2a) : en Base, « MBA » allumé et « Scénario » se lisent « Équipe »', async () => {
      await reglages().setMbaEnabled(tenantId, true);
      await reglages().setRepondeur(tenantId, { mode: 'mba' });
      expect((await reglages().modesParTenant([tenantId])).get(tenantId)).toBe('equipe');
      const wf = (await new PgWorkflowStore(pool).insert(tenantId, 'itest-repondeur-gel', { nodes: [], edges: [] })).id;
      await reglages().setRepondeur(tenantId, { mode: 'scenario', workflowId: wf, delaiS: 7200 });
      expect((await reglages().modesParTenant([tenantId])).get(tenantId)).toBe('equipe');
      await pool.query('delete from workflows where id = $1 and tenant_id = $2', [wf, tenantId]);
      await reglages().setMbaEnabled(tenantId, false);
    });

    it('🔴 la réclamation du scénario répondeur : deux entrants SIMULTANÉS, UN départ ; le délai écoulé, un nouveau', async () => {
      const contacts = new PgContactStore(pool);
      await pool.query(`insert into contacts (tenant_id, phone_e164) values ($1, $2)`, [tenantId, `+${WA_SCENARIO}`]);
      const [a, b] = await Promise.all([
        contacts.reclamerDepartRepondeur(tenantId, WA_SCENARIO, 3600),
        contacts.reclamerDepartRepondeur(tenantId, WA_SCENARIO, 3600),
      ]);
      expect([a, b].filter(Boolean)).toHaveLength(1);
      expect(await contacts.reclamerDepartRepondeur(tenantId, WA_SCENARIO, 3600), 'dans le délai').toBe(false);
      // Le lendemain : le dernier départ date de plus que le délai.
      await pool.query(`update contacts set repondeur_scenario_le = now() - interval '2 hours' where tenant_id = $1`, [tenantId]);
      expect(await contacts.reclamerDepartRepondeur(tenantId, WA_SCENARIO, 3600)).toBe(true);
      // Scopée espace : le même numéro dans un autre espace n'existe pas ici.
      expect(await contacts.reclamerDepartRepondeur(autreTenantId, WA_SCENARIO, 3600)).toBe(false);
    });

    it('la frise : `mba_indisponible` s’écrit sous le CHECK élargi, avec sa cause, dans le bon espace', async () => {
      const inbox = new PgInboxStore(pool);
      await pool.query(`insert into conversations (tenant_id, wa_id) values ($1, $2)`, [tenantId, WA_FRISE]);
      await inbox.noterMbaIndisponible(tenantId, WA_FRISE, 'automatique : bloc « Envoyer au MBA », scénario Bienvenue');
      await inbox.noterMbaIndisponible(autreTenantId, WA_FRISE, 'ne doit rien écrire');
      const ev = await pool.query<{ cause: string }>(
        `select e.cause from conversation_evenements e join conversations c on c.id = e.conversation_id
          where c.tenant_id = $1 and c.wa_id = $2 and e.type = 'mba_indisponible'`, [tenantId, WA_FRISE],
      );
      expect(ev.rows.map((r) => r.cause)).toEqual(['automatique : bloc « Envoyer au MBA », scénario Bienvenue']);
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
