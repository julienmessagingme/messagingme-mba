import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgJournalAppels, PgToolCatalog } from '../../src/agent/catalog.pg';
import { NomOutilDejaPris, OutilNonActivable } from '../../src/agent/catalog';
import { consommateurAgent, consommateurMba } from '../../src/agent/consommateur';
import { PgUserStore } from '../../src/user/store.pg';
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
    // ⚠️ DEUX ÉCRITURES PAR OUTIL DEPUIS LA MIGRATION 0127 : la DÉFINITION, puis le CONSENTEMENT. Les
    // lectures joignent la table de liaison, donc une définition sans ligne de liaison est INVISIBLE, y
    // compris de `byName`. La définition ne porte plus NI `agent_id` NI le consentement : ces colonnes sont
    // parties avec 0128, et les écrire ici ferait échouer le test sur une base à jour.
    const actif = await pool.query<{ id: string }>(
      // ⚠️ `agent_id` DEPUIS 0157 : une ACTION appartient à l'agent, et 0159 pose le CHECK qui l'exige. Un
      // connecteur, lui, reste au niveau de l'ESPACE et garde `agent_id` à null.
      `insert into agent_tools (tenant_id, agent_id, origin, name, title, description, ne_pas_utiliser,
                                params, binding, output_paths, risk, timeout_ms, max_bytes)
       values ($1, $4, 'mba', 'lire_commande', 'Lire', 'lit une commande', 'jamais pour annuler',
               $2::jsonb, $3::jsonb, array['data.statut'], 'read', 4000, 2048) returning id`,
      [tenantId,
        JSON.stringify([{ name: 'reference', type: 'string', source: 'modele', required: true }]),
        JSON.stringify({ handler: 'lire_contact' }), agentId],
    );
    await pool.query(
      `insert into agent_tool_consommateurs (tenant_id, tool_id, consommateur, tool_name, actif, active_par, active_le)
       values ($1, $2, $3, (select name from agent_tools where id = $2), true, $4, now())`,
      [tenantId, actif.rows[0]!.id, `agent:${agentId}`, adminId],
    );
    const eteint = await pool.query<{ id: string }>(
      `insert into agent_tools (tenant_id, agent_id, origin, name, title, description, ne_pas_utiliser, risk)
       values ($1, $2, 'mba', 'outil_eteint', 'Éteint', 'inactif', 'jamais', 'read') returning id`,
      [tenantId, agentId],
    );
    await pool.query(
      'insert into agent_tool_consommateurs (tenant_id, tool_id, consommateur, tool_name) values ($1, $2, $3, (select name from agent_tools where id = $2))',
      [tenantId, eteint.rows[0]!.id, `agent:${agentId}`],
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
      tenantId, sessionId, toolId: null, toolName: 'lire_commande', origin: 'mba', argsRediges: { reference: 'X' }, source: 'agent',
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
    const id = await journal.ouvrir({ tenantId, sessionId, toolId: null, toolName: 'x', origin: 'mba', argsRediges: null, source: 'agent' });
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

/**
 * L'ÉCRITURE du catalogue (tranche 19c) : ce que l'écran de réglage fait à `agent_tools`.
 *
 * 🔴 Trois choses ne peuvent être prouvées QUE contre un vrai Postgres. L'appartenance de l'agent vérifiée
 * dans l'INSERT (`where exists`), les deux contraintes de consentement humain de la migration 0086 (`actif`
 * et `autonome` refusés sans la personne qui les a posés), et la réécriture des énumérations dans le jsonb en
 * une seule instruction. Un faux store dirait oui à tout.
 */
describe.skipIf(!url)('ecriture du catalogue d outils (Postgres)', () => {

  /**
   * Nettoyage de fin de test : DÉTACHE de l'agent puis supprime la DÉFINITION.
   *
   * 🔴 `retirer` FAISAIT LES DEUX EN UN, ET C'EST CE QUE LA MIGRATION 0127 SÉPARE. Ne faire que détacher
   * laisserait les définitions s'accumuler dans l'espace de test, et le test suivant buterait sur l'unicité
   * du nom, avec une erreur qui n'aurait aucun rapport avec ce qu'il vérifie.
   *
   * ⚠️ `supprimerDefinition` N'EXISTE PLUS (2026-09-21) : plus aucun écran ne supprime une définition à la
   * main, `detacher` efface une action ou un connecteur HTTP que plus personne n'utilise. Le second geste est
   * donc un nettoyage DE TEST, en SQL : il efface ce qui survit au détachement (une action qu'un voisin
   * utilisait encore), pour que le test suivant ne bute pas sur un nom déjà pris.
   */
  const retirerCompletement = async (t: string, a: string, id: string): Promise<void> => {
    await catalogue.detacher(t, a, id);
    await pool.query('delete from agent_tools where tenant_id = $1 and id = $2', [t, id]);
  };
  let pool: Pool;
  let catalogue: PgToolCatalog;
  let tenantId: string;
  let autreTenantId: string;
  let agentId: string;
  let agentDeLAutre: string;
  let adminId: string;

  const modele = {
    // `cible: null` : la cible d'un outil à cible est exigée par `ajouterOutilMaison`, pas par le dépôt (RC4).
    handler: 'poser_tag', cible: null, name: 'mba_poser_tag', title: 'Poser un tag',
    description: 'Marque le contact.', nePasUtiliser: 'Pas de tag invente.',
    params: [{ name: 'tag', type: 'string', source: 'modele', required: true }],
    risk: 'write' as const,
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    catalogue = new PgToolCatalog(pool);
    const t = await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-tools-write') returning id`);
    tenantId = t.rows[0]!.id;
    const t2 = await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-tools-write-autre') returning id`);
    autreTenantId = t2.rows[0]!.id;
    const u = await pool.query<{ id: string }>(
      `insert into users (tenant_id, email, role, password_hash) values ($1, 'itest-tools@example.test', 'admin', 'x') returning id`,
      [tenantId],
    );
    adminId = u.rows[0]!.id;
    const a = await pool.query<{ id: string }>(
      `insert into agents (tenant_id, label, mention_ia, modele) values ($1, 'itest-tw', 'Je suis une IA.', 'm') returning id`,
      [tenantId],
    );
    agentId = a.rows[0]!.id;
    const b = await pool.query<{ id: string }>(
      `insert into agents (tenant_id, label, mention_ia, modele) values ($1, 'itest-tw-autre', 'Je suis une IA.', 'm') returning id`,
      [autreTenantId],
    );
    agentDeLAutre = b.rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    if (autreTenantId) await pool.query('delete from tenants where id = $1', [autreTenantId]);
    await pool.end();
  });

  it('ajoute un outil INACTIF, avec son handler dans le binding', async () => {
    const outil = await catalogue.ajouter(tenantId, agentId, modele);
    expect(outil).not.toBeNull();
    // Inactif d'emblee, quoi qu'ait voulu l'appelant : un outil actif serait expose au modele avant que
    // quiconque ait relu ses mots.
    expect(outil!.actif).toBe(false);
    expect(outil!.activeLe).toBeNull();
    expect(outil!.binding).toEqual({ handler: 'poser_tag' });
    expect(outil!.origin).toBe('mba');
    // Et il n'est PAS dans ce que le runtime expose, puisqu'il n'est pas actif.
    expect(await catalogue.listActifs(tenantId, agentId)).toEqual([]);
    await retirerCompletement(tenantId, agentId, outil!.id);
  });

  it('🔴 un agent d un AUTRE tenant ne peut pas recevoir d outil, et rien n est ecrit', async () => {
    expect(await catalogue.ajouter(tenantId, agentDeLAutre, modele)).toBeNull();
    // ⚠️ ON COMPTE LES LIAISONS, PLUS LES COLONNES `agent_id`. Le nouveau code n'écrit plus cette colonne :
    // ce test serait devenu CREUX, il aurait compté zéro même si une définition avait bel et bien été créée.
    const n = await pool.query<{ n: string }>(
      'select count(*) as n from agent_tool_consommateurs where consommateur = $1',
      [`agent:${agentDeLAutre}`],
    );
    expect(Number(n.rows[0]!.n)).toBe(0);
  });

  /**
   * 🔴 RC4 : LA CIBLE FIXÉE D'UN OUTIL D'AGENT IA. Elle s'écrit dans `binding`, à côté du handler, et le scénario qu'elle
   * vise est cherché DANS L'ESPACE par l'écriture elle-même (un `exists` sur `workflows`), à la pose comme à la
   * correction. Une correction ne change jamais le handler de l'outil.
   */
  describe('la cible fixée (RC4)', () => {
    const scenario = async (t: string, nom: string): Promise<string> => (await pool.query<{ id: string }>(
      'insert into workflows (tenant_id, name) values ($1, $2) returning id', [t, nom],
    )).rows[0]!.id;
    const lancer = (workflowId: string, name: string) => ({
      handler: 'lancer_scenario', cible: { handler: 'lancer_scenario' as const, workflowId }, name, title: 'Lancer',
      description: 'Lance.', nePasUtiliser: 'Pas au hasard.', params: [], risk: 'irreversible' as const,
    });

    it('🔴 la pose écrit la cible ENTIÈRE dans binding, et refuse le scénario d’un autre espace', async () => {
      const wf = await scenario(tenantId, `itest-cible-${Date.now()}`);
      const outil = await catalogue.ajouter(tenantId, agentId, lancer(wf, 'lancer_rdv'));
      expect(outil!.binding).toEqual({ handler: 'lancer_scenario', workflowId: wf });

      const ailleurs = await scenario(autreTenantId, `itest-cible-autre-${Date.now()}`);
      expect(await catalogue.ajouter(tenantId, agentId, lancer(ailleurs, 'lancer_ailleurs'))).toBeNull();
      // Rien n'est écrit : ni définition, ni liaison.
      const n = await pool.query<{ n: string }>(
        'select count(*) as n from agent_tools where tenant_id = $1 and name = $2', [tenantId, 'lancer_ailleurs'],
      );
      expect(Number(n.rows[0]!.n)).toBe(0);
      await retirerCompletement(tenantId, agentId, outil!.id);
    });

    it('🔴 la correction réécrit la cible, jamais vers un autre handler ni vers le scénario d’un autre espace', async () => {
      const wf = await scenario(tenantId, `itest-cible-a-${Date.now()}`);
      const wf2 = await scenario(tenantId, `itest-cible-b-${Date.now()}`);
      const ailleurs = await scenario(autreTenantId, `itest-cible-c-${Date.now()}`);
      const outil = (await catalogue.ajouter(tenantId, agentId, lancer(wf, 'lancer_corrige')))!;

      const corrige = await catalogue.patch(tenantId, agentId, outil.id, { cible: { handler: 'lancer_scenario', workflowId: wf2 } });
      expect(corrige!.binding).toEqual({ handler: 'lancer_scenario', workflowId: wf2 });
      // Une cible d'un autre handler n'écrit rien : l'outil ne devient pas un outil de tag.
      expect(await catalogue.patch(tenantId, agentId, outil.id, { cible: { handler: 'poser_tag', tag: 'vip' } })).toBeNull();
      // Le scénario d'un autre espace n'écrit rien non plus.
      expect(await catalogue.patch(tenantId, agentId, outil.id, { cible: { handler: 'lancer_scenario', workflowId: ailleurs } })).toBeNull();
      const relu = await pool.query<{ binding: unknown }>('select binding from agent_tools where id = $1', [outil.id]);
      expect(relu.rows[0]!.binding).toEqual({ handler: 'lancer_scenario', workflowId: wf2 });
      // Un patch sans cible ne touche pas au binding.
      await catalogue.patch(tenantId, agentId, outil.id, { title: 'Lancer la prise de rendez-vous' });
      const encore = await pool.query<{ binding: unknown }>('select binding from agent_tools where id = $1', [outil.id]);
      expect(encore.rows[0]!.binding).toEqual({ handler: 'lancer_scenario', workflowId: wf2 });
      await retirerCompletement(tenantId, agentId, outil.id);
    });
  });

  it('deux outils du meme ESPACE ne peuvent pas porter le meme nom expose', async () => {
    const un = await catalogue.ajouter(tenantId, agentId, modele);
    await expect(catalogue.ajouter(tenantId, agentId, modele)).rejects.toThrow(NomOutilDejaPris);
    await retirerCompletement(tenantId, agentId, un!.id);
  });

  it('🔴 activer ecrit QUI a active, et desactiver l efface', async () => {
    // Le consentement humain de la spec MCP, deplace du runtime vers la configuration parce que notre agent
    // n a aucun humain au runtime. La migration 0086 le refusait sur `agent_tools` ; depuis 0127 le meme
    // CHECK vit sur `agent_tool_consommateurs`, ou le consentement a demenage.
    const outil = (await catalogue.ajouter(tenantId, agentId, modele))!;
    const actif = await catalogue.activer(tenantId, agentId, outil.id, true, adminId);
    expect(actif!.actif).toBe(true);
    expect(actif!.activeLe).not.toBeNull();
    // ⚠️ ON LIT LA LIAISON, PLUS L OUTIL. `activer` ecrit desormais dans `agent_tool_consommateurs` : lire
    // `agent_tools.active_par` rendrait null et ce test aurait echoue, alors que le consentement est bien
    // pose. Il se trouve au bon endroit, pas a l ancien.
    const qui = await pool.query<{ active_par: string }>(
      'select active_par from agent_tool_consommateurs where tool_id = $1 and consommateur = $2',
      [outil.id, `agent:${agentId}`],
    );
    expect(qui.rows[0]!.active_par).toBe(adminId);
    // Actif, il entre dans ce que le runtime expose.
    expect((await catalogue.listActifs(tenantId, agentId)).map((o) => o.name)).toEqual(['mba_poser_tag']);

    const inactif = await catalogue.activer(tenantId, agentId, outil.id, false, adminId);
    expect(inactif!.actif).toBe(false);
    expect(inactif!.activeLe).toBeNull();
    // ⚠️ MÊME PIÈGE : lire `agent_tools.active_par` rendrait null sans rien prouver, puisque plus personne
    // ne l'écrit. C'est la ligne de liaison qui doit avoir été effacée.
    const apres = await pool.query<{ active_par: string | null }>(
      'select active_par from agent_tool_consommateurs where tool_id = $1 and consommateur = $2',
      [outil.id, `agent:${agentId}`],
    );
    expect(apres.rows[0]!.active_par).toBeNull();
    await retirerCompletement(tenantId, agentId, outil.id);
  });

  it('l autonomie se pose et se retire de la meme facon', async () => {
    const outil = (await catalogue.ajouter(tenantId, agentId, { ...modele, risk: 'irreversible' }))!;
    const pose = await catalogue.autonomie(tenantId, agentId, outil.id, true, adminId);
    expect(pose!.autonome).toBe(true);
    expect(pose!.autonomeLe).not.toBeNull();
    const retire = await catalogue.autonomie(tenantId, agentId, outil.id, false, adminId);
    expect(retire!.autonome).toBe(false);
    expect(retire!.autonomeLe).toBeNull();
    await retirerCompletement(tenantId, agentId, outil.id);
  });

  it('🔴 corriger les enumerations reecrit le jsonb SANS toucher au reste du parametre', async () => {
    const outil = (await catalogue.ajouter(tenantId, agentId, modele))!;
    const patche = await catalogue.patch(tenantId, agentId, outil.id, {
      description: 'Marque le contact, pour le retrouver ensuite.',
      enums: { tag: ['vip', 'relance'] },
    });
    expect(patche!.description).toContain('retrouver');
    expect(patche!.params).toEqual([
      { name: 'tag', type: 'string', source: 'modele', required: true, enum: ['vip', 'relance'] },
    ]);
    // Le titre, que le patch ne mentionne pas, est intact.
    expect(patche!.title).toBe('Poser un tag');

    // Et une liste vide EFFACE la restriction, elle ne la laisse pas en place.
    const vide = await catalogue.patch(tenantId, agentId, outil.id, { enums: { tag: [] } });
    expect(vide!.params).toEqual([{ name: 'tag', type: 'string', source: 'modele', required: true, enum: [] }]);
    await retirerCompletement(tenantId, agentId, outil.id);
  });

  it('🔴 un AUTRE tenant ne peut ni lire, ni corriger, ni activer, ni retirer', async () => {
    const outil = (await catalogue.ajouter(tenantId, agentId, modele))!;
    expect(await catalogue.listToutes(autreTenantId, agentId)).toEqual([]);
    expect(await catalogue.patch(autreTenantId, agentId, outil.id, { title: 'Detourne' })).toBeNull();
    expect(await catalogue.activer(autreTenantId, agentId, outil.id, true, adminId)).toBeNull();
    expect(await catalogue.autonomie(autreTenantId, agentId, outil.id, true, adminId)).toBeNull();
    expect(await catalogue.detacher(autreTenantId, agentId, outil.id)).toBe(false);
    // Et l outil est intact : un refus qui aurait quand meme ecrit ne serait pas un refus.
    const apres = (await catalogue.listToutes(tenantId, agentId))[0]!;
    expect(apres.title).toBe('Poser un tag');
    expect(apres.actif).toBe(false);
    await retirerCompletement(tenantId, agentId, outil.id);
  });

  it('🔴 l agent de l URL fait partie du perimetre, pas seulement le tenant', async () => {
    // Deux agents du MEME client : un identifiant mal aiguille par l ecran ne doit pas corriger l outil de
    // l autre agent. Le couple (tenant, agent) est le perimetre partout.
    const secondAgent = await pool.query<{ id: string }>(
      `insert into agents (tenant_id, label, mention_ia, modele) values ($1, 'itest-tw-2', 'Je suis une IA.', 'm') returning id`,
      [tenantId],
    );
    const autre = secondAgent.rows[0]!.id;
    const outil = (await catalogue.ajouter(tenantId, agentId, modele))!;
    expect(await catalogue.patch(tenantId, autre, outil.id, { title: 'Detourne' })).toBeNull();
    expect(await catalogue.activer(tenantId, autre, outil.id, true, adminId)).toBeNull();
    expect(await catalogue.detacher(tenantId, autre, outil.id)).toBe(false);
    await retirerCompletement(tenantId, agentId, outil.id);
  });

  it('🔴 supprimer l utilisateur qui a active un outil ne casse PAS la suppression', async () => {
    // `active_par` est `on delete set null`, MAIS la table porte aussi `check (actif = false or active_par is
    // not null)` : le `set null` declenche par la suppression est une ecriture ordinaire, soumise au check, et
    // il faisait donc echouer TOUT le delete en 23514. Un depart de collaborateur rendait un 500, donc une
    // page Cloudflare, sur un geste parfaitement legitime.
    const users = new PgUserStore(pool);
    const u = await pool.query<{ id: string }>(
      `insert into users (tenant_id, email, role, password_hash) values ($1, 'itest-partant@example.test', 'agent', 'x') returning id`,
      [tenantId],
    );
    const partant = u.rows[0]!.id;
    const outil = (await catalogue.ajouter(tenantId, agentId, { ...modele, name: 'mba_poser_tag_2', risk: 'irreversible' }))!;
    await catalogue.activer(tenantId, agentId, outil.id, true, partant);
    await catalogue.autonomie(tenantId, agentId, outil.id, true, partant);

    expect(await users.deleteUser(tenantId, partant)).toBe('ok');

    // L outil survit, mais eteint : le consentement humain qu il portait n existe plus, et un outil actif sans
    // personne pour l avoir autorise est exactement ce que la migration interdit.
    const apres = (await catalogue.listToutes(tenantId, agentId)).find((o) => o.id === outil.id)!;
    expect(apres.actif).toBe(false);
    expect(apres.autonome).toBe(false);
    expect(apres.activeLe).toBeNull();
    expect(apres.autonomeLe).toBeNull();
    await retirerCompletement(tenantId, agentId, outil.id);
  });

  it('un refus de suppression n eteint AUCUN outil', async () => {
    // Le dernier administrateur actif ne peut pas etre supprime. Le refus doit laisser la base exactement
    // comme il l a trouvee : un refus qui aurait quand meme eteint des outils ne serait pas un refus.
    const users = new PgUserStore(pool);
    const outil = (await catalogue.ajouter(tenantId, agentId, { ...modele, name: 'mba_poser_tag_3' }))!;
    await catalogue.activer(tenantId, agentId, outil.id, true, adminId);

    expect(await users.deleteUser(tenantId, adminId)).toBe('last_admin');

    const apres = (await catalogue.listToutes(tenantId, agentId)).find((o) => o.id === outil.id)!;
    expect(apres.actif).toBe(true);
    await retirerCompletement(tenantId, agentId, outil.id);
  });

  /**
   * 🔴 LE COEUR DE LA MIGRATION 0127 : la DÉFINITION est partagée, le CONSENTEMENT ne l'est pas.
   *
   * Sans cette séparation, remonter les outils au niveau de l'espace les aurait rendus actifs pour tous les
   * agents d'un coup, ce qui aurait vidé de son contenu la règle que 0086 pose en base : un outil n'est actif
   * que si un humain l'a activé.
   */
  describe('la définition se partage, le consentement non', () => {
    it('🔴 un outil n’est actif QUE pour le consommateur qui l’a activé', async () => {
      const voisin = (await pool.query<{ id: string }>(
        `insert into agents (tenant_id, label, mention_ia, modele) values ($1, 'itest-voisin-actif', 'IA', 'm') returning id`,
        [tenantId],
      )).rows[0]!.id;
      const outil = await catalogue.ajouter(tenantId, agentId, { ...modele, name: 'partage_actif' });
      await catalogue.rattacher(tenantId, voisin, outil!.id);
      await catalogue.activer(tenantId, agentId, outil!.id, true, adminId);

      expect(await catalogue.byName(tenantId, agentId, 'partage_actif')).not.toBeNull();
      expect(await catalogue.byName(tenantId, voisin, 'partage_actif')).toBeNull();
      await catalogue.detacher(tenantId, voisin, outil!.id);
      await retirerCompletement(tenantId, agentId, outil!.id);
      await pool.query('delete from agents where id = $1', [voisin]);
    });

    it('🔴 le MBA est un consommateur comme un autre, sur la MÊME définition', async () => {
      // C'est la porte par laquelle le Meta Business Agent entre sans qu'on lui invente une fiche d'agent,
      // sans modèle et sans crédit. Une définition, deux consentements parfaitement indépendants.
      const mba = consommateurMba('1234840649713976');
      const outil = await catalogue.ajouter(tenantId, agentId, { ...modele, name: 'partage_mba' });
      await catalogue.rattacherConsommateur(tenantId, mba, outil!.id);
      await catalogue.activerConsommateur(tenantId, mba, outil!.id, true, adminId);

      expect((await catalogue.listActifsConsommateur(tenantId, mba)).map((o) => o.name)).toContain('partage_mba');
      // L'agent, lui, ne l'a pas activé : son consentement est le sien.
      expect(await catalogue.byName(tenantId, agentId, 'partage_mba')).toBeNull();
      await retirerCompletement(tenantId, agentId, outil!.id);
    });

    it('🔴 l’isolation entre clients tient sur la JOINTURE, pas seulement sur l’outil', async () => {
      // Le nom d'outil vient du MODÈLE, donc d'un texte qu'un contact peut influencer. Si la clause `where`
      // de la jointure oubliait le tenant, une injection réussie appellerait l'outil d'un autre client.
      const outil = await catalogue.ajouter(tenantId, agentId, { ...modele, name: 'isole_jointure' });
      await catalogue.activer(tenantId, agentId, outil!.id, true, adminId);
      expect(await catalogue.byName(autreTenantId, agentId, 'isole_jointure')).toBeNull();
      expect(await catalogue.listActifs(autreTenantId, agentId)).toEqual([]);
      await retirerCompletement(tenantId, agentId, outil!.id);
    });

    it('🔴 créer un outil depuis un agent le RATTACHE à cet agent, INACTIF', async () => {
      // Le geste du client n'a pas changé (« j'ajoute un outil à mon agent »). Ce qui a changé, c'est qu'il
      // crée une définition d'espace PLUS un rattachement. Sans le rattachement, l'outil serait créé et
      // invisible dans l'onglet d'où on vient de le créer.
      const outil = await catalogue.ajouter(tenantId, agentId, { ...modele, name: 'neuf_rattache' });
      expect(outil).not.toBeNull();
      expect(outil!.actif).toBe(false);
      expect((await catalogue.listToutes(tenantId, agentId)).map((o) => o.name)).toContain('neuf_rattache');
      await retirerCompletement(tenantId, agentId, outil!.id);
    });

    it('🔴 détacher un outil qu’un AUTRE agent utilise encore ne le supprime pas', async () => {
      // C'est le changement de sens du bouton « supprimer » de l'onglet d'un agent : il retire l'outil DE CET
      // AGENT. Le supprimer pour tout le monde depuis l'écran d'un seul casserait les autres en silence.
      //
      // ⚠️ LE TITRE A ÉTÉ RESSERRÉ LE 2026-09-18, parce que la règle générale qu'il annonçait est devenue
      // fausse : une action dont on détache le DERNIER consommateur s'en va désormais avec lui. Ce qui reste
      // vrai, et ce que ce test exerce, est le cas du VOISIN : tant que quelqu'un d'autre s'en sert, la
      // définition tient. Le cas du dernier consommateur est éprouvé plus bas.
      const voisin = (await pool.query<{ id: string }>(
        `insert into agents (tenant_id, label, mention_ia, modele) values ($1, 'itest-voisin-garde', 'IA', 'm') returning id`,
        [tenantId],
      )).rows[0]!.id;
      const outil = await catalogue.ajouter(tenantId, agentId, { ...modele, name: 'garde_definition' });
      await catalogue.rattacher(tenantId, voisin, outil!.id);
      expect(await catalogue.detacher(tenantId, agentId, outil!.id)).toBe(true);
      expect((await catalogue.listToutes(tenantId, agentId)).map((o) => o.name)).not.toContain('garde_definition');
      expect((await catalogue.listToutes(tenantId, voisin)).map((o) => o.name)).toContain('garde_definition');
      await retirerCompletement(tenantId, voisin, outil!.id);
      await pool.query('delete from agents where id = $1', [voisin]);
    });

    /**
     * 🔴 UN CONNECTEUR HTTP PART AVEC SON DERNIER UTILISATEUR, PAS AVANT (décision de Julien, 2026-09-21).
     *
     * Ce test portait « supprimer une définition encore rattachée est REFUSÉ » : la méthode n'existe plus, parce
     * que plus aucun écran ne supprime une définition à la main (l'ancienne bibliothèque de l'espace est partie
     * avec l'onglet Outils refait du MBA). Le cas qu'il protégeait (ne JAMAIS emporter en silence le
     * consentement d'un autre) est conservé : tant qu'un voisin se sert du connecteur, il reste.
     *
     * ⚠️ UNE VRAIE SOURCE : `agent_tools_origin_src_chk` (0088) l'EXIGE dès qu'on sort de `origin = 'mba'`.
     */
    it('🔴 un CONNECTEUR partagé reste tant qu’un voisin s’en sert, et part avec son dernier utilisateur', async () => {
      const voisin = (await pool.query<{ id: string }>(
        `insert into agents (tenant_id, label, mention_ia, modele) values ($1, 'itest-voisin-connecteur', 'IA', 'm') returning id`,
        [tenantId],
      )).rows[0]!.id;
      const source = (await pool.query<{ id: string }>(
        `insert into agent_tool_sources (tenant_id, kind, label, base_url, auth_kind, status)
         values ($1, 'http', 'itest-src-occupee', 'https://exemple.test', 'none', 'draft') returning id`,
        [tenantId],
      )).rows[0]!.id;
      const id = (await pool.query<{ id: string }>(
        `insert into agent_tools (tenant_id, origin, source_id, name, title, description, ne_pas_utiliser, risk)
         values ($1, 'http', $2, 'occupee', 'Occupée', 'o', '', 'read') returning id`,
        [tenantId, source],
      )).rows[0]!.id;
      await pool.query(
        'insert into agent_tool_consommateurs (tenant_id, tool_id, consommateur, tool_name) values ($1, $2, $3, (select name from agent_tools where id = $2)), ($1, $2, $4, (select name from agent_tools where id = $2))',
        [tenantId, id, `agent:${agentId}`, `agent:${voisin}`],
      );
      const existe = async (): Promise<boolean> =>
        ((await pool.query('select 1 from agent_tools where id = $1', [id])).rowCount ?? 0) > 0;

      expect(await catalogue.detacher(tenantId, agentId, id)).toBe(true);
      expect(await existe()).toBe(true);
      expect((await catalogue.listToutes(tenantId, voisin)).map((o) => o.name)).toContain('occupee');

      expect(await catalogue.detacher(tenantId, voisin, id)).toBe(true);
      expect(await existe()).toBe(false);
      await pool.query('delete from agents where id = $1', [voisin]);
      await pool.query('delete from agent_tool_sources where id = $1', [source]);
    });

    it('🔴 un outil MCP, lui, RESTE après son dernier détachement : il doit rester branchable', async () => {
      const source = (await pool.query<{ id: string }>(
        `insert into agent_tool_sources (tenant_id, kind, label, base_url, auth_kind, status)
         values ($1, 'mcp', 'itest-src-mcp', 'https://exemple.test/mcp', 'none', 'active') returning id`,
        [tenantId],
      )).rows[0]!.id;
      const id = (await pool.query<{ id: string }>(
        `insert into agent_tools (tenant_id, origin, source_id, source_kind, name, title, description, ne_pas_utiliser, risk)
         values ($1, 'mcp', $2, 'mcp', 'mcp_reste', 'MCP', 'm', '', 'read') returning id`,
        [tenantId, source],
      )).rows[0]!.id;
      await pool.query(
        'insert into agent_tool_consommateurs (tenant_id, tool_id, consommateur, tool_name) values ($1, $2, $3, (select name from agent_tools where id = $2))',
        [tenantId, id, `agent:${agentId}`],
      );
      expect(await catalogue.detacher(tenantId, agentId, id)).toBe(true);
      expect((await pool.query('select 1 from agent_tools where id = $1', [id])).rowCount).toBe(1);
      expect((await catalogue.listCatalogue(tenantId)).map((o) => o.name)).toContain('mcp_reste');
      await pool.query('delete from agent_tools where id = $1', [id]);
      await pool.query('delete from agent_tool_sources where id = $1', [source]);
    });

    it('🔴 une ACTION s’en va AVEC son détachement : aucun orphelin', async () => {
      // La bibliothèque de l'espace n'affiche plus les actions d'agent (0157) : la laisser derrière ferait un
      // orphelin invisible, ineffaçable, dont le nom resterait pris pour cet agent.
      const outil = await catalogue.ajouter(tenantId, agentId, { ...modele, name: 'action_jetable' });
      expect((await pool.query('select 1 from agent_tools where id = $1', [outil!.id])).rowCount).toBe(1);
      expect(await catalogue.detacher(tenantId, agentId, outil!.id)).toBe(true);
      expect((await pool.query('select 1 from agent_tools where id = $1', [outil!.id])).rowCount).toBe(0);
    });

    /**
     * 🔴 CE TEST AFFIRMAIT L'INVERSE JUSQU'AU 2026-09-18, ET LA GARANTIE A CHANGÉ PAR DÉCISION.
     *
     * 0127 avait fait remonter TOUTE définition au niveau de l'espace, parce que le sujet du moment était le
     * CONSENTEMENT d'un connecteur partagé entre plusieurs agents et le MBA. C'était juste pour un
     * connecteur, et faux pour une ACTION, qui est une décision propre à un agent. Julien s'est heurté au
     * symptôme le 2026-09-18 : donner « Terminer par une règle d'arrêt » à un second agent rendait « un
     * outil de cet espace porte déjà ce nom », sans aucun chemin pour s'en sortir.
     *
     * ⚠️ CE QUI EST CONSERVÉ DU CAS D'ORIGINE : le second agent est bien DU MÊME ESPACE. Avec celui d'un
     * autre tenant, `ajouter` rend `null` sur sa garde d'isolation AVANT d'atteindre l'index unique, et le
     * test passerait pour la mauvaise raison. CE QUI CHANGE : il obtient désormais son propre outil, et
     * c'est le MÊME agent qui se fait refuser le doublon.
     */
    it('🔴 le nom d’une ACTION est pris PAR AGENT, plus pour tout l’espace', async () => {
      const voisin = (await pool.query<{ id: string }>(
        `insert into agents (tenant_id, label, mention_ia, modele) values ($1, 'itest-voisin', 'IA', 'm') returning id`,
        [tenantId],
      )).rows[0]!.id;
      const un = await catalogue.ajouter(tenantId, agentId, { ...modele, name: 'unique_espace' });
      const deux = await catalogue.ajouter(tenantId, voisin, { ...modele, name: 'unique_espace' });
      expect(deux).not.toBeNull();
      expect(deux!.id).not.toBe(un!.id);
      // ...et le MÊME agent ne peut toujours pas l'avoir deux fois : il exposerait au modèle deux outils
      // portant le même nom, ce qu'aucune API d'appel de fonction n'accepte.
      await expect(catalogue.ajouter(tenantId, agentId, { ...modele, name: 'unique_espace' }))
        .rejects.toBeInstanceOf(NomOutilDejaPris);
      await retirerCompletement(tenantId, agentId, un!.id);
      await pool.query('delete from agents where id = $1', [voisin]);
    });

    it('🔴 activer pour un consommateur NON rattaché ne crée RIEN', async () => {
      // Sinon `activer` deviendrait un rattachement implicite, et un identifiant d'agent erroné poserait un
      // consentement sur un consommateur qui n'existe nulle part, invisible de tous les écrans.
      const voisin = (await pool.query<{ id: string }>(
        `insert into agents (tenant_id, label, mention_ia, modele) values ($1, 'itest-voisin-pasrat', 'IA', 'm') returning id`,
        [tenantId],
      )).rows[0]!.id;
      const outil = await catalogue.ajouter(tenantId, agentId, { ...modele, name: 'pas_rattache' });
      expect(await catalogue.activer(tenantId, voisin, outil!.id, true, adminId)).toBeNull();
      expect(await catalogue.byName(tenantId, voisin, 'pas_rattache')).toBeNull();
      await pool.query('delete from agents where id = $1', [voisin]);
      await retirerCompletement(tenantId, agentId, outil!.id);
    });

    it('🔴 désactiver EFFACE l’activateur, sur la ligne de liaison', async () => {
      // Ces colonnes disent « qui l'a mis en service, et quand », pas « qui y a touché un jour ». Les garder
      // ferait afficher un consentement qui n'a plus cours.
      const outil = await catalogue.ajouter(tenantId, agentId, { ...modele, name: 'bascule_activateur' });
      await catalogue.activer(tenantId, agentId, outil!.id, true, adminId);
      const eteint = await catalogue.activer(tenantId, agentId, outil!.id, false, adminId);
      expect(eteint!.actif).toBe(false);
      expect(eteint!.activeLe).toBeNull();
      await retirerCompletement(tenantId, agentId, outil!.id);
    });
  });
});

/**
 * 🔴 LA RÈGLE UNIQUE « QUEL OUTIL POUR QUEL AGENT » (2026-10-02). Elle vivait à cinq endroits, en trois versions qui
 * se contredisaient : un outil MCP mort était écarté pour l'agent de Meta mais proposé à un agent IA, et un outil d'un
 * serveur éteint était proposé partout. Elle s'écrit désormais une fois, en SQL, dans le catalogue.
 *
 * CE QUE CETTE TABLE PROUVE : chaque cas est joué à travers TOUTES les lectures de la règle (ce qu'on offre à un agent
 * IA, à l'agent de Meta, la cause portée par la bibliothèque, la porte de rattachement, l'activation, ce que voit le
 * modèle). Elles ne peuvent plus diverger sans qu'une ligne de cette table tombe.
 */
describe.skipIf(!url)('la règle unique : offrable, appelable, rattachable (Postgres)', () => {
  let pool: Pool;
  let catalogue: PgToolCatalog;
  let tenantId: string;
  let autreTenantId: string;
  let agentId: string;
  let agentActivation: string;
  let adminId: string;
  // La forme d'une clé de consommateur est gardée par un CHECK (`FORME_CONSOMMATEUR`) : un numéro est fait de chiffres.
  const NUMERO = '900000000000101';
  const MBA = consommateurMba(NUMERO);
  const ids: Record<string, string> = {};

  type Cas = { nom: string; offrable: boolean; refus: string; cause: string | null };
  const CAS: Cas[] = [
    { nom: 'mcp_vivant', offrable: true, refus: 'ok', cause: null },
    { nom: 'mcp_decoche', offrable: false, refus: 'non_enregistre', cause: null },
    { nom: 'mcp_non_activable', offrable: false, refus: 'inappelable', cause: 'non_activable' },
    { nom: 'mcp_disparu', offrable: false, refus: 'inappelable', cause: 'disparu' },
    { nom: 'mcp_brouillon', offrable: false, refus: 'inappelable', cause: 'source_inactive' },
    { nom: 'mcp_eteint', offrable: false, refus: 'inappelable', cause: 'source_inactive' },
    { nom: 'http_vivant', offrable: true, refus: 'ok', cause: null },
    { nom: 'http_eteint', offrable: false, refus: 'inappelable', cause: 'source_inactive' },
    // La source d'un connecteur est celle de sa REQUÊTE, comme pour le résolveur HTTP, même si l'outil en nomme une autre.
    { nom: 'http_requete_eteinte', offrable: false, refus: 'inappelable', cause: 'source_inactive' },
    // Une ligne ancienne sans `source_kind` échappe à la clé étrangère (MATCH SIMPLE) : un MCP posé sur un système
    // HTTP, que le résolveur refuserait. La règle le refuse aussi (relecture du 2026-10-02).
    { nom: 'mcp_mauvais_type', offrable: false, refus: 'inappelable', cause: 'source_inactive' },
    // Un outil de l'agent de Meta n'est pas dans la bibliothèque, et ne s'ouvre jamais à un agent IA.
    { nom: 'maison_meta', offrable: false, refus: 'reserve_agent_meta', cause: null },
  ];

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    catalogue = new PgToolCatalog(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-regle-unique') returning id`)).rows[0]!.id;
    autreTenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-regle-unique-autre') returning id`)).rows[0]!.id;
    adminId = (await pool.query<{ id: string }>(
      `insert into users (tenant_id, email, role, password_hash) values ($1, 'itest-regle-unique@example.test', 'admin', 'x') returning id`,
      [tenantId],
    )).rows[0]!.id;
    const agent = async (label: string): Promise<string> => (await pool.query<{ id: string }>(
      `insert into agents (tenant_id, label, mention_ia, modele) values ($1, $2, 'IA', 'm') returning id`, [tenantId, label],
    )).rows[0]!.id;
    agentId = await agent('itest-regle');
    agentActivation = await agent('itest-regle-activation');

    const source = async (kind: 'mcp' | 'http', status: string, label: string): Promise<string> => (await pool.query<{ id: string }>(
      `insert into agent_tool_sources (tenant_id, kind, label, base_url, auth_kind, status)
       values ($1, $2, $3, 'https://exemple.test', 'none', $4) returning id`, [tenantId, kind, label, status],
    )).rows[0]!.id;
    const mcpActive = await source('mcp', 'active', 'itest-mcp-actif');
    const mcpBrouillon = await source('mcp', 'draft', 'itest-mcp-brouillon');
    const mcpEteint = await source('mcp', 'disabled', 'itest-mcp-eteint');
    const httpActive = await source('http', 'active', 'itest-http-actif');
    const httpEteint = await source('http', 'disabled', 'itest-http-eteint');
    const httpBrouillon = await source('http', 'draft', 'itest-http-brouillon');
    ids.httpActive = httpActive;
    ids.httpEteint = httpEteint;
    ids.httpBrouillon = httpBrouillon;
    const requete = async (src: string, label: string): Promise<string> => (await pool.query<{ id: string }>(
      `insert into connector_requests (tenant_id, source_id, label, method, path, output_paths)
       values ($1, $2, $3, 'GET', '/x', array['statut']) returning id`, [tenantId, src, label],
    )).rows[0]!.id;
    ids.rqActive = await requete(httpActive, 'itest-rq-actif');
    ids.rqEteinte = await requete(httpEteint, 'itest-rq-eteinte');
    ids.rqBrouillon = await requete(httpBrouillon, 'itest-rq-brouillon');

    const outil = async (name: string, o: {
      origin: 'mcp' | 'http' | 'mba'; source?: string | null; requete?: string | null; propose?: boolean;
      nonActivable?: string | null; disparu?: boolean; pourAgentMeta?: boolean; tenant?: string; sansKind?: boolean;
    }): Promise<string> => (await pool.query<{ id: string }>(
      `insert into agent_tools (tenant_id, origin, source_id, source_kind, request_id, name, title, description,
                                ne_pas_utiliser, risk, mcp_propose, mcp_non_activable, mcp_indisponible_le,
                                pour_agent_meta, binding)
       values ($1, $2, $3, $4, $5, $6, $6, 'd', '', 'read', $7, $8, case when $9::boolean then now() end, $10, $11::jsonb)
       returning id`,
      [o.tenant ?? tenantId, o.origin, o.source ?? null, o.origin === 'mba' || o.sansKind ? null : o.origin, o.requete ?? null, name,
        o.propose ?? true, o.nonActivable ?? null, o.disparu ?? false, o.pourAgentMeta ?? false,
        JSON.stringify(o.origin === 'mba' ? { handler: 'tag_fixe', tag: 'vip' } : {})],
    )).rows[0]!.id;
    ids.mcp_vivant = await outil('mcp_vivant', { origin: 'mcp', source: mcpActive });
    ids.mcp_decoche = await outil('mcp_decoche', { origin: 'mcp', source: mcpActive, propose: false });
    ids.mcp_non_activable = await outil('mcp_non_activable', { origin: 'mcp', source: mcpActive, nonActivable: 'le paramètre tags est une liste' });
    ids.mcp_disparu = await outil('mcp_disparu', { origin: 'mcp', source: mcpActive, disparu: true });
    ids.mcp_brouillon = await outil('mcp_brouillon', { origin: 'mcp', source: mcpBrouillon });
    ids.mcp_eteint = await outil('mcp_eteint', { origin: 'mcp', source: mcpEteint });
    ids.http_vivant = await outil('http_vivant', { origin: 'http', source: httpActive, requete: ids.rqActive });
    ids.http_eteint = await outil('http_eteint', { origin: 'http', source: httpEteint, requete: ids.rqEteinte });
    ids.http_requete_eteinte = await outil('http_requete_eteinte', { origin: 'http', source: httpActive, requete: ids.rqEteinte });
    ids.maison_meta = await outil('maison_meta', { origin: 'mba', pourAgentMeta: true });
    ids.mcp_mauvais_type = await outil('mcp_mauvais_type', { origin: 'mcp', source: httpActive, sansKind: true });
    ids.mcp_course = await outil('mcp_course', { origin: 'mcp', source: mcpActive });
    // Un outil de BIBLIOTHÈQUE (MCP, vivant) d'un autre espace : seul le filtre d'espace peut l'écarter.
    const mcpAilleurs = (await pool.query<{ id: string }>(
      `insert into agent_tool_sources (tenant_id, kind, label, base_url, auth_kind, status)
       values ($1, 'mcp', 'itest-mcp-ailleurs', 'https://exemple.test', 'none', 'active') returning id`, [autreTenantId],
    )).rows[0]!.id;
    ids.ailleurs = await outil('mcp_ailleurs', { origin: 'mcp', source: mcpAilleurs, tenant: autreTenantId });
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    if (autreTenantId) await pool.query('delete from tenants where id = $1', [autreTenantId]);
    await pool.end();
  });

  /** Retire un rattachement sans passer par `detacher`, qui effacerait un connecteur HTTP resté sans consommateur. */
  const oublier = async (id: string, consommateur: string): Promise<void> => {
    await pool.query('delete from agent_tool_consommateurs where tenant_id = $1 and tool_id = $2 and consommateur = $3',
      [tenantId, id, consommateur]);
  };

  it.each(CAS)('$nom : offert, refusé et signalé de la même façon partout', async ({ nom, offrable, refus, cause }) => {
    const id = ids[nom]!;
    // Ce qu'on offre : la même réponse pour un agent IA et pour l'agent de Meta.
    expect((await catalogue.offrablesPour(tenantId, consommateurAgent(agentId))).some((o) => o.id === id)).toBe(offrable);
    expect((await catalogue.offrablesPour(tenantId, MBA)).some((o) => o.id === id)).toBe(offrable);
    // La cause portée par la bibliothèque (un outil de l'agent de Meta n'y est pas).
    const ligne = (await catalogue.listCatalogue(tenantId)).find((o) => o.id === id);
    if (nom !== 'maison_meta') expect(ligne?.inappelable?.cause ?? null).toBe(cause);
    // La porte : ce qui n'est pas offert ne se rattache pas, et le refus dit pourquoi.
    const r = await catalogue.rattacher(tenantId, agentId, id);
    expect(r.ok ? 'ok' : r.refus).toBe(refus);
    if (!r.ok && r.refus === 'inappelable') expect(r.inappelable.cause).toBe(cause);
    // Rien n'est écrit sur un refus.
    const lie = await pool.query('select 1 from agent_tool_consommateurs where tool_id = $1 and consommateur = $2',
      [id, consommateurAgent(agentId)]);
    expect((lie.rowCount ?? 0) > 0).toBe(r.ok);
    if (r.ok) await oublier(id, consommateurAgent(agentId));
  });

  it.each(CAS.filter((c) => c.nom !== 'maison_meta'))('$nom : l’activation et ce que voit le modèle suivent la même cause', async ({ nom, cause }) => {
    const id = ids[nom]!;
    const conso = consommateurAgent(agentActivation);
    // Rattaché par la base, hors de la porte : c'est le cas d'un outil donné vivant, qui meurt ensuite.
    await pool.query('insert into agent_tool_consommateurs (tenant_id, tool_id, consommateur, tool_name) values ($1, $2, $3, (select name from agent_tools where id = $2))', [tenantId, id, conso]);
    if (cause === null) {
      expect(await catalogue.activerConsommateur(tenantId, conso, id, true, adminId)).not.toBeNull();
    } else {
      await expect(catalogue.activerConsommateur(tenantId, conso, id, true, adminId)).rejects.toBeInstanceOf(OutilNonActivable);
      // Activé avant de mourir : la base le garde actif, l'écran le signale, le modèle ne le voit plus.
      await pool.query(
        `update agent_tool_consommateurs set actif = true, active_par = $3, active_le = now()
          where tenant_id = $1 and tool_id = $2 and consommateur = $4`, [tenantId, id, adminId, conso]);
    }
    expect((await catalogue.listActifs(tenantId, agentActivation)).some((o) => o.id === id)).toBe(cause === null);
    // Le relais de l'agent de Meta lit la liste NON filtrée : il doit trouver l'outil pour le refuser avec ses gardes.
    expect((await catalogue.listActifsConsommateur(tenantId, conso)).some((o) => o.id === id)).toBe(true);
    // La ligne d'écran porte la même cause.
    expect((await catalogue.listToutes(tenantId, agentActivation)).find((o) => o.id === id)?.inappelable?.cause ?? null).toBe(cause);
    // Désactiver reste toujours possible : c'est le seul geste qui reste au client sur un outil mort.
    expect(await catalogue.activerConsommateur(tenantId, conso, id, false, adminId)).not.toBeNull();
    await oublier(id, conso);
  });

  it('🔴 déjà rattaché : refusé avec sa raison, et plus offert à CE consommateur ; un autre numéro n’y change rien', async () => {
    const id = ids.mcp_vivant!;
    expect(await catalogue.rattacherConsommateur(tenantId, MBA, id)).toEqual({ ok: true });
    expect(await catalogue.rattacherConsommateur(tenantId, MBA, id)).toEqual({ ok: false, refus: 'deja_rattache' });
    expect((await catalogue.offrablesPour(tenantId, MBA)).some((o) => o.id === id)).toBe(false);
    // Le consentement est par consommateur : rattaché à un numéro, l'outil reste offert à un autre.
    expect((await catalogue.offrablesPour(tenantId, consommateurMba('900000000000102'))).some((o) => o.id === id)).toBe(true);
    await oublier(id, MBA);
  });

  it('🔴 un agent supprimé, ou un outil d’un autre espace, sont nommés comme tels', async () => {
    expect(await catalogue.rattacherConsommateur(tenantId, 'agent:00000000-0000-4000-8000-000000000000', ids.mcp_vivant!))
      .toEqual({ ok: false, refus: 'agent_introuvable' });
    expect(await catalogue.rattacher(tenantId, agentId, ids.ailleurs!)).toEqual({ ok: false, refus: 'introuvable' });
  });

  it('🔴 un outil de bibliothèque d’un AUTRE espace n’est ni listé ni offert', async () => {
    // Vivant, MCP, enregistré : rien d'autre que le filtre d'espace ne l'écarte (relecture du 2026-10-02).
    expect((await catalogue.listCatalogue(tenantId)).some((o) => o.id === ids.ailleurs)).toBe(false);
    expect((await catalogue.offrablesPour(tenantId, consommateurAgent(agentId))).some((o) => o.id === ids.ailleurs)).toBe(false);
    expect((await catalogue.offrablesPour(tenantId, MBA)).some((o) => o.id === ids.ailleurs)).toBe(false);
    // La preuve inverse : dans SON espace, il est bien offert.
    expect((await catalogue.offrablesPour(autreTenantId, MBA)).some((o) => o.id === ids.ailleurs)).toBe(true);
  });

  /**
   * 🔴 LA COURSE AVEC UN DÉSENREGISTREMENT (relecture du 2026-10-02 : ce test n'existait pas). `PgMcpStore.proposer`
   * verrouille l'outil en `for update` avant de décocher `mcp_propose`. La porte le lit en `for key share` : elle
   * ATTEND, puis relit la ligne commitée et refuse. Sans ce verrou, elle lisait l'ancienne version et rattachait un
   * outil qu'on venait de retirer aux agents.
   */
  it('🔴 un désenregistrement qui passe pendant un rattachement le fait refuser, jamais l’inverse', async () => {
    const id = ids.mcp_course!;
    const autre = await pool.connect();
    try {
      await autre.query('begin');
      await autre.query('select 1 from agent_tools where tenant_id = $1 and id = $2 for update', [tenantId, id]);
      await autre.query('update agent_tools set mcp_propose = false where tenant_id = $1 and id = $2', [tenantId, id]);
      const enCours = catalogue.rattacher(tenantId, agentId, id);
      enCours.catch(() => {});
      let attend = false;
      for (let i = 0; i < 200 && !attend; i += 1) {
        const r = await pool.query(
          `select 1 from pg_stat_activity
            where wait_event_type = 'Lock' and datname = current_database() and pid <> pg_backend_pid()`,
        );
        attend = (r.rowCount ?? 0) > 0;
        if (!attend) await new Promise((ok) => setTimeout(ok, 25));
      }
      expect(attend, 'le rattachement ne s’est pas bloqué : le test ne prouverait rien').toBe(true);
      await autre.query('commit');
      expect(await enCours).toEqual({ ok: false, refus: 'non_enregistre' });
    } catch (err) {
      await autre.query('rollback').catch(() => {});
      throw err;
    } finally {
      autre.release();
    }
    const lie = await pool.query('select 1 from agent_tool_consommateurs where tool_id = $1', [id]);
    expect(lie.rowCount).toBe(0);
  });

  it('🔴 un connecteur de l’agent de Meta sur une source éteinte ou en brouillon est refusé AVANT d’être créé', async () => {
    const compter = async (): Promise<number> =>
      Number((await pool.query<{ n: string }>('select count(*) as n from agent_tools where tenant_id = $1', [tenantId])).rows[0]!.n);
    const avant = await compter();
    for (const [source, requete] of [[ids.httpEteint!, ids.rqEteinte!], [ids.httpBrouillon!, ids.rqBrouillon!]]) {
      await expect(catalogue.ajouterConnecteurPourMba(tenantId, NUMERO, {
        sourceId: source!, requestId: requete!, name: 'http_refuse', title: 'T', description: 'd', nePasUtiliser: '',
        risk: 'read',
      })).rejects.toBeInstanceOf(OutilNonActivable);
    }
    expect(await compter()).toBe(avant);
    // Sur une source active, il se crée comme avant.
    const cree = await catalogue.ajouterConnecteurPourMba(tenantId, NUMERO, {
      sourceId: ids.httpActive!, requestId: ids.rqActive!, name: 'http_accepte', title: 'T', description: 'd', nePasUtiliser: '',
      risk: 'read',
    });
    expect(cree?.inappelable).toBeNull();
  });
});
