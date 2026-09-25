import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgToolCatalog } from '../../src/agent/catalog.pg';

const url = process.env.DATABASE_URL ?? '';

/**
 * LA GARDE DE `kind` : un outil ne peut pas se brancher sur une source d'un AUTRE type (migration 0152).
 *
 * 🔴 CE QU'ELLE FERME. Rien n'empêchait un outil `origin = 'mcp'` de pointer vers une source
 * `kind = 'http'`, ni l'inverse : `agent_tools_origin_src_chk` (0088) vérifie qu'une source EXISTE, pas
 * LAQUELLE. Le résolveur d'exécution serait alors parti dans la mauvaise branche, et un test unitaire ne
 * l'aurait jamais vu parce qu'il monte son propre faux câblage. Le trou était nommé depuis des semaines
 * dans `AGENT-IA-PLAN-L4.md` (« le trou n°3 »).
 *
 * 🔴 POURQUOI EN INTÉGRATION, ET PAS AUTREMENT. La garde vit à deux endroits et l'un des deux n'existe que
 * dans la base : le `kind = 'http'` de l'`insert` (un refus LISIBLE, qui rend `null`) et la clé étrangère
 * COMPOSITE vers `agent_tool_sources (id, kind)` (la ceinture, qui tient même si quelqu'un écrit en SQL
 * direct un jour). Le second cas ne peut se vérifier que contre un vrai Postgres.
 */
describe.skipIf(!url)('la garde de kind entre un outil et sa source (Postgres)', () => {
  let pool: Pool;
  let catalogue: PgToolCatalog;
  let tenantId: string;
  let agentId: string;
  let sourceHttp: string;
  let sourceMcp: string;
  let requeteId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    catalogue = new PgToolCatalog(pool);

    tenantId = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-source-kind') returning id`,
    )).rows[0]!.id;

    // ⚠️ `mention_ia` et `modele` sont NOT NULL SANS défaut (0086) : les omettre lève en 23502 et fait
    // échouer TOUT le fichier dans son `beforeAll`.
    agentId = (await pool.query<{ id: string }>(
      `insert into agents (tenant_id, label, fiche, mention_ia, modele)
       values ($1, 'itest', $2::jsonb, 'Je suis une IA.', 'test/modele') returning id`,
      [tenantId, JSON.stringify({ objectif: 'aider' })],
    )).rows[0]!.id;

    sourceHttp = (await pool.query<{ id: string }>(
      `insert into agent_tool_sources (tenant_id, kind, label, base_url, auth_kind, status)
       values ($1, 'http', 'itest-http', 'https://exemple.test/api', 'none', 'active') returning id`,
      [tenantId],
    )).rows[0]!.id;

    // La source MCP existe DEPUIS 0088, la colonne `kind` l'accepte depuis toujours. C'est le code qui
    // ne la servait pas.
    sourceMcp = (await pool.query<{ id: string }>(
      `insert into agent_tool_sources (tenant_id, kind, label, base_url, auth_kind, status)
       values ($1, 'mcp', 'itest-mcp', 'https://exemple.test/mcp', 'none', 'active') returning id`,
      [tenantId],
    )).rows[0]!.id;

    requeteId = (await pool.query<{ id: string }>(
      `insert into connector_requests (tenant_id, source_id, label, method, path, output_paths)
       values ($1, $2, 'itest-appel', 'POST', '/x', $3::text[]) returning id`,
      [tenantId, sourceHttp, ['statut']],
    )).rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  const base = (nom: string, sourceId: string) => ({
    sourceId, requestId: requeteId, name: nom, title: 'Titre', description: 'sert à ça',
    nePasUtiliser: 'jamais pour ça', params: [], risk: 'write' as const,
    nature: 'integre' as const, outputPaths: ['statut'],
  });

  it('🔴 un outil de connecteur ECRIT son source_kind, il ne le laisse pas a null', async () => {
    // 🔴 SANS CETTE ECRITURE, LA GARDE N EST PAS UNE GARDE. La cle etrangere est en MATCH SIMPLE : une
    // ligne dont `source_kind` est null y echappe entierement. La colonne renseignee est ce qui arme la
    // contrainte, et c est pour ca que ce cas lit la BASE plutot que ce que la fonction rend.
    const outil = await catalogue.ajouterConnecteur(tenantId, agentId, base('avec_kind', sourceHttp));
    expect(outil).not.toBeNull();
    const lu = await pool.query<{ source_kind: string | null }>(
      'select source_kind from agent_tools where id = $1', [outil!.id],
    );
    expect(lu.rows[0]!.source_kind).toBe('http');
  });

  it('🔴 un outil HTTP sur une source MCP est REFUSE, et rien n est ecrit', async () => {
    // Le refus prend la forme d un `insert` qui ne rend AUCUNE ligne, donc le `null` que l appelant traite
    // deja, et PAS une erreur de contrainte en 500 dont Cloudflare remplace le corps.
    const outil = await catalogue.ajouterConnecteur(tenantId, agentId, base('croise', sourceMcp));
    expect(outil).toBeNull();
    const reste = await pool.query(
      `select 1 from agent_tools where tenant_id = $1 and name = 'croise'`, [tenantId],
    );
    expect(reste.rowCount).toBe(0);
  });

  it('🔴 la BASE refuse le croisement, meme ecrit en SQL direct', async () => {
    // 🔴 LA CEINTURE, ET C EST LE SEUL CAS QUI L EPROUVE. Le refus ci-dessus vit dans NOTRE requete : il
    // disparaitrait le jour ou quelqu un ecrit un second chemin d insertion. La cle etrangere composite,
    // elle, tient quoi qu il arrive. Un declencheur aurait dit la meme chose sans pouvoir etre relu dans
    // le schema.
    const outil = await catalogue.ajouterConnecteur(tenantId, agentId, base('ceinture', sourceHttp));
    await expect(
      pool.query('update agent_tools set source_id = $1, source_kind = $2 where id = $3',
        [sourceMcp, 'http', outil!.id]),
    ).rejects.toThrow();
  });

  it('un outil MAISON n a ni source ni source_kind, et ce n est pas une omission', async () => {
    // La cle etrangere est en MATCH SIMPLE : deux colonnes nulles la satisfont. C est ce qui permet aux
    // quatre outils maison de la production de survivre a cette migration sans reprise.
    const lu = await pool.query<{ n: string }>(
      `select count(*)::text as n from agent_tools
        where origin = 'mba' and (source_id is not null or source_kind is not null)`,
    );
    expect(lu.rows[0]!.n).toBe('0');
  });
});
