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
       values ($1, 'itest', 'Je suis une IA.', 'anthropic/claude-haiku-4.5', 5, 7, 12345, 42) returning id`,
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

  it('🔴 create pose un BROUILLON, jamais un agent actif', async () => {
    // Un agent créé actif serait proposable dans un scénario avant que quiconque ait relu ce qu'il dira.
    // C'est le défaut de la COLONNE qui le garantit, donc seule la base peut le prouver.
    const neuf = await agents.create(tenantId, 'itest-neuf', 'Je suis une IA.', 'modele-x');
    expect(neuf.status).toBe('draft');
    expect(neuf.contenu).toEqual({ nom: '', objectif: '', ton: '', personnalite: '', reglesTransfert: '', sorties: [] });
    // Et il n'apparaît PAS dans la liste que lit le builder.
    expect((await agents.listActifs(tenantId)).map((a) => a.label)).not.toContain('itest-neuf');
    expect((await agents.listToutes(tenantId)).map((a) => a.label)).toContain('itest-neuf');
  });

  it('🔴 le résumé porte le MODÈLE : la liste en fait un logo', async () => {
    // Sans lui, la liste des agents devrait lire chaque fiche une par une pour afficher un logo, soit une
    // requête par ligne, sur un écran qui en affiche potentiellement des dizaines.
    const resumes = await agents.listToutes(tenantId);
    const cree = resumes.find((r) => r.id === agentId);
    expect(cree?.modele).toBe('anthropic/claude-haiku-4.5');
  });

  it('🔴 un patch PARTIEL n efface pas ce qu il ne mentionne pas', async () => {
    // L'écran enregistre champ par champ : sans le `coalesce` de chaque colonne, régler le budget effacerait
    // la mention légale d'IA, et personne ne s'en apercevrait avant le premier message.
    const a = await agents.create(tenantId, 'itest-patch', 'Mention d origine.', 'modele-x');
    await agents.patch(tenantId, a.id, { budgetMicroEur: 12_345 });
    const apres = await agents.complet(tenantId, a.id);
    expect(apres?.budgetMicroEur).toBe(12_345);
    expect(apres?.mentionIa).toBe('Mention d origine.');
    expect(apres?.maxTours).toBe(8); // le défaut de la colonne, intact
  });

  it('la fiche jsonb s écrit et se relit, et sa version avance à chaque écriture de fiche', async () => {
    const a = await agents.create(tenantId, 'itest-fiche', 'x', 'modele-x');
    const contenu = { nom: 'Léa', objectif: 'Renseigner', ton: 'vouvoiement', personnalite: '', reglesTransfert: '', sorties: [{ code: 'rdv', label: 'Rendez-vous' }] };
    await agents.patch(tenantId, a.id, { contenu });
    expect((await agents.complet(tenantId, a.id))?.contenu).toEqual(contenu);

    // La version AVANCE à chaque écriture de fiche : c'est elle que le verrou optimiste compare.
    expect((await agents.complet(tenantId, a.id))?.ficheVersion).toBe(2); // défaut 1, plus une écriture

    // Un patch SANS fiche ne la fait PAS avancer : elle compte les écritures de fiche, pas les
    // enregistrements de plafonds.
    await agents.patch(tenantId, a.id, { maxTours: 9 });
    expect((await agents.complet(tenantId, a.id))?.ficheVersion).toBe(2);
  });

  it('🔴 le patch de fiche FUSIONNE : enregistrer un champ n efface pas les autres', async () => {
    // Le défaut le plus grave du premier jet. Deux onglets ouverts sur la même fiche, ou la surface
    // conversationnelle à venir : un remplacement total ferait qu'enregistrer l'objectif efface les règles
    // d'arrêt qu'un autre onglet vient d'ajouter, sans la moindre erreur.
    const a = await agents.create(tenantId, 'itest-fusion', 'x', 'modele-x');
    await agents.patch(tenantId, a.id, { contenu: { sorties: [{ code: 'rdv', label: 'Rendez-vous' }] } });
    await agents.patch(tenantId, a.id, { contenu: { objectif: 'Renseigner' } });
    const lu = await agents.complet(tenantId, a.id);
    expect(lu?.contenu.objectif).toBe('Renseigner');
    expect(lu?.contenu.sorties).toEqual([{ code: 'rdv', label: 'Rendez-vous' }]);
  });

  it('🔴 le verrou de version refuse une écriture sur une fiche qui a bougé', async () => {
    const a = await agents.create(tenantId, 'itest-verrou', 'x', 'modele-x');
    await agents.patch(tenantId, a.id, { contenu: { objectif: 'premier' } });
    const version = (await agents.complet(tenantId, a.id))!.ficheVersion;

    // Quelqu'un d'autre écrit entre-temps.
    await agents.patch(tenantId, a.id, { contenu: { objectif: 'second' } });

    await expect(agents.patch(tenantId, a.id, { contenu: { objectif: 'perime' }, ficheVersionAttendue: version }))
      .rejects.toThrow(/chang/);
    expect((await agents.complet(tenantId, a.id))?.contenu.objectif).toBe('second');
  });

  it('🔴 un label DÉJÀ PRIS lève une erreur métier, pas une erreur Postgres brute', async () => {
    // L'index unique de la migration 0086 remontait en 500, dont Cloudflare remplace le corps.
    await agents.create(tenantId, 'itest-doublon', 'x', 'modele-x');
    await expect(agents.create(tenantId, 'ITEST-DOUBLON', 'x', 'modele-x')).rejects.toThrow(/déjà ce nom/);
    // L'index est sur `lower(label)` : la casse ne suffit pas à contourner.
    const autre = await agents.create(tenantId, 'itest-renommage', 'x', 'modele-x');
    await expect(agents.patch(tenantId, autre.id, { label: 'itest-doublon' })).rejects.toThrow(/déjà ce nom/);
  });

  it('remove supprime, et un AUTRE tenant ne peut pas', async () => {
    const a = await agents.create(tenantId, 'itest-suppression', 'x', 'modele-x');
    expect(await agents.remove(autreTenantId, a.id)).toBe(false);
    expect(await agents.complet(tenantId, a.id)).not.toBeNull();
    expect(await agents.remove(tenantId, a.id)).toBe(true);
    expect(await agents.complet(tenantId, a.id)).toBeNull();
  });

  it('🔴 supprimer un agent emporte le connecteur HTTP qu’il était SEUL à utiliser, pas celui d’un voisin ni un MCP', async () => {
    // Décision du 2026-09-21 : un connecteur que plus personne n'utilise part, sinon il garde son nom pris et
    // bloque la suppression de sa requête sans écran pour s'en défaire. Même règle que `PgToolCatalog.detacher`.
    const partant = await agents.create(tenantId, 'itest-partant', 'x', 'modele-x');
    const voisin = await agents.create(tenantId, 'itest-voisin-reste', 'x', 'modele-x');
    const http = (await pool.query<{ id: string }>(
      `insert into agent_tool_sources (tenant_id, kind, label, base_url, auth_kind, status)
       values ($1, 'http', 'itest-src-partant', 'https://exemple.test', 'none', 'active') returning id`, [tenantId],
    )).rows[0]!.id;
    const mcp = (await pool.query<{ id: string }>(
      `insert into agent_tool_sources (tenant_id, kind, label, base_url, auth_kind, status)
       values ($1, 'mcp', 'itest-src-partant-mcp', 'https://exemple.test/mcp', 'none', 'active') returning id`, [tenantId],
    )).rows[0]!.id;
    const outil = async (name: string, origin: 'http' | 'mcp', source: string): Promise<string> => (await pool.query<{ id: string }>(
      `insert into agent_tools (tenant_id, origin, source_id, source_kind, name, title, description, ne_pas_utiliser, risk)
       values ($1, $2, $3, $2, $4, 'T', 'd', '', 'read') returning id`, [tenantId, origin, source, name],
    )).rows[0]!.id;
    const seul = await outil('itest_seul', 'http', http);
    const partage = await outil('itest_partage', 'http', http);
    const importe = await outil('itest_mcp', 'mcp', mcp);
    await pool.query(
      `insert into agent_tool_consommateurs (tenant_id, tool_id, consommateur)
       values ($1, $2, $5), ($1, $3, $5), ($1, $3, $6), ($1, $4, $5)`,
      [tenantId, seul, partage, importe, `agent:${partant.id}`, `agent:${voisin.id}`],
    );
    expect(await agents.remove(tenantId, partant.id)).toBe(true);
    const restants = (await pool.query<{ name: string }>(
      'select name from agent_tools where id = any($1::uuid[]) order by name', [[seul, partage, importe]],
    )).rows.map((r) => r.name);
    expect(restants).toEqual(['itest_mcp', 'itest_partage']);
    await pool.query('delete from agent_tools where id = any($1::uuid[])', [[partage, importe]]);
    await agents.remove(tenantId, voisin.id);
    await pool.query('delete from agent_tool_sources where id = any($1::uuid[])', [[http, mcp]]);
  });

  it('🔴 un AUTRE tenant ne lit ni n écrit la fiche (le filtrage en code est le seul contrôle)', async () => {
    const a = await agents.create(tenantId, 'itest-isolation', 'x', 'modele-x');
    expect(await agents.complet(autreTenantId, a.id)).toBeNull();
    expect(await agents.patch(autreTenantId, a.id, { label: 'volé' })).toBeNull();
    expect((await agents.complet(tenantId, a.id))?.label).toBe('itest-isolation');
  });

  it('une fiche jsonb ILLISIBLE ne rend pas l écran inéditable', async () => {
    // Une ligne écrite par une version antérieure, ou par une IA de construction dont le schéma a bougé.
    const a = await agents.create(tenantId, 'itest-fiche-cassee', 'x', 'modele-x');
    await pool.query(`update agents set fiche = '{"objectif": 42, "sorties": "pas un tableau"}'::jsonb where id = $1`, [a.id]);
    const lu = await agents.complet(tenantId, a.id);
    expect(lu?.contenu).toEqual({ nom: '', objectif: '', ton: '', personnalite: '', reglesTransfert: '', sorties: [] });
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

  it('🔴 supprimer un agent supprime ses lignes de consentement d’outils', async () => {
    // C'est le PRIX de la clé texte, tranché le 2026-09-10 : il n'y a AUCUNE clé étrangère derrière
    // `agent:<uuid>`, donc aucune cascade ne nettoie ces lignes. Sans ce ménage explicite, elles restent en
    // base, invisibles, et faussent les compteurs « utilisé par N consommateurs » de la bibliothèque.
    const agent = await agents.create(tenantId, `jetable-${Date.now()}`, 'Je suis une IA.', 'm');
    const outil = await pool.query<{ id: string }>(
      /**
       * ⚠️ CE COMMENTAIRE DISAIT « AUCUN `agent_id`, la colonne est partie avec 0128 », ET C'EST DEVENU FAUX
       * LE 2026-09-18. 0157 la fait revenir pour les ACTIONS, qui appartiennent à un agent ; 0159 pose le
       * CHECK qui l'exige. Ce que ce test éprouve N'A PAS CHANGÉ : c'est le MÉNAGE du consentement, donc la
       * ligne de LIAISON, et elle reste ce qui relie un outil à son consommateur.
       */
      `insert into agent_tools (tenant_id, agent_id, origin, name, title, description, ne_pas_utiliser, params, binding, risk)
       values ($1, $2, 'mba', 'menage_consentement', 'M', 'd', 'n', '[]'::jsonb, '{}'::jsonb, 'read') returning id`,
      [tenantId, agent.id],
    );
    const toolId = outil.rows[0]!.id;
    await pool.query(
      'insert into agent_tool_consommateurs (tenant_id, tool_id, consommateur) values ($1, $2, $3)',
      [tenantId, toolId, `agent:${agent!.id}`],
    );

    // Le TÉMOIN : un AUTRE agent, avec SA propre action. Sans lui, « la cascade emporte tout » passerait
    // aussi bien que « la cascade emporte ce qu'il faut », et c'est précisément la différence qui compte.
    const voisin = await agents.create(tenantId, `voisin-${Date.now()}`, 'Je suis une IA.', 'm');
    const outilVoisin = (await pool.query<{ id: string }>(
      `insert into agent_tools (tenant_id, agent_id, origin, name, title, description, ne_pas_utiliser, params, binding, risk)
       values ($1, $2, 'mba', 'menage_voisin', 'M', 'd', 'n', '[]'::jsonb, '{}'::jsonb, 'read') returning id`,
      [tenantId, voisin.id],
    )).rows[0]!.id;

    await agents.remove(tenantId, agent!.id);

    const restant = await pool.query(
      'select 1 from agent_tool_consommateurs where tenant_id = $1 and consommateur = $2',
      [tenantId, `agent:${agent!.id}`],
    );
    expect(restant.rowCount).toBe(0);

    /**
     * 🔴 CETTE ASSERTION DISAIT « LA DÉFINITION SURVIT », ET ELLE A CHANGÉ DE VÉRITÉ LE 2026-09-18.
     *
     * Elle était juste tant que TOUTE définition appartenait à l'espace (0127) : la supprimer avec un agent
     * aurait cassé les autres agents qui s'en servaient. 0157 a séparé les deux régimes, et une ACTION
     * appartient désormais à SON agent : elle part avec lui, par une cascade qui est cette fois le BON
     * choix, puisque la laisser derrière créerait un orphelin que rien ne nettoierait jamais.
     *
     * ⚠️ CE QUE CE TEST ÉPROUVE N'A PAS BOUGÉ D'UN IOTA : le ménage des lignes de consentement, ci-dessus,
     * qu'aucune clé étrangère ne fait à notre place. Ce qui est CONSERVÉ du cas d'origine, c'est
     * « supprimer un agent ne détruit pas ce qui ne lui appartient pas » : on le prouve désormais sur
     * l'action d'un AUTRE agent, qui n'a aucune raison de disparaître.
     */
    const partie = await pool.query('select 1 from agent_tools where tenant_id = $1 and id = $2', [tenantId, toolId]);
    expect(partie.rowCount).toBe(0);
    const voisinRestant = await pool.query('select 1 from agent_tools where tenant_id = $1 and id = $2', [tenantId, outilVoisin]);
    expect(voisinRestant.rowCount).toBe(1);
    await pool.query('delete from agents where id = $1', [voisin.id]);
  });
});
