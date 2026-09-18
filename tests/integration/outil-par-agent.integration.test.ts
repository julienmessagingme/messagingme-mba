import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgToolCatalog } from '../../src/agent/catalog.pg';
import { NomOutilDejaPris } from '../../src/agent/catalog';

const url = process.env.DATABASE_URL ?? '';

/**
 * UNE ACTION APPARTIENT À L'AGENT, UN CONNECTEUR APPARTIENT À L'ESPACE (migration 0157).
 *
 * 🔴 CE QUE ÇA RÉPARE, ET C'EST JULIEN QUI L'A HEURTÉ. Le nom d'un outil était unique par ESPACE depuis
 * 0127 : donner « Terminer par une règle d'arrêt » à un second agent rendait « un outil de cet espace porte
 * déjà ce nom », sans aucun chemin pour s'en sortir. C'était juste pour un connecteur, qui se partage, et
 * faux pour une action, qui est une décision propre à un agent.
 *
 * 🔴 POURQUOI EN INTÉGRATION, ET PAS AUTREMENT. Tout ce qui est vérifié ici vit DANS LA BASE et nulle part
 * ailleurs : deux index partiels dont les prédicats doivent rester complémentaires, un CHECK qui lie
 * `agent_id` à `origin`, et un `on delete cascade` qui doit emporter les actions d'un agent supprimé SANS
 * toucher aux définitions d'espace. Un test unitaire monte son propre faux câblage et ne verrait aucun des
 * quatre.
 *
 * ⚠️ MESURÉ AVANT D'ÉCRIRE LA MIGRATION : l'espace de production portait 7 définitions d'action, ZÉRO
 * consommateur et ZÉRO active. Il n'y avait donc rien à reprendre, et la migration n'en reprend rien.
 */
describe.skipIf(!url)('une action appartient à l’agent (Postgres)', () => {
  let pool: Pool;
  let catalogue: PgToolCatalog;
  let tenantId: string;
  let agentA: string;
  let agentB: string;
  let sourceHttp: string;

  const outil = (name: string) => ({
    handler: 'terminer', name, title: 'Terminer', description: 'Termine.', nePasUtiliser: '',
    params: [], risk: 'read' as const,
  });

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    catalogue = new PgToolCatalog(pool);
    tenantId = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-outil-par-agent') returning id`,
    )).rows[0]!.id;
    // ⚠️ `mention_ia` et `modele` sont NOT NULL SANS défaut (0086) : les omettre ferait échouer tout le
    // fichier dans son `beforeAll`, sur un 23502 qui ne dit pas de quoi il parle.
    const creerAgent = async (label: string) => (await pool.query<{ id: string }>(
      `insert into agents (tenant_id, label, fiche, mention_ia, modele)
       values ($1, $2, $3::jsonb, 'Je suis une IA.', 'test/modele') returning id`,
      [tenantId, label, JSON.stringify({ objectif: 'aider' })],
    )).rows[0]!.id;
    agentA = await creerAgent('itest-a');
    agentB = await creerAgent('itest-b');
    // ⚠️ UNE VRAIE SOURCE, parce que `agent_tools_origin_src_chk` (0088) EXIGE un `source_id` des qu'on
    // sort de `origin = 'mba'`. Sans elle, les deux cas de connecteur ci-dessous echouent sur CETTE
    // contrainte-la, et l'un d'eux passait meme pour la mauvaise raison : le bon code `23514`, leve par la
    // mauvaise contrainte. Une sonde qui ne discrimine pas confirme ce qu'on croyait.
    sourceHttp = (await pool.query<{ id: string }>(
      `insert into agent_tool_sources (tenant_id, kind, label, base_url, auth_kind, status)
       values ($1, 'http', 'itest-src', 'https://exemple.test/api', 'none', 'active') returning id`,
      [tenantId],
    )).rows[0]!.id;
  });

  afterAll(async () => {
    // La cascade du tenant emporte agents, outils et consommateurs : on ne laisse rien derrière nous.
    if (pool) {
      await pool.query('delete from tenants where id = $1', [tenantId]);
      await pool.end();
    }
  });

  it('🔴 DEUX agents du même espace peuvent chacun avoir un outil du MÊME nom', () => expect(
    (async () => {
      const a = await catalogue.ajouter(tenantId, agentA, outil('terminer'));
      const b = await catalogue.ajouter(tenantId, agentB, outil('terminer'));
      return [a?.name, b?.name, a?.id === b?.id];
    })(),
  ).resolves.toEqual(['terminer', 'terminer', false]));

  it('🔴 le MÊME agent ne peut pas avoir deux fois le même nom', async () => {
    // La preuve inverse. Sans elle, avoir simplement RETIRÉ l'unicité passerait le test précédent tout en
    // laissant un agent exposer au modèle deux outils portant le même nom, ce qu'aucune API n'accepte.
    await expect(catalogue.ajouter(tenantId, agentA, outil('terminer'))).rejects.toBeInstanceOf(NomOutilDejaPris);
  });

  it('🔴 l’action porte bien son `agent_id`, ce n’est pas une définition d’espace', async () => {
    const r = await pool.query<{ agent_id: string | null }>(
      `select agent_id from agent_tools where tenant_id = $1 and name = 'terminer' and agent_id = $2`,
      [tenantId, agentA],
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.agent_id).toBe(agentA);
  });

  it('🔴 la BIBLIOTHÈQUE de l’espace n’expose PAS les actions d’un agent', async () => {
    // Sans ce filtre, l'écran de l'agent B proposerait de BRANCHER le « terminer » de l'agent A, donc de
    // partager une définition qui ne se partage plus. C'est le défaut que ce lot vient corriger, réintroduit
    // par l'autre bout.
    const bib = await catalogue.listCatalogue(tenantId);
    expect(bib.filter((o) => o.name === 'terminer')).toEqual([]);
  });

  it('🔴 un CONNECTEUR ne peut pas appartenir à un agent', async () => {
    // Le CHECK, et il tient même contre un SQL écrit à la main un jour : un connecteur est déclaré dans
    // `Tools >` et se partage, lui donner un propriétaire le rendrait invisible des autres agents sans que
    // rien ne le dise.
    // 🔴 LA CONTRAINTE EST NOMMEE DANS L'ASSERTION, pas seulement son code : `23514` est le code de TOUT
    // CHECK, et cette table en porte plusieurs. Sans le nom, ce test passait en violant
    // `agent_tools_origin_src_chk` (0088) sans jamais atteindre la garde qu'il pretend verifier.
    await expect(pool.query(
      `insert into agent_tools (tenant_id, agent_id, origin, source_id, name, title, description, ne_pas_utiliser, risk)
       values ($1, $2, 'http', $3, 'lire_commande', 'Lire', 'lit', '', 'read')`,
      [tenantId, agentA, sourceHttp],
    )).rejects.toMatchObject({ code: '23514', constraint: 'agent_tools_agent_origin_chk' });
  });

  it('⚠️ l’unicité par ESPACE tient toujours pour une définition SANS agent', async () => {
    // Les deux index partiels ont des prédicats COMPLÉMENTAIRES : retirer l'unicité d'un régime en la
    // retirant à l'autre est l'erreur qu'on ne verrait qu'en production, au deuxième connecteur du client.
    await pool.query(
      `insert into agent_tools (tenant_id, origin, source_id, name, title, description, ne_pas_utiliser, risk)
       values ($1, 'http', $2, 'lire_commande', 'Lire', 'lit', '', 'read')`,
      [tenantId, sourceHttp],
    );
    await expect(pool.query(
      `insert into agent_tools (tenant_id, origin, source_id, name, title, description, ne_pas_utiliser, risk)
       values ($1, 'http', $2, 'lire_commande', 'Lire encore', 'lit', '', 'read')`,
      [tenantId, sourceHttp],
    )).rejects.toMatchObject({ code: '23505' });
  });

  it('🔴 supprimer un AGENT emporte ses actions, et ne touche pas aux définitions d’espace', async () => {
    // 🔴 LE `on delete cascade` ÉTAIT LE MAUVAIS CHOIX EN 0086 ET C'EST LE BON ICI, parce que la propriété a
    // changé de sens : en 0086 il détruisait des définitions que PLUSIEURS agents partageaient, aujourd'hui
    // il emporte une action qui n'appartient qu'à cet agent-là. La laisser derrière créerait un orphelin
    // que rien ne nettoierait jamais.
    await pool.query('delete from agents where id = $1', [agentB]);
    const restantes = await pool.query<{ n: string }>(
      `select count(*) as n from agent_tools where tenant_id = $1 and agent_id = $2`, [tenantId, agentB],
    );
    expect(restantes.rows[0]!.n).toBe('0');
    const espace = await pool.query<{ n: string }>(
      `select count(*) as n from agent_tools where tenant_id = $1 and agent_id is null`, [tenantId],
    );
    expect(espace.rows[0]!.n).toBe('1');
    // Et l'action de l'agent A, lui bien vivant, n'a pas bougé.
    const a = await pool.query<{ n: string }>(
      `select count(*) as n from agent_tools where tenant_id = $1 and agent_id = $2`, [tenantId, agentA],
    );
    expect(a.rows[0]!.n).toBe('1');
  });

  /**
   * LES GESTES (migration 0158), ALLER-RETOUR CONTRE UNE VRAIE BASE.
   *
   * 🔴 POURQUOI EN INTÉGRATION. Trois choses ne se vérifient que là : que le jsonb fait l'aller-retour sans
   * se faire réinterpréter par le pilote, que le `coalesce` du patch distingue « tableau vide » (un
   * effacement VOULU) de « absent » (ce patch ne parle pas des gestes), et que le repli de lecture tient sur
   * un contenu que rien n'empêche d'écrire en SQL direct un jour.
   */
  it('🔴 les gestes font l’aller-retour, et un tableau VIDE efface quand ABSENT ne touche à rien', async () => {
    const o = await catalogue.ajouter(tenantId, agentA, outil('avec_gestes'));
    await catalogue.patch(tenantId, agentA, o!.id, {
      gestes: [{ type: 'tag', valeur: 'rdv_demande' }, { type: 'variable', champ: 'origine', valeur: 'agent' }],
    });
    expect((await catalogue.byName(tenantId, agentA, 'avec_gestes'))?.gestes).toEqual([
      { type: 'tag', valeur: 'rdv_demande' },
      { type: 'variable', champ: 'origine', valeur: 'agent' },
    ]);

    // ABSENT : le patch ne parle pas des gestes, ils ne bougent pas.
    await catalogue.patch(tenantId, agentA, o!.id, { description: 'autre chose' });
    expect((await catalogue.byName(tenantId, agentA, 'avec_gestes'))?.gestes).toHaveLength(2);

    // VIDE : le client les a tous retirés, et c'est un choix qui doit s'écrire.
    await catalogue.patch(tenantId, agentA, o!.id, { gestes: [] });
    expect((await catalogue.byName(tenantId, agentA, 'avec_gestes'))?.gestes).toEqual([]);
  });

  it('🔴 un contenu ILLISIBLE rend AUCUN geste, jamais une exception', async () => {
    // Un jsonb corrompu ne doit pas rendre un agent muet sur le chemin de chaque message : il doit ne
    // produire aucun geste. Écrit en SQL direct, parce que c'est précisément le chemin que le schéma Zod ne
    // garde pas.
    await pool.query(
      `update agent_tools set gestes = '[{"type":"inconnu"}]'::jsonb where tenant_id = $1 and name = 'avec_gestes'`,
      [tenantId],
    );
    expect((await catalogue.byName(tenantId, agentA, 'avec_gestes'))?.gestes).toEqual([]);
  });

  it('⚠️ la base refuse ce qui n’est pas un TABLEAU, seule forme qu’elle sait garantir', async () => {
    // Le CHECK ne décrit PAS la forme d'un geste : ce serait une seconde vérité à côté du schéma Zod, et les
    // deux divergeraient au premier type ajouté. Il garantit ce qu'une base sait garantir.
    await expect(pool.query(
      `update agent_tools set gestes = '{"type":"tag"}'::jsonb where tenant_id = $1 and name = 'avec_gestes'`,
      [tenantId],
    )).rejects.toMatchObject({ code: '23514', constraint: 'agent_tools_gestes_tableau_chk' });
  });
});
