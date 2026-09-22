import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgToolCatalog } from '../../src/agent/catalog.pg';
import { PgAgentStore } from '../../src/agent/agent-store.pg';
import { NomOutilDejaPris } from '../../src/agent/catalog';
import { consommateurMba, consommateurAgent } from '../../src/agent/consommateur';
import { PgMcpStore } from '../../src/agent/mcp/store.pg';
import { PgKnowledgeStore } from '../../src/agent/knowledge.pg';
import type { OutilAImporter } from '../../src/agent/mcp/import';
import { randomUUID } from 'node:crypto';

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
   * ⚠️ Le filtre porte sur `agent`, pas sur `agent_tool` : selon l'ordre de ses verrous, `PgAgentStore.remove`
   * attend sur les sessions de l'agent, sur ses définitions, ou (dans un ancien ordre) sur `delete from agents`.
   * Un filtre plus étroit a fait échouer le test du journal quel que soit l'ordre, à 5 s.
   */
  const attendreUnVerrou = async (): Promise<void> => {
    for (let i = 0; i < 200; i += 1) {
      const r = await pool.query(
        `select 1 from pg_stat_activity
          where wait_event_type = 'Lock' and datname = current_database() and pid <> pg_backend_pid()
            and query ilike '%agent%'`,
      );
      if ((r.rowCount ?? 0) > 0) return;
      await new Promise((ok) => setTimeout(ok, 25));
    }
    throw new Error('aucune connexion ne s’est bloquée sur un verrou : le test ne prouverait rien');
  };

  /**
   * Une connexion tenue HORS du magasin, le temps de jouer une course. ⚠️ Sur un échec, elle est ANNULÉE avant
   * d'être rendue au pool : rendue avec sa transaction ouverte, elle garderait ses verrous et `pool.end()`
   * resterait pendu (relecture du 2026-09-22).
   */
  const avecConnexion = async <T>(travail: (c: PoolClient) => Promise<T>): Promise<T> => {
    const c = await pool.connect();
    try {
      return await travail(c);
    } finally {
      await c.query('rollback').catch(() => {});
      c.release();
    }
  };

  /** Un consentement posé dans une transaction laissée OUVERTE, le temps de lancer l'effacement concurrent. */
  const rattachementEnCours = async (id: string, consommateur: string, effacement: () => Promise<unknown>) =>
    avecConnexion(async (autre) => {
      await autre.query('begin');
      await autre.query(
        'insert into agent_tool_consommateurs (tenant_id, tool_id, consommateur) values ($1, $2, $3)',
        [tenantId, id, consommateur],
      );
      const enCours = effacement();
      // Une promesse lancée et jamais attendue sur un échec deviendrait un rejet non géré.
      enCours.catch(() => {});
      await attendreUnVerrou();
      await autre.query('commit');
      return await enCours;
    });
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
    await avecConnexion(async (effaceur) => {
      await effaceur.query('begin');
      await effaceur.query('select 1 from agent_tools where tenant_id = $1 and id = $2 for update', [tenantId, id]);
      const rattachement = cat.rattacherConsommateur(tenantId, consommateurMba(PN), id);
      rattachement.catch(() => {});
      await attendreUnVerrou();
      await effaceur.query('delete from agent_tools where tenant_id = $1 and id = $2', [tenantId, id]);
      await effaceur.query('commit');
      expect(await rattachement).toBe(false);
    });
    expect(await existe(id)).toBe(false);
  });

  /** Un agent qui a une SESSION : il faut un scénario et un parcours, comme en production. */
  const agentAvecSession = async (label: string): Promise<{ agent: string; session: string }> => {
    const agent = (await pool.query<{ id: string }>(
      `insert into agents (tenant_id, label, mention_ia, modele) values ($1, $2, 'IA', 'm') returning id`,
      [tenantId, label],
    )).rows[0]!.id;
    const wf = (await pool.query<{ id: string }>(
      `insert into workflows (tenant_id, name) values ($1, $2) returning id`, [tenantId, `itest-${label}`],
    )).rows[0]!.id;
    const run = (await pool.query<{ id: string }>(
      `insert into workflow_runs (workflow_id, tenant_id, wa_id, current_node, status)
       values ($1, $2, '33600000009', 'a', 'waiting') returning id`, [wf, tenantId],
    )).rows[0]!.id;
    const session = (await pool.query<{ id: string }>(
      `insert into agent_sessions (tenant_id, run_id, agent_id, node_id, wa_id)
       values ($1, $2, $3, 'a', '33600000009') returning id`, [tenantId, run, agent],
    )).rows[0]!.id;
    return { agent, session };
  };

  /**
   * 🔴 L'INTERBLOCAGE AVEC LE JOURNAL (revue finale du 2026-09-21). Un appel de l'agent partant se journalise :
   * l'insert prend sa SESSION, puis l'OUTIL (l'ordre de ses clés étrangères). Avec le verrou des définitions posé
   * en TÊTE de `remove`, celui-ci tenait l'outil et attendait la session pour sa cascade, pendant que le journal
   * tenait la session et attendait l'outil : Postgres en tuait un (40P01). Rouge avec cet ordre-là.
   */
  it('🔴 supprimer un agent n’interbloque pas avec un appel qu’il est en train de journaliser', async () => {
    const { agent, session } = await agentAvecSession('partant-journal');
    const id = await connecteurNeuf('course_journal');
    expect(await cat.rattacherConsommateur(tenantId, consommateurAgent(agent), id)).toBe(true);
    const agents = new PgAgentStore(pool);
    await avecConnexion(async (journal) => {
      await journal.query('begin');
      await journal.query('select 1 from agent_sessions where id = $1 for key share', [session]);
      const suppression = agents.remove(tenantId, agent);
      suppression.catch(() => {});
      await attendreUnVerrou();
      await journal.query(
        `insert into agent_tool_calls (tenant_id, session_id, tool_id, tool_name, origin, status)
         values ($1, $2, $3, 'course_journal', 'http', 'ok')`,
        [tenantId, session, id],
      );
      await journal.query('commit');
      expect(await suppression).toBe(true);
    });
  });

  /**
   * 🔴 L'INTERBLOCAGE AVEC `detacher` (relecture du 2026-09-22). `detacher` verrouille la DÉFINITION, puis
   * retire la ligne de consentement. `remove` faisait l'inverse (il retirait ses consentements, puis
   * verrouillait) : chacun attendait ce que l'autre tenait. On rejoue `detacher` à la main pour tenir la
   * définition au bon moment. Rouge avec cet ordre-là.
   */
  it('🔴 supprimer un agent n’interbloque pas avec un détachement du même outil', async () => {
    const { agent } = await agentAvecSession('partant-detacher');
    const id = await connecteurNeuf('course_ordre');
    expect(await cat.rattacherConsommateur(tenantId, consommateurAgent(agent), id)).toBe(true);
    expect(await cat.rattacherConsommateur(tenantId, consommateurMba(PN), id)).toBe(true);
    const agents = new PgAgentStore(pool);
    await avecConnexion(async (detachement) => {
      await detachement.query('begin');
      await detachement.query('select 1 from agent_tools where tenant_id = $1 and id = $2 for update', [tenantId, id]);
      const suppression = agents.remove(tenantId, agent);
      suppression.catch(() => {});
      await attendreUnVerrou();
      await detachement.query(
        'delete from agent_tool_consommateurs where tenant_id = $1 and tool_id = $2 and consommateur = $3',
        [tenantId, id, consommateurAgent(agent)],
      );
      await detachement.query('commit');
      expect(await suppression).toBe(true);
    });
    // L'agent de Meta s'en sert encore : le connecteur reste.
    expect(await existe(id)).toBe(true);
    expect(await consommateursDe(id)).toEqual([consommateurMba(PN)]);
  });

  /**
   * 🔴 L'INTERBLOCAGE AVEC UN `detacher` QUI EFFACE LE CONNECTEUR (relecture du 2026-09-22). L'agent partant en
   * était le DERNIER utilisateur, et il l'a déjà appelé (une ligne de journal). `detacher` tient la définition,
   * retire le consentement, puis efface la définition : son `on delete set null` touche les appels journalisés.
   * Quand `remove` faisait sa cascade AVANT de verrouiller, il venait de supprimer ces appels et attendait la
   * définition : chacun attendait l'autre. Rouge avec cet ordre-là.
   */
  it('🔴 supprimer un agent n’interbloque pas avec un détachement qui EFFACE le connecteur', async () => {
    const { agent, session } = await agentAvecSession('partant-efface');
    const id = await connecteurNeuf('course_efface');
    expect(await cat.rattacherConsommateur(tenantId, consommateurAgent(agent), id)).toBe(true);
    await pool.query(
      `insert into agent_tool_calls (tenant_id, session_id, tool_id, tool_name, origin, status)
       values ($1, $2, $3, 'course_efface', 'http', 'ok')`,
      [tenantId, session, id],
    );
    const agents = new PgAgentStore(pool);
    await avecConnexion(async (detachement) => {
      await detachement.query('begin');
      await detachement.query('select 1 from agent_tools where tenant_id = $1 and id = $2 for update', [tenantId, id]);
      const suppression = agents.remove(tenantId, agent);
      suppression.catch(() => {});
      await attendreUnVerrou();
      await detachement.query(
        'delete from agent_tool_consommateurs where tenant_id = $1 and tool_id = $2 and consommateur = $3',
        [tenantId, id, consommateurAgent(agent)],
      );
      await detachement.query('delete from agent_tools where tenant_id = $1 and id = $2', [tenantId, id]);
      await detachement.query('commit');
      expect(await suppression).toBe(true);
    });
    expect(await existe(id)).toBe(false);
  });

  /**
   * 🔴 LE CONSOMMATEUR FANTÔME (relecture du 2026-09-22). Un rattachement ne regardait pas l'agent : pendant sa
   * suppression, il posait un consentement qui lui survivait, et le connecteur, qui garde alors un consommateur
   * pour toujours, n'était plus jamais effacé. Il attend désormais l'agent, puis rend `false`.
   */
  it('🔴 un rattachement pendant la suppression de son agent rend `false`, sans consommateur fantôme', async () => {
    const partant = (await pool.query<{ id: string }>(
      `insert into agents (tenant_id, label, mention_ia, modele) values ($1, 'itest-fantome', 'IA', 'm') returning id`,
      [tenantId],
    )).rows[0]!.id;
    const id = await connecteurNeuf('course_fantome');
    expect(await cat.rattacherConsommateur(tenantId, consommateurMba(PN), id)).toBe(true);
    await avecConnexion(async (suppression) => {
      await suppression.query('begin');
      await suppression.query('select 1 from agents where tenant_id = $1 and id = $2 for update', [tenantId, partant]);
      const rattachement = cat.rattacherConsommateur(tenantId, consommateurAgent(partant), id);
      rattachement.catch(() => {});
      await attendreUnVerrou();
      await suppression.query('delete from agents where tenant_id = $1 and id = $2', [tenantId, partant]);
      await suppression.query('commit');
      expect(await rattachement).toBe(false);
    });
    expect(await consommateursDe(id)).toEqual([consommateurMba(PN)]);
  });

  /**
   * 🔴 L'ORDRE DONT DÉPEND `PgAgentStore.remove`, FIGÉ. Le journal d'un appel doit prendre sa SESSION avant son
   * OUTIL : c'est l'ordre dans lequel se déclenchent les contrôles de ses deux clés étrangères, c'est-à-dire
   * l'ordre ALPHABÉTIQUE des noms de leurs déclencheurs, qui suit l'ordre de création des contraintes (0086).
   * Une migration qui recréerait la clé de `session_id` après celle de `tool_id` inverserait cet ordre sans
   * que rien d'autre ne le signale, et rouvrirait l'interblocage avec le journal.
   */
  it('🔴 le journal d’un appel vérifie sa session AVANT son outil', async () => {
    const r = await pool.query<{ conname: string }>(
      `select c.conname
         from pg_trigger t join pg_constraint c on c.oid = t.tgconstraint
        where t.tgrelid = 'agent_tool_calls'::regclass and t.tgfoid = '"RI_FKey_check_ins"'::regproc
        order by t.tgname`,
    );
    const noms = r.rows.map((x) => x.conname);
    const session = noms.findIndex((n) => n.includes('session_id'));
    const outil = noms.findIndex((n) => n.includes('tool_id'));
    expect(session).toBeGreaterThanOrEqual(0);
    expect(outil).toBeGreaterThanOrEqual(0);
    expect(session).toBeLessThan(outil);
  });

  const agentSeul = async (label: string): Promise<string> => (await pool.query<{ id: string }>(
    `insert into agents (tenant_id, label, mention_ia, modele) values ($1, $2, 'IA', 'm') returning id`,
    [tenantId, label],
  )).rows[0]!.id;

  /**
   * 🔴 CRÉER UN CONNECTEUR POUR UN AGENT QU'ON SUPPRIME (relecture du 2026-09-22). Même garde que le rattachement
   * (`verrouillerAgentDuConsommateur`) : sans elle, la création passait l'`exists` sur l'agent, créait le
   * connecteur (sans clé étrangère vers l'agent) et posait un consentement `agent:` qui survivait à l'agent.
   */
  it('🔴 créer un connecteur pour un agent qu’on supprime rend `null`, sans connecteur ni consommateur fantôme', async () => {
    const partant = await agentSeul('itest-fantome-creation');
    const requete = (await pool.query<{ id: string }>(
      `insert into connector_requests (tenant_id, source_id, label, method, path, output_paths)
       values ($1, $2, 'itest-creation', 'POST', '/x', '{}'::text[]) returning id`,
      [tenantId, sourceId],
    )).rows[0]!.id;
    await avecConnexion(async (suppression) => {
      await suppression.query('begin');
      await suppression.query('select 1 from agents where tenant_id = $1 and id = $2 for update', [tenantId, partant]);
      const creation = cat.ajouterConnecteur(tenantId, partant, {
        sourceId, requestId: requete, name: 'course_creation', title: 'x', description: 'x', nePasUtiliser: 'x',
        params: [], risk: 'write', nature: 'pousse', outputPaths: [],
      });
      creation.catch(() => {});
      await attendreUnVerrou();
      await suppression.query('delete from agents where tenant_id = $1 and id = $2', [tenantId, partant]);
      await suppression.query('commit');
      expect(await creation).toBeNull();
    });
    expect((await pool.query(`select 1 from agent_tools where tenant_id = $1 and name = 'course_creation'`, [tenantId])).rowCount).toBe(0);
  });

  /**
   * Une clé `agent:` que la forme de 0127 refuse (un identifiant en majuscules, que `estUuid` accepte) rendait
   * `true` à la garde de l'agent, puis levait sur le CHECK (23514, donc un 500). Elle rend désormais `false`.
   */
  it('une clé d’agent hors forme rend `false`, pas une erreur de contrainte', async () => {
    const id = await connecteurNeuf('cle_majuscules');
    expect(await cat.rattacherConsommateur(tenantId, `agent:${agentId.toUpperCase()}`, id)).toBe(false);
  });

  /** Deux identifiants dont l'ordre est CONNU, quel que soit le tirage : `bas` avant `haut`. */
  const deuxIdentifiants = (): { bas: string; haut: string } => {
    const u = randomUUID();
    return { bas: `0${u.slice(1)}`, haut: `f${u.slice(1)}` };
  };
  /**
   * Un serveur MCP et deux de ses outils, consentis (inactifs) par `agent`. ⚠️ `haut` est inséré AVANT `bas` : une
   * cascade ou un `update ... any` les prend dans l'ordre du parcours de table, donc `haut` d'abord, à l'inverse
   * de l'ordre des identifiants. C'est ce qui rend l'interblocage reproductible.
   */
  const serveurAvecDeuxOutils = async (label: string, agent: string) => {
    const source = (await pool.query<{ id: string }>(
      `insert into agent_tool_sources (tenant_id, kind, label, base_url, auth_kind, status)
       values ($1, 'mcp', $2, 'https://exemple.test/mcp', 'none', 'active') returning id`,
      [tenantId, label],
    )).rows[0]!.id;
    const ids = deuxIdentifiants();
    for (const [id, suffixe] of [[ids.haut, 'haut'], [ids.bas, 'bas']] as const) {
      await pool.query(
        `insert into agent_tools (id, tenant_id, origin, source_id, source_kind, name, title, description, ne_pas_utiliser, risk, binding)
         values ($1, $2, 'mcp', $3, 'mcp', $4, 'MCP', 'm', '', 'read', $5::jsonb)`,
        [id, tenantId, source, `${label}_${suffixe}`, JSON.stringify({ outilDistant: `${label}_${suffixe}` })],
      );
      await pool.query(
        'insert into agent_tool_consommateurs (tenant_id, tool_id, consommateur) values ($1, $2, $3)',
        [tenantId, id, consommateurAgent(agent)],
      );
    }
    return { source, ids };
  };

  /**
   * `PgAgentStore.remove` REJOUÉ À LA MAIN jusqu'à son verrou des définitions, qui les prend par identifiant :
   * l'agent, puis `bas`. Le chemin voisin est lancé à ce moment-là ; `remove` demande ensuite `haut`. Un voisin
   * qui a pris `haut` avant de demander `bas` interbloque (40P01).
   */
  const suppressionContre = async (agent: string, ids: { bas: string; haut: string }, voisin: () => Promise<unknown>) =>
    avecConnexion(async (suppression) => {
      await suppression.query('begin');
      await suppression.query('select 1 from agents where tenant_id = $1 and id = $2 for update', [tenantId, agent]);
      await suppression.query('select 1 from agent_tools where tenant_id = $1 and id = $2 for update', [tenantId, ids.bas]);
      const enCours = voisin();
      enCours.catch(() => {});
      await attendreUnVerrou();
      await suppression.query('select 1 from agent_tools where tenant_id = $1 and id = $2 for update', [tenantId, ids.haut]);
      await suppression.query('commit');
      return await enCours;
    });

  /**
   * 🔴 L'IMPORT D'UN SERVEUR MCP (relecture du 2026-09-22). Il ne triait que ses outils MODIFIÉS : un outil modifié
   * d'identifiant haut, puis un outil REVU d'identifiant bas, verrouillés dans cet ordre, interbloquaient avec la
   * suppression d'un agent qui les consent tous les deux. Rouge avant `verrouillerDefinitions` dans `appliquer`.
   */
  it('🔴 supprimer un agent n’interbloque pas avec l’import de son serveur MCP', async () => {
    const agent = await agentSeul('itest-partant-import');
    const { source, ids } = await serveurAvecDeuxOutils('mcp_import', agent);
    const modifie: OutilAImporter = {
      nomDistant: 'mcp_import_haut', name: 'mcp_import_haut', title: 'MCP revu', description: 'm', nePasUtiliser: '',
      params: [], annonce: { name: 'mcp_import_haut', inputSchema: { type: 'object', properties: {} } },
      nonActivable: null, risk: 'read',
    };
    const mcp = new PgMcpStore(pool);
    await suppressionContre(agent, ids, () =>
      mcp.appliquer(tenantId, source, { nouveaux: [], changes: [{ id: ids.haut, outil: modifie }], disparus: [], vus: [ids.bas] }));
    const lu = await pool.query<{ title: string; mcp_vu_le: Date | null }>(
      'select title, mcp_vu_le from agent_tools where id = any($1::uuid[]) order by id', [[ids.bas, ids.haut]],
    );
    expect(lu.rows[0]!.mcp_vu_le).not.toBeNull();
    expect(lu.rows[1]!.title).toBe('MCP revu');
  });

  /**
   * 🔴 LA SUPPRESSION D'UN SERVEUR MCP (relecture du 2026-09-22). Sa cascade effaçait ses outils dans l'ordre du
   * parcours de table ; un outil rattaché mais inactif est le cas normal, et le refus « outils actifs » ne le
   * protège pas. Rouge avant le verrou par identifiant de `supprimerServeur`.
   */
  it('🔴 supprimer un agent n’interbloque pas avec la suppression de son serveur MCP', async () => {
    const agent = await agentSeul('itest-partant-serveur');
    const { source, ids } = await serveurAvecDeuxOutils('mcp_serveur', agent);
    const mcp = new PgMcpStore(pool);
    expect(await suppressionContre(agent, ids, () => mcp.supprimerServeur(tenantId, source))).toBe('supprime');
    expect(await existe(ids.bas)).toBe(false);
    expect(await existe(ids.haut)).toBe(false);
  });

  /**
   * 🔴 LA RELECTURE D'UNE SOURCE DE CONNAISSANCE (relecture du 2026-09-22). Elle retirait les fiches de l'agent,
   * puis prenait l'agent par la clé étrangère de ses insertions, en fin d'instruction ; `remove` tenait l'agent et
   * sa cascade attendait ces fiches. Rouge avant le verrou de l'agent en tête de `remplacerSource`.
   */
  it('🔴 supprimer un agent n’interbloque pas avec la relecture de sa connaissance', async () => {
    const agent = await agentSeul('itest-partant-connaissance');
    await pool.query(
      `insert into agent_knowledge (tenant_id, agent_id, titre, corps, source_type, source_url)
       values ($1, $2, 'Avant', 'ancien texte', 'page', 'https://exemple.test/page')`,
      [tenantId, agent],
    );
    const connaissance = new PgKnowledgeStore(pool);
    await avecConnexion(async (suppression) => {
      await suppression.query('begin');
      await suppression.query('select 1 from agents where tenant_id = $1 and id = $2 for update', [tenantId, agent]);
      const relecture = connaissance.remplacerSource(tenantId, agent, { type: 'page', url: 'https://exemple.test/page' },
        [{ titre: 'Après', corps: 'nouveau texte' }]);
      relecture.catch(() => {});
      await attendreUnVerrou();
      await suppression.query('delete from agents where tenant_id = $1 and id = $2', [tenantId, agent]);
      await suppression.query('commit');
      expect(await relecture).toBeNull();
    });
    expect((await pool.query('select 1 from agent_knowledge where agent_id = $1', [agent])).rowCount).toBe(0);
  });
});
