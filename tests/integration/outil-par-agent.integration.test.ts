import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
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
    // 🔴 ET LE MESSAGE DIT « AGENT », PAS « ESPACE » (revue finale du 2026-09-18). C'est la phrase exacte
    // dont Julien demandait ce qu'elle voulait dire : 0157 a corrigé le conflit, le message désignait encore
    // l'espace et envoyait chercher chez le voisin un outil qui est chez soi. La portée est lue sur la
    // contrainte violée, donc elle ne peut pas dériver de la base.
    await expect(catalogue.ajouter(tenantId, agentA, outil('terminer')))
      .rejects.toThrow('un outil de cet agent porte déjà ce nom');
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
  /**
   * ⚠️ LA LECTURE PASSE PAR `listToutes`, PAS PAR `byName`, et la nuance a fait rougir la CI. `byName` filtre
   * sur `actif` (c'est son contrat : un outil éteint est indiscernable d'un outil absent, pour que le
   * runtime ne puisse pas invoquer ce que personne n'a activé), et `ajouter` crée l'outil ÉTEINT. Le test
   * lisait donc `null` et comparait `undefined`.
   */
  const lireGestesDe = async (nom: string) => (await catalogue.listToutes(tenantId, agentA))
    .find((o) => o.name === nom)?.gestes;

  it('🔴 les gestes font l’aller-retour, et un tableau VIDE efface quand ABSENT ne touche à rien', async () => {
    const o = await catalogue.ajouter(tenantId, agentA, outil('avec_gestes'));
    await catalogue.patch(tenantId, agentA, o!.id, {
      gestes: [{ type: 'tag', valeur: 'rdv_demande' }, { type: 'variable', champ: 'origine', valeur: 'agent' }],
    });
    expect(await lireGestesDe('avec_gestes')).toEqual([
      { type: 'tag', valeur: 'rdv_demande' },
      { type: 'variable', champ: 'origine', valeur: 'agent' },
    ]);

    // ABSENT : le patch ne parle pas des gestes, ils ne bougent pas.
    await catalogue.patch(tenantId, agentA, o!.id, { description: 'autre chose' });
    expect(await lireGestesDe('avec_gestes')).toHaveLength(2);

    // VIDE : le client les a tous retirés, et c'est un choix qui doit s'écrire.
    await catalogue.patch(tenantId, agentA, o!.id, { gestes: [] });
    expect(await lireGestesDe('avec_gestes')).toEqual([]);
  });

  it('🔴 un contenu ILLISIBLE rend AUCUN geste, jamais une exception', async () => {
    // Un jsonb corrompu ne doit pas rendre un agent muet sur le chemin de chaque message : il doit ne
    // produire aucun geste. Écrit en SQL direct, parce que c'est précisément le chemin que le schéma Zod ne
    // garde pas.
    await pool.query(
      `update agent_tools set gestes = '[{"type":"inconnu"}]'::jsonb where tenant_id = $1 and name = 'avec_gestes'`,
      [tenantId],
    );
    expect(await lireGestesDe('avec_gestes')).toEqual([]);
  });

  it('⚠️ la base refuse ce qui n’est pas un TABLEAU, seule forme qu’elle sait garantir', async () => {
    // Le CHECK ne décrit PAS la forme d'un geste : ce serait une seconde vérité à côté du schéma Zod, et les
    // deux divergeraient au premier type ajouté. Il garantit ce qu'une base sait garantir.
    await expect(pool.query(
      `update agent_tools set gestes = '{"type":"tag"}'::jsonb where tenant_id = $1 and name = 'avec_gestes'`,
      [tenantId],
    )).rejects.toMatchObject({ code: '23514', constraint: 'agent_tools_gestes_tableau_chk' });
  });

  /**
   * 🔴 LE CHECK STRICT DE 0159, ET IL NE POUVAIT PAS ÊTRE POSÉ EN 0157. C'est la leçon de 0152 appliquée
   * dans l'autre sens : 0157 a laissé `agent_id` nullable pour que le code DÉPLOYÉ, qui l'ignorait,
   * continue de créer ses définitions sans échouer. Une fois ce code remplacé, la contrainte se ferme.
   *
   * ⚠️ CE QU'ELLE ACHÈTE : `Tools >` n'a plus besoin de filtrer quoi que ce soit pour ne montrer que les
   * connecteurs, puisque plus aucune action ne peut y apparaître. Une garantie tenue par la base vaut mieux
   * qu'un `filter` dans un écran, que le prochain écran oubliera.
   */
  it('🔴 une ACTION au niveau de l’ESPACE est désormais REFUSÉE par la base', async () => {
    await expect(pool.query(
      `insert into agent_tools (tenant_id, origin, name, title, description, ne_pas_utiliser, risk)
       values ($1, 'mba', 'orpheline', 'O', 'o', '', 'read')`,
      [tenantId],
    )).rejects.toMatchObject({ code: '23514', constraint: 'agent_tools_action_par_agent_chk' });
  });

  it('⚠️ un CONNECTEUR au niveau de l’espace reste parfaitement légitime', async () => {
    // La preuve inverse : le CHECK ne doit pas déborder sur ce qui se partage vraiment. Sans elle, on
    // pourrait fermer la contrainte sur `agent_id is not null` tout court et rendre `Tools >` inutilisable.
    await expect(pool.query(
      `insert into agent_tools (tenant_id, origin, source_id, name, title, description, ne_pas_utiliser, risk)
       values ($1, 'http', $2, 'connecteur_espace', 'C', 'c', '', 'read')`,
      [tenantId, sourceHttp],
    )).resolves.toBeTruthy();
  });

  /**
   * 🔴 DÉTACHER UNE ACTION LA SUPPRIME (revue finale du 2026-09-18).
   *
   * Conséquence non vue de 0157, et c'est le cul-de-sac que ce lot corrigeait, reproduit un cran plus bas.
   * La bibliothèque de l'espace exclut désormais les actions d'agent, or c'est le SEUL écran d'où l'on
   * supprime une définition. Détacher ne retirait que le consentement : la définition survivait, invisible
   * de partout, ineffaçable, et son nom restait pris pour cet agent. Recréer le même outil rendait 409.
   *
   * ⚠️ LES DEUX SENS SONT ICI, et le second est celui qui empêche de « corriger » en supprimant toujours.
   */
  it('🔴 détacher une ACTION efface sa définition, et le nom redevient libre', async () => {
    const cree = await catalogue.ajouter(tenantId, agentA, outil('jetable'));
    expect(cree).not.toBeNull();
    expect(await catalogue.detacher(tenantId, agentA, cree!.id)).toBe(true);
    // Ni consentement, ni définition : rien d'orphelin derrière.
    const reste = await pool.query(
      'select 1 from agent_tools where tenant_id = $1 and id = $2', [tenantId, cree!.id],
    );
    expect(reste.rowCount).toBe(0);
    // Et la preuve qui compte pour le client : il peut le recréer. Sans le correctif, 409 sans issue.
    await expect(catalogue.ajouter(tenantId, agentA, outil('jetable'))).resolves.not.toBeNull();
  });

  it('⚠️ détacher un CONNECTEUR ne supprime RIEN : il appartient à l’espace et se partage', async () => {
    // Posé en SQL direct : ce qui est éprouvé ici est le geste de DÉTACHEMENT, pas la création d'un
    // connecteur, qui a sa propre suite et demanderait en plus une requête de la bibliothèque.
    const id = (await pool.query<{ id: string }>(
      `insert into agent_tools (tenant_id, origin, source_id, name, title, description, ne_pas_utiliser, risk)
       values ($1, 'http', $2, 'connecteur_partage', 'C', 'c', '', 'read') returning id`,
      [tenantId, sourceHttp],
    )).rows[0]!.id;
    await pool.query(
      'insert into agent_tool_consommateurs (tenant_id, tool_id, consommateur) values ($1, $2, $3)',
      [tenantId, id, `agent:${agentA}`],
    );
    expect(await catalogue.detacher(tenantId, agentA, id)).toBe(true);
    const reste = await pool.query(
      'select 1 from agent_tools where tenant_id = $1 and id = $2', [tenantId, id],
    );
    // Il DOIT survivre : le supprimer au premier détachement le ferait disparaître pour tous les autres
    // agents, et c'est exactement ce que 0127 avait corrigé.
    expect(reste.rowCount).toBe(1);
  });

  /**
   * 🔴 L'ADOPTION DE 0159, JOUÉE DEPUIS LE FICHIER DE MIGRATION LUI-MÊME (revue finale du 2026-09-18).
   *
   * Le défaut réparé était dans la MESURE de la migration, pas dans son `delete` : elle ne comptait que les
   * lignes qu'elle allait supprimer, ce qui ne répond pas à la question que pose son CHECK. Le code DÉPLOYÉ
   * crée une action `origin='mba'` SANS `agent_id` et AVEC un consommateur : une action créée d'ici au
   * déploiement survivait donc au `delete` et violait le CHECK. L'`alter table` échouait en fin de
   * déploiement, sur une donnée qu'aucune des requêtes de contrôle ne montrait.
   *
   * ⚠️ IL LIT LE `.sql`, IL NE RECOPIE PAS LA REQUÊTE. Une copie divergerait du jour où l'on retoucherait la
   * migration, et le test continuerait de passer en éprouvant du SQL que personne n'applique.
   *
   * ⚠️ ET IL ROULE DANS UNE TRANSACTION ANNULÉE, contrainte comprise : l'état qu'il répare ne peut plus
   * exister une fois 0159 appliquée, donc il faut rouvrir la porte le temps de la sonde, et la refermer même
   * si l'assertion échoue.
   */
  it('🔴 une action créée par l’ANCIEN code est ADOPTÉE par son consommateur, pas supprimée', async () => {
    const sql = readFileSync(new URL('../../db/migrations/0159_actions_orphelines.sql', import.meta.url), 'utf8');
    const debut = sql.indexOf('update agent_tools');
    const adoption = sql.slice(debut, sql.indexOf(';', debut) + 1);
    expect(adoption).toContain('agent_tool_consommateurs'); // la requête a bien été trouvée

    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('alter table agent_tools drop constraint agent_tools_action_par_agent_chk');
      // EXACTEMENT ce que l'ancien `ajouter` écrit : pas d'`agent_id`, et une ligne de consentement.
      const id = (await client.query<{ id: string }>(
        `insert into agent_tools (tenant_id, origin, name, title, description, ne_pas_utiliser, risk)
         values ($1, 'mba', 'creee_par_l_ancien_code', 'T', 't', '', 'read') returning id`,
        [tenantId],
      )).rows[0]!.id;
      await client.query(
        'insert into agent_tool_consommateurs (tenant_id, tool_id, consommateur) values ($1, $2, $3)',
        [tenantId, id, `agent:${agentB}`],
      );

      await client.query(adoption);

      const apres = await client.query<{ agent_id: string | null }>(
        'select agent_id from agent_tools where id = $1', [id],
      );
      // Adoptée par l'agent que sa ligne de consentement désignait, donc le CHECK peut se refermer.
      expect(apres.rows[0]!.agent_id).toBe(agentB);
      await client.query(
        `alter table agent_tools add constraint agent_tools_action_par_agent_chk
           check (origin <> 'mba' or agent_id is not null)`,
      );
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
});
