import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgToolCatalog } from '../../src/agent/catalog.pg';
import { PgRequeteStore } from '../../src/agent/requetes.pg';
import { PgSourceStore } from '../../src/agent/sources.pg';
import { outilExpose } from '../../src/agent/outils-maison';
import { executeTool } from '../../src/agent/executor';
import { creerResolveurHttp } from '../../src/agent/resolvers/http';
import { JOURNAL_MUET } from '../../src/agent/journal-muet';
import type { OutilDefini } from '../../src/agent/catalog';
import type { ParametreUrl } from '../../src/agent/requete-http';
import type { VariableDeclaree } from '../../src/agent/requetes';
import { GESTE_MUET } from '../gestes';

const url = process.env.DATABASE_URL ?? '';

/**
 * UN OUTIL DE CONNECTEUR SUIT SA REQUÊTE, SANS ÊTRE RECRÉÉ (2026-10-08).
 *
 * 🔴 LE DÉFAUT, MESURÉ EN PRODUCTION CE JOUR-LÀ. Sur Groupama PJ, la variable `age_mois` de la requête « tarif » est
 * renommée `age` dans Tools > Connecteurs API. L'outil de l'agent IA gardait la copie prise à sa création
 * (`agent_tools.params`) : le modèle remplissait `age_mois`, le résolveur, qui lit la requête, ne trouvait pas `age`,
 * et chaque appel était refusé, sans rien à l'écran. Les 3 outils de connecteur de la base divergeaient de leur requête.
 *
 * 🔴 POURQUOI EN INTÉGRATION. La parade vit dans la lecture du catalogue : la sous-requête de `COLONNES` qui ramène
 * les variables de la requête avec l'outil, et `versOutil` qui en dérive les paramètres. Un faux magasin rendrait ce
 * qu'on lui fait rendre. Ce fichier modifie la requête par le VRAI magasin, relit l'outil par les trois lectures du
 * catalogue, puis l'appelle par le tronc commun et le vrai résolveur ; seul le réseau est simulé.
 *
 * Jamais joué en local (le DATABASE_URL local pointe la PRODUCTION), joué par le job `integration`.
 */
describe.skipIf(!url)('un outil de connecteur suit sa requête (Postgres)', () => {
  let pool: Pool;
  let catalogue: PgToolCatalog;
  let requetes: PgRequeteStore;
  let sources: PgSourceStore;
  let tenantId: string;
  let autreTenantId: string;
  let agentId: string;
  let adminId: string;
  let sourceId: string;

  /** La requête « tarif » de Groupama PJ, avant la modification. Le numéro vient du tour, jamais du modèle. */
  const AVANT: VariableDeclaree[] = [
    { nom: 'espece', type: 'string', origine: { type: 'modele' }, requis: true, enum: ['chien', 'chat'] },
    { nom: 'race', type: 'string', origine: { type: 'modele' }, requis: true, description: 'la race' },
    { nom: 'age_mois', type: 'integer', origine: { type: 'modele' }, requis: true },
    { nom: 'tel', type: 'string', origine: { type: 'fiche', cle: 'wa_id' } },
  ];
  /** Après : un renommage, une valeur permise et une description de plus, et une variable requise ajoutée. */
  const APRES: VariableDeclaree[] = [
    { nom: 'espece', type: 'string', origine: { type: 'modele' }, requis: true, enum: ['chien', 'chat', 'lapin'] },
    { nom: 'race', type: 'string', origine: { type: 'modele' }, requis: true, description: 'la race, en clair' },
    { nom: 'age', type: 'integer', origine: { type: 'modele' }, requis: true },
    { nom: 'sexe', type: 'string', origine: { type: 'modele' }, requis: true },
    { nom: 'tel', type: 'string', origine: { type: 'fiche', cle: 'wa_id' } },
  ];
  const parametres = (noms: string[]): ParametreUrl[] => noms.map((n) => ({ cle: n, valeur: `{{${n}}}` }));

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    catalogue = new PgToolCatalog(pool);
    requetes = new PgRequeteStore(pool);
    sources = new PgSourceStore(pool);

    tenantId = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-connecteur-suit-requete') returning id`,
    )).rows[0]!.id;
    autreTenantId = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-connecteur-suit-requete-autre') returning id`,
    )).rows[0]!.id;
    adminId = (await pool.query<{ id: string }>(
      `insert into users (tenant_id, email, role, password_hash) values ($1, 'itest-suit-requete@example.test', 'admin', 'x') returning id`,
      [tenantId],
    )).rows[0]!.id;
    // ⚠️ `mention_ia` et `modele` sont NOT NULL SANS défaut (migration 0086), et il n'y a pas de colonne `objectif`.
    agentId = (await pool.query<{ id: string }>(
      `insert into agents (tenant_id, label, fiche, mention_ia, modele)
       values ($1, 'itest', $2::jsonb, 'Je suis une IA.', 'test/modele') returning id`,
      [tenantId, JSON.stringify({ objectif: 'aider' })],
    )).rows[0]!.id;
    sourceId = (await pool.query<{ id: string }>(
      `insert into agent_tool_sources (tenant_id, kind, label, base_url, auth_kind, status)
       values ($1, 'http', 'itest-source', 'https://exemple.test/api', 'none', 'active') returning id`,
      [tenantId],
    )).rows[0]!.id;
  });

  afterAll(async () => {
    // L'ordre compte : `itest_croise` désigne la requête de l'AUTRE espace (clé étrangère en `restrict`). L'espace
    // qui porte l'outil part d'abord, sinon la suppression de l'autre échouerait.
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    if (autreTenantId) await pool.query('delete from tenants where id = $1', [autreTenantId]);
    await pool.end();
  });

  /** Une requête de la bibliothèque, créée par le vrai magasin, en GET, ses variables passées dans l'adresse. */
  const creerRequete = async (label: string, variables: VariableDeclaree[]): Promise<string> =>
    (await requetes.creer(tenantId, {
      sourceId, label, methode: 'GET', chemin: '/tarif',
      parametres: parametres(variables.map((v) => v.nom)), entetes: [], corps: { mode: 'aucun' },
      variables, outputPaths: ['prix'], valeursTest: {},
    })).id;

  /** Un outil d'agent IA sur cette requête, créé par le vrai magasin (SANS paramètres) puis activé. */
  const creerOutil = async (requestId: string, name: string): Promise<string> => {
    const cree = await catalogue.ajouterConnecteur(tenantId, agentId, {
      sourceId, requestId, name, title: 'Tarif', description: 'donne le tarif', nePasUtiliser: 'jamais pour un devis',
      risk: 'read', nature: 'integre', outputPaths: ['prix'],
    });
    expect(await catalogue.activer(tenantId, agentId, cree!.id, true, adminId)).not.toBeNull();
    return cree!.id;
  };

  /** Ce que le modèle voit de l'outil, par une lecture du catalogue. */
  const vu = (o: OutilDefini | null | undefined) => outilExpose(o!, [])!.parameters;

  it('🔴 renommer, ajouter, changer valeurs permises et description : l’outil suit, et l’appel part avec `age`', async () => {
    const rq = await creerRequete('tarif', AVANT);
    const id = await creerOutil(rq, 'obtenir_tarif');

    // Avant la modification : la requête telle qu'elle est, sans le numéro, qui vient du tour.
    const avant = vu(await catalogue.byName(tenantId, agentId, 'obtenir_tarif'));
    expect(Object.keys(avant.properties)).toEqual(['espece', 'race', 'age_mois']);
    // Rien n'est recopié sur l'outil : la colonne reste à son défaut.
    const colonne = await pool.query<{ params: unknown }>('select params from agent_tools where tenant_id = $1 and id = $2', [tenantId, id]);
    expect(colonne.rows[0]!.params).toEqual([]);

    await requetes.patch(tenantId, rq, { variables: APRES, parametres: parametres(APRES.map((v) => v.nom)) });

    // 🔴 Les trois lectures du catalogue voient la requête modifiée : le tour (`listActifs`), l'appel (`byName`) et
    // l'onglet de l'agent (`listToutes`).
    const lectures = [
      await catalogue.byName(tenantId, agentId, 'obtenir_tarif'),
      (await catalogue.listActifs(tenantId, agentId)).find((o) => o.id === id),
      (await catalogue.listToutes(tenantId, agentId)).find((o) => o.id === id),
    ];
    for (const o of lectures) {
      const s = vu(o);
      expect(Object.keys(s.properties)).toEqual(['espece', 'race', 'age', 'sexe']);
      expect(s.required).toEqual(['espece', 'race', 'age', 'sexe']);
      expect(s.properties.espece!.enum).toEqual(['chien', 'chat', 'lapin']);
      expect(s.properties.race!.description).toBe('la race, en clair');
      expect(s.properties).not.toHaveProperty('tel');
    }

    // L'appel, par le tronc commun, le vrai catalogue et le vrai résolveur (vraie requête, vraie source).
    const parties: string[] = [];
    const resolveur = creerResolveurHttp({
      sources, requetes,
      fiche: { ficheDuContact: async () => null },
      fetchImpl: (async (u: string) => {
        parties.push(String(u));
        return new Response(JSON.stringify({ prix: 12.5 }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as unknown as typeof fetch,
      verifierResolution: async () => ({ ok: true }),
    });
    const r = await executeTool(
      { name: 'obtenir_tarif', argumentsJson: JSON.stringify({ espece: 'lapin', race: 'nain', age: 3, sexe: 'f' }) },
      {
        tenantId, agentId, sessionId: 's1', runId: 'r1', workflowId: 'wf1', waId: '33600000000',
        contact: null, contactInconnu: 'tous', appelsRestants: 5, budgetRestantMicroEur: 10_000,
        deadline: Date.now() + 30_000,
      },
      {
        catalogue, journal: JOURNAL_MUET, resolveurs: { http: resolveur }, sessions: { compterAppel: async () => {} },
        executerGeste: GESTE_MUET,
      },
    );
    expect(r.status).toBe('ok');
    expect(r.contenu).toEqual({ prix: 12.5 });
    expect(parties).toHaveLength(1);
    const envoye = new URL(parties[0]!).searchParams;
    expect([envoye.get('espece'), envoye.get('age'), envoye.get('sexe'), envoye.get('tel')]).toEqual(['lapin', '3', 'f', '33600000000']);
    expect(envoye.has('age_mois')).toBe(false);
  });

  it('⚠️ un outil maison et un outil MCP gardent LEUR colonne : seul un connecteur API suit sa requête', async () => {
    // Un outil maison porte des valeurs permises que le client règle ; un outil MCP, les sources de ses paramètres
    // (`champ` ici) réglées dans Connecteurs MCP. Les dériver d'une requête effacerait ces réglages.
    const maison = await catalogue.ajouter(tenantId, agentId, {
      handler: 'terminer', cible: null, name: 'itest_terminer', title: 'Terminer', description: 'Termine.',
      nePasUtiliser: '', params: [{ name: 'sortie', type: 'string', source: 'modele', required: true, enum: ['ok'] }],
      risk: 'read',
    });
    const sourceMcp = (await pool.query<{ id: string }>(
      `insert into agent_tool_sources (tenant_id, kind, label, base_url, auth_kind, status)
       values ($1, 'mcp', 'itest-src-mcp', 'https://exemple.test/mcp', 'none', 'active') returning id`,
      [tenantId],
    )).rows[0]!.id;
    const paramsMcp = [{ name: 'q', type: 'string', source: 'champ', cle: 'email', cheminMcp: 'q' }];
    const mcp = (await pool.query<{ id: string }>(
      `insert into agent_tools (tenant_id, origin, source_id, source_kind, name, title, description, ne_pas_utiliser, params, binding, risk)
       values ($1, 'mcp', $2, 'mcp', 'itest_mcp', 'MCP', 'm', '', $3::jsonb, $4::jsonb, 'read') returning id`,
      [tenantId, sourceMcp, JSON.stringify(paramsMcp), JSON.stringify({ outilDistant: 'chercher' })],
    )).rows[0]!.id;
    await pool.query(
      `insert into agent_tool_consommateurs (tenant_id, tool_id, consommateur, tool_name)
       values ($1, $2, $3, (select name from agent_tools where id = $2))`,
      [tenantId, mcp, `agent:${agentId}`],
    );
    const tous = await catalogue.listToutes(tenantId, agentId);
    expect(tous.find((o) => o.id === maison!.id)!.params).toEqual([
      { name: 'sortie', type: 'string', source: 'modele', required: true, enum: ['ok'] },
    ]);
    expect(tous.find((o) => o.id === mcp)!.params).toEqual(paramsMcp);
  });

  it('🔴 un outil qui désignerait la requête d’un AUTRE espace n’en reçoit rien', async () => {
    // L'insertion du catalogue l'interdit (`exists ... tenant_id = $1`), mais la clé étrangère de `request_id` ne
    // regarde pas l'espace : une ligne écrite à la main pourrait croiser. La sous-requête de `COLONNES` filtre sur
    // l'espace de l'OUTIL, sans quoi les variables d'un client deviendraient le schéma de l'agent d'un autre.
    const sourceAutre = (await pool.query<{ id: string }>(
      `insert into agent_tool_sources (tenant_id, kind, label, base_url, auth_kind, status)
       values ($1, 'http', 'itest-source-autre', 'https://autre.test/api', 'none', 'active') returning id`,
      [autreTenantId],
    )).rows[0]!.id;
    const requeteAutre = (await new PgRequeteStore(pool).creer(autreTenantId, {
      sourceId: sourceAutre, label: 'secret', methode: 'GET', chemin: '/x', parametres: [], entetes: [],
      corps: { mode: 'aucun' }, outputPaths: ['x'], valeursTest: {},
      variables: [{ nom: 'secret_du_voisin', type: 'string', origine: { type: 'modele' }, requis: true }],
    })).id;
    const croise = (await pool.query<{ id: string }>(
      `insert into agent_tools (tenant_id, origin, source_id, source_kind, request_id, name, title, description, ne_pas_utiliser, binding, risk)
       values ($1, 'http', $2, 'http', $3, 'itest_croise', 'x', 'x', 'x', '{}'::jsonb, 'read') returning id`,
      [tenantId, sourceId, requeteAutre],
    )).rows[0]!.id;
    await pool.query(
      `insert into agent_tool_consommateurs (tenant_id, tool_id, consommateur, tool_name)
       values ($1, $2, $3, (select name from agent_tools where id = $2))`,
      [tenantId, croise, `agent:${agentId}`],
    );
    const lu = (await catalogue.listToutes(tenantId, agentId)).find((o) => o.id === croise);
    expect(lu!.params).toEqual([]);
    expect(JSON.stringify(lu)).not.toContain('secret_du_voisin');
  });
});
