import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgMcpStore } from '../../src/agent/mcp/store.pg';
import { PgToolCatalog } from '../../src/agent/catalog.pg';
import type { OutilAImporter } from '../../src/agent/mcp/import';

const url = process.env.DATABASE_URL ?? '';

/**
 * L'ÉCRITURE D'UN IMPORT MCP (migration 0152).
 *
 * 🔴 POURQUOI EN INTÉGRATION, ET NULLE PART AILLEURS. Tout ce que ce module fait est du SQL : la chute du
 * consentement, le marquage d'un outil disparu, la garde `kind` qui refuse un croisement. Un faux magasin
 * rendrait ce qu'on lui fait rendre, y compris un consentement qui survit à un changement de schéma,
 * c'est-à-dire exactement le défaut que ce lot existe pour empêcher.
 *
 * ⚠️ IL NE TOURNE QU'EN CI. Le `DATABASE_URL` du poste de Julien pointe sur la PRODUCTION : lancer ce
 * fichier en local y créerait et supprimerait des espaces. La CI monte un Postgres jetable pour ça.
 */
describe.skipIf(!url)('l écriture d un import MCP (Postgres)', () => {
  let pool: Pool;
  let store: PgMcpStore;
  let catalogue: PgToolCatalog;
  let tenantId: string;
  let agentId: string;
  let userId: string;
  let sourceMcp: string;
  let sourceHttp: string;

  const annonce = (name: string, schema: unknown = { type: 'object', properties: { q: { type: 'string' } } }) =>
    ({ name, inputSchema: schema as Record<string, unknown> });

  const aImporter = (nomDistant: string, name: string, over: Partial<OutilAImporter> = {}): OutilAImporter => ({
    nomDistant,
    name,
    title: 'Chercher',
    description: 'cherche des choses',
    nePasUtiliser: '',
    params: [{ name: 'q', type: 'string', source: 'modele', cheminMcp: 'q' }],
    annonce: annonce(nomDistant),
    nonActivable: null,
    risk: 'read',
    ...over,
  });

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    store = new PgMcpStore(pool);
    catalogue = new PgToolCatalog(pool);

    tenantId = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-mcp-store') returning id`,
    )).rows[0]!.id;

    // ⚠️ `mention_ia` et `modele` sont NOT NULL SANS défaut (0086) : les omettre lève en 23502 et fait
    // échouer TOUT le fichier dans son `beforeAll`.
    agentId = (await pool.query<{ id: string }>(
      `insert into agents (tenant_id, label, fiche, mention_ia, modele)
       values ($1, 'itest', $2::jsonb, 'Je suis une IA.', 'test/modele') returning id`,
      [tenantId, JSON.stringify({ objectif: 'aider' })],
    )).rows[0]!.id;

    sourceMcp = (await pool.query<{ id: string }>(
      `insert into agent_tool_sources (tenant_id, kind, label, base_url, auth_kind, status)
       values ($1, 'mcp', 'itest-notion', 'https://exemple.test/mcp', 'none', 'active') returning id`,
      [tenantId],
    )).rows[0]!.id;

    // UN SEUL utilisateur, cree ici : un `on conflict do nothing` rendrait zero ligne au second appel,
    // donc un `active_par` nul, donc une violation du CHECK de 0086 (« actif = false or active_par is not
    // null ») au milieu d un test qui parle d autre chose.
    userId = (await pool.query<{ id: string }>(
      `insert into users (tenant_id, email, role, password_hash)
       values ($1, 'itest-mcp-store@exemple.test', 'admin', 'x') returning id`,
      [tenantId],
    )).rows[0]!.id;

    sourceHttp = (await pool.query<{ id: string }>(
      `insert into agent_tool_sources (tenant_id, kind, label, base_url, auth_kind, status)
       values ($1, 'http', 'itest-http', 'https://exemple.test/api', 'none', 'active') returning id`,
      [tenantId],
    )).rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  async function consentir(outilId: string): Promise<void> {
    // L'activation porte le nom de qui l'a faite : la contrainte de 0086 l'exige sur un consentement ACTIF.
    const u = userId;
    await pool.query(
      `insert into agent_tool_consommateurs (tenant_id, tool_id, consommateur, actif, active_par, active_le)
       values ($1, $2, $3, true, $4, now())`,
      [tenantId, outilId, `agent:${agentId}`, u],
    );
  }

  it('🔴 un outil importé porte son nom DISTANT, son annonce, et source_kind', async () => {
    await store.appliquer(tenantId, sourceMcp, {
      nouveaux: [aImporter('search', 'notion_search')], changes: [], disparus: [], vus: [],
    });
    const lu = await pool.query<{ origin: string; source_kind: string; binding: { outilDistant: string }; mcp_annonce: unknown; mcp_vu_le: Date | null }>(
      `select origin, source_kind, binding, mcp_annonce, mcp_vu_le
         from agent_tools where tenant_id = $1 and name = 'notion_search'`,
      [tenantId],
    );
    expect(lu.rowCount).toBe(1);
    expect(lu.rows[0]!.origin).toBe('mcp');
    // 🔴 La garde de `kind` de 0152 : sans `source_kind`, la clé étrangère composite ne s'applique PAS
    // (elle est en MATCH SIMPLE), et rien n'empêcherait plus le croisement.
    expect(lu.rows[0]!.source_kind).toBe('mcp');
    expect(lu.rows[0]!.binding.outilDistant).toBe('search');
    expect(lu.rows[0]!.mcp_annonce).not.toBeNull();
    expect(lu.rows[0]!.mcp_vu_le).not.toBeNull();
  });

  it('🔴 un outil MCP ne peut PAS se rattacher à une source HTTP', async () => {
    // La garde de `kind`, vue depuis l'écriture : l'`insert` exige `kind = 'mcp'`, donc il n'écrit RIEN
    // plutôt que de lever une erreur de contrainte en 500.
    await store.appliquer(tenantId, sourceHttp, {
      nouveaux: [aImporter('croise', 'notion_croise')], changes: [], disparus: [], vus: [],
    });
    const lu = await pool.query(
      `select 1 from agent_tools where tenant_id = $1 and name = 'notion_croise'`, [tenantId],
    );
    expect(lu.rowCount).toBe(0);
  });

  it('🔴 un SCHÉMA CHANGÉ fait TOMBER le consentement', async () => {
    // 🔴 C'est la moitié qui compte, et elle n'existe que dans ce SQL. Un outil dont le schéma a changé
    // n'est plus l'outil qui a été autorisé : lecture stricte de 0127, et la seule qui empêche un serveur
    // distant d'élargir en silence ce qu'un outil autorisé sait faire.
    await store.appliquer(tenantId, sourceMcp, {
      nouveaux: [aImporter('tombe', 'notion_tombe')], changes: [], disparus: [], vus: [],
    });
    const outils = await store.outilsDuServeur(tenantId, sourceMcp);
    const cible = outils.find((o) => o.nomDistant === 'tombe')!;
    await consentir(cible.id);
    expect((await store.outilsDuServeur(tenantId, sourceMcp)).find((o) => o.id === cible.id)!.consommateursActifs).toBe(1);

    await store.appliquer(tenantId, sourceMcp, {
      nouveaux: [],
      changes: [{ id: cible.id, outil: aImporter('tombe', 'notion_tombe', { annonce: annonce('tombe', { type: 'object', properties: {} }) }) }],
      disparus: [], vus: [],
    });

    const apres = (await store.outilsDuServeur(tenantId, sourceMcp)).find((o) => o.id === cible.id)!;
    expect(apres.consommateursActifs).toBe(0);
    // ⚠️ Le nom de qui avait dit oui est CONSERVÉ : la contrainte de 0086 n'exige un auteur que sur un
    // consentement actif, et le garder est ce qui rend l'incident instruisable.
    const trace = await pool.query<{ active_par: string | null }>(
      'select active_par from agent_tool_consommateurs where tenant_id = $1 and tool_id = $2',
      [tenantId, cible.id],
    );
    expect(trace.rows[0]!.active_par).not.toBeNull();
  });

  it('🔴 un outil DISPARU est marqué, pas supprimé, et son consentement tombe', async () => {
    await store.appliquer(tenantId, sourceMcp, {
      nouveaux: [aImporter('parti', 'notion_parti')], changes: [], disparus: [], vus: [],
    });
    const cible = (await store.outilsDuServeur(tenantId, sourceMcp)).find((o) => o.nomDistant === 'parti')!;
    await consentir(cible.id);

    await store.appliquer(tenantId, sourceMcp, { nouveaux: [], changes: [], disparus: [cible.id], vus: [] });

    const apres = (await store.outilsDuServeur(tenantId, sourceMcp)).find((o) => o.id === cible.id);
    // La ligne est la TRACE de ce qui a tourné, et le journal des appels y renvoie : un `delete` ferait
    // disparaître l'outil ET son histoire, au moment où le client se demande pourquoi son agent a changé.
    expect(apres).toBeDefined();
    expect(apres!.mcpIndisponibleLe).not.toBeNull();
    expect(apres!.consommateursActifs).toBe(0);
  });

  it('🔴 un outil débranché par le rafraîchissement est RÉCUPÉRABLE, sinon la perte reste muette', async () => {
    /**
     * Les deux tests ci-dessus prouvent que le consentement TOMBE. Celui-ci prouve qu'on sait le DIRE :
     * sans cette lecture, l'agent perdait une capacité que quelqu'un avait explicitement autorisée, et
     * aucun écran ne portait la cause. La marque est le couple `actif = false` ET `active_par` non nul,
     * et rien d'autre ne la porte.
     */
    // ⚠️ ON MESURE UN DELTA, PAS UNE LISTE ABSOLUE. Les tests précédents de ce fichier ont déjà fait tomber
    // deux consentements sur le MÊME espace : une assertion absolue passerait ou non selon l'ordre
    // d'exécution, ce qui en ferait un test instable plutôt qu'un test.
    const moi = `agent:${agentId}`;
    expect(await store.debranchesParRafraichissement(tenantId, moi)).not.toContain('notion_muet');

    await store.appliquer(tenantId, sourceMcp, {
      nouveaux: [aImporter('muet', 'notion_muet')], changes: [], disparus: [], vus: [],
    });
    const cible = (await store.outilsDuServeur(tenantId, sourceMcp)).find((o) => o.nomDistant === 'muet')!;
    await consentir(cible.id);
    // ⚠️ TANT QU IL EST ACTIF, il n a rien à dire : un outil en service n est pas une perte.
    expect(await store.debranchesParRafraichissement(tenantId, moi)).not.toContain('notion_muet');

    await store.appliquer(tenantId, sourceMcp, { nouveaux: [], changes: [], disparus: [cible.id], vus: [] });
    expect(await store.debranchesParRafraichissement(tenantId, moi)).toContain('notion_muet');

    // 🔴 UN AUTRE CONSOMMATEUR NE VOIT PAS LA PERTE DE CELUI-CI. Le consentement porte sur le COUPLE
    // (outil, consommateur) depuis 0127 : confondre les deux ferait annoncer au Meta Business Agent une
    // capacité perdue par un agent IA, et réciproquement.
    expect(await store.debranchesParRafraichissement(tenantId, 'mba:123456')).toEqual([]);
  });

  it('⚠️ un outil que PERSONNE n avait autorisé n est pas une perte', async () => {
    // `active_par is null` = personne n a jamais dit oui. L annoncer comme débranché serait faux, et le
    // client irait « réautoriser » un outil qu il n avait jamais autorisé.
    await store.appliquer(tenantId, sourceMcp, {
      nouveaux: [aImporter('jamais', 'notion_jamais')], changes: [], disparus: [], vus: [],
    });
    const cible = (await store.outilsDuServeur(tenantId, sourceMcp)).find((o) => o.nomDistant === 'jamais')!;
    await pool.query(
      `insert into agent_tool_consommateurs (tenant_id, tool_id, consommateur, actif)
       values ($1, $2, $3, false)`,
      [tenantId, cible.id, `agent:${agentId}`],
    );
    expect(await store.debranchesParRafraichissement(tenantId, `agent:${agentId}`)).not.toContain('notion_jamais');
  });

  it('les noms pris couvrent TOUT l espace, pas seulement ce serveur', async () => {
    // L'unicité de `agent_tools.name` est par ESPACE depuis 0127 : ne regarder que les outils du serveur
    // en cours ferait choisir un nom qu'un connecteur HTTP occupe déjà.
    const noms = await store.nomsPris(tenantId);
    expect(noms).toContain('notion_search');
    expect(noms).toContain('notion_parti');
  });

  it('le réglage FUSIONNE sur le nom : le client change la SOURCE, pas le type', async () => {
    // 🔴 Le type, la description et l'énumération viennent du serveur distant et ne lui appartiennent pas.
    // Accepter un tableau complet laisserait l'écran réécrire un type, donc envoyer au serveur une valeur
    // qu'il refuse, pour une raison invisible.
    const cible = (await store.outilsDuServeur(tenantId, sourceMcp)).find((o) => o.nomDistant === 'search')!;
    const ok = await store.reglerOutil(tenantId, cible.id, {
      params: [{ name: 'q', source: 'champ', cle: 'email' }],
      risk: 'write',
    });
    expect(ok).toBe(true);
    const lu = await pool.query<{ params: Array<Record<string, unknown>>; risk: string }>(
      'select params, risk from agent_tools where tenant_id = $1 and id = $2', [tenantId, cible.id],
    );
    expect(lu.rows[0]!.params[0]).toMatchObject({ name: 'q', type: 'string', source: 'champ', cle: 'email', cheminMcp: 'q' });
    expect(lu.rows[0]!.risk).toBe('write');
  });

  it('🔴 ON NE PEUT PAS ACTIVER un outil declare NON ACTIVABLE', async () => {
    /**
     * 🔴 CE REFUS N EXISTAIT NULLE PART. `mcp_non_activable` etait ecrit par l import, rendu par le store,
     * affiche par l ecran MCP... et lu par AUCUNE garde. L ecran qui porte la case d activation est
     * `Tools > Outils`, qui ne connaissait pas la colonne : rien n empechait donc d activer un outil dont
     * l aplatisseur avait refuse le schema.
     *
     * 🔴 LA GARDE EST AU POINT DE PASSAGE, parce que les DEUX chemins d activation y aboutissent : l onglet
     * Outils d un agent et l exposition a l agent de Meta. La poser dans l un la laisserait absente de
     * l autre.
     */
    await store.appliquer(tenantId, sourceMcp, {
      nouveaux: [aImporter('refuse', 'notion_refuse', { nonActivable: 'le paramètre « lignes » est une liste' })],
      changes: [], disparus: [], vus: [],
    });
    const cible = (await store.outilsDuServeur(tenantId, sourceMcp)).find((o) => o.nomDistant === 'refuse')!;
    await pool.query(
      `insert into agent_tool_consommateurs (tenant_id, tool_id, consommateur, actif) values ($1, $2, $3, false)`,
      [tenantId, cible.id, `agent:${agentId}`],
    );
    await expect(
      catalogue.activerConsommateur(tenantId, `agent:${agentId}`, cible.id, true, userId),
    ).rejects.toThrow(/lignes/);
  });

  it('⚠️ mais on peut toujours le DESACTIVER : c est le seul geste qui reste au client', async () => {
    const cible = (await store.outilsDuServeur(tenantId, sourceMcp)).find((o) => o.nomDistant === 'refuse')!;
    await expect(
      catalogue.activerConsommateur(tenantId, `agent:${agentId}`, cible.id, false, userId),
    ).resolves.not.toThrow();
  });

  it('⚠️ et le réglage refuse un outil qui n est pas MCP', async () => {
    // Sans `origin = 'mcp'` dans le `where`, cette route réglerait aussi un connecteur HTTP, dont les
    // paramètres sont DÉRIVÉS des variables de sa requête.
    // Ecrit en SQL direct plutot que par le store d outils : ce qu on eprouve est le `where` de
    // `reglerOutil`, pas la route de creation d un outil maison.
    const maison = (await pool.query<{ id: string }>(
      `insert into agent_tools (tenant_id, origin, name, title, description, ne_pas_utiliser,
                                params, binding, risk)
       values ($1, 'mba', 'lire_contact_itest', 'x', 'x', 'x', '[]'::jsonb,
               '{"handler":"mba_lire_contact"}'::jsonb, 'read') returning id`,
      [tenantId],
    )).rows[0]!.id;
    expect(await store.reglerOutil(tenantId, maison, { risk: 'write' })).toBe(false);
  });
});
