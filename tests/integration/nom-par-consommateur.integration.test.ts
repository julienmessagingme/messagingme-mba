import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgToolCatalog } from '../../src/agent/catalog.pg';
import { NomOutilDejaPris } from '../../src/agent/catalog';
import { consommateurAgent } from '../../src/agent/consommateur';

const url = process.env.DATABASE_URL ?? '';

/**
 * UN AGENT NE VOIT JAMAIS DEUX OUTILS DU MÊME NOM (migration 0211).
 *
 * 🔴 CE QUI ÉTAIT POSSIBLE : une action (unique par agent) et un appel de connecteur (unique par espace) du même nom,
 * les deux index partiels de 0157 ne se recoupant pas. Un agent qui utilise les deux exposait deux fonctions
 * homonymes, et les trois fournisseurs du Gateway refusent alors le tour entier en 400 (mesuré le 2026-10-05).
 *
 * 🔴 POURQUOI EN INTÉGRATION : la garde vit dans la base, un index sur une copie du nom que tient une clé étrangère
 * en cascade. Un faux magasin rendrait ce qu'on lui fait rendre, et ne verrait ni la course ni la cascade.
 *
 * ⚠️ Chaque refus est suivi d'une ANCRE POSITIVE (le même geste sous un autre nom passe) : sans elle, une fixture
 * cassée qui refuse tout rendrait ces cas verts.
 */
describe.skipIf(!url)('un agent ne voit jamais deux outils du même nom (Postgres)', () => {
  let pool: Pool;
  let catalogue: PgToolCatalog;
  let tenantId: string;
  let agentA: string;
  let agentB: string;
  let sourceId: string;
  let requeteId: string;
  let userId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    catalogue = new PgToolCatalog(pool);
    tenantId = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-nom-par-consommateur') returning id`,
    )).rows[0]!.id;
    // `mention_ia` et `modele` sont NOT NULL SANS défaut (0086).
    const creerAgent = async (label: string) => (await pool.query<{ id: string }>(
      `insert into agents (tenant_id, label, fiche, mention_ia, modele)
       values ($1, $2, $3::jsonb, 'Je suis une IA.', 'test/modele') returning id`,
      [tenantId, label, JSON.stringify({ objectif: 'aider' })],
    )).rows[0]!.id;
    agentA = await creerAgent('itest-a');
    agentB = await creerAgent('itest-b');
    // L'administrateur au nom de qui naît un outil maison de l'agent de Meta (`atc_actif_humain_chk`).
    userId = (await pool.query<{ id: string }>(
      `insert into users (tenant_id, email, role, password_hash) values ($1, $2, 'admin', 'x') returning id`,
      [tenantId, `itest-nom-par-consommateur-${Date.now()}@example.test`],
    )).rows[0]!.id;
    // Une source ACTIVE : le rattachement refuse un outil dont le système est éteint (`CAUSE_INAPPELABLE`).
    sourceId = (await pool.query<{ id: string }>(
      `insert into agent_tool_sources (tenant_id, kind, label, base_url, auth_kind, status)
       values ($1, 'http', 'itest-source', 'https://exemple.test/api', 'none', 'active') returning id`,
      [tenantId],
    )).rows[0]!.id;
    requeteId = (await pool.query<{ id: string }>(
      `insert into connector_requests (tenant_id, source_id, label, method, path, output_paths)
       values ($1, $2, 'itest-appel', 'POST', '/x', $3::text[]) returning id`,
      [tenantId, sourceId, ['statut']],
    )).rows[0]!.id;
  });

  afterAll(async () => {
    // La cascade de l'espace emporte agents, outils et liaisons.
    if (pool) {
      if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
      await pool.end();
    }
  });

  const action = (name: string) => ({
    handler: 'terminer', name, title: 'Terminer', description: 'Termine.', nePasUtiliser: '',
    params: [], risk: 'read' as const,
  });
  const appel = (name: string) => ({
    sourceId, requestId: requeteId, name, title: 'Appel', description: 'Appelle le système.', nePasUtiliser: '',
    params: [], risk: 'write' as const, nature: 'pousse' as const, outputPaths: [],
  });
  /** Les noms des outils d'un agent, tels que son onglet et son modèle les voient. */
  const nomsDe = async (agentId: string) => (await catalogue.listToutes(tenantId, agentId)).map((o) => o.name).sort();
  /** Combien de définitions portent ce nom dans l'espace : un refus ne laisse aucun orphelin qui garderait le nom. */
  const definitions = async (name: string) => Number((await pool.query<{ n: string }>(
    'select count(*) as n from agent_tools where tenant_id = $1 and name = $2', [tenantId, name],
  )).rows[0]!.n);
  /** Le refus attendu : la classe qui fait le 409 des routes, et le texte qui reste vrai dans tous les cas. */
  const refuse = async (p: Promise<unknown>) => {
    const err = await p.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(NomOutilDejaPris);
    expect((err as Error).message).toBe('deux outils d’un même agent porteraient ce nom');
  };

  it('🔴 un agent qui utilise un appel de connecteur ne reçoit pas une action du même nom', async () => {
    expect(await catalogue.ajouterConnecteur(tenantId, agentA, appel('devis'))).not.toBeNull();
    await refuse(catalogue.ajouter(tenantId, agentA, action('devis')));
    // La transaction emporte l'action déjà écrite avant sa liaison.
    expect(await definitions('devis')).toBe(1);
    expect(await catalogue.ajouter(tenantId, agentA, action('devis_suivi'))).not.toBeNull();
  });

  it('🔴 un agent qui a une action ne reçoit pas un appel de connecteur du même nom', async () => {
    expect(await catalogue.ajouter(tenantId, agentA, action('rappel'))).not.toBeNull();
    await refuse(catalogue.ajouterConnecteur(tenantId, agentA, appel('rappel')));
    // Le connecteur était écrit avant sa liaison : resté, il garderait le nom pour TOUT l'espace.
    expect(await definitions('rappel')).toBe(1);
    expect(await catalogue.ajouterConnecteur(tenantId, agentA, appel('rappel_suivi'))).not.toBeNull();
  });

  it('🔴 une action ne se renomme pas du nom d’un appel que son agent utilise', async () => {
    const act = await catalogue.ajouter(tenantId, agentA, action('notifier'));
    expect(await catalogue.ajouterConnecteur(tenantId, agentA, appel('facturer'))).not.toBeNull();
    await refuse(catalogue.patch(tenantId, agentA, act!.id, { name: 'facturer' }));
    expect((await catalogue.listToutes(tenantId, agentA)).find((o) => o.id === act!.id)?.name).toBe('notifier');
    expect((await catalogue.patch(tenantId, agentA, act!.id, { name: 'notifier_client' }))?.name).toBe('notifier_client');
  });

  it('🔴 un connecteur partagé ne se renomme pas du nom d’une action d’un AUTRE agent qui l’utilise', async () => {
    // Le cas que seule la cascade voit : l'écran qui renomme est celui de A, qui n'a aucune action de ce nom.
    const stock = await catalogue.ajouterConnecteur(tenantId, agentA, appel('stock'));
    expect(await catalogue.rattacher(tenantId, agentB, stock!.id)).toEqual({ ok: true });
    expect(await catalogue.ajouter(tenantId, agentB, action('inventaire'))).not.toBeNull();
    await refuse(catalogue.patch(tenantId, agentA, stock!.id, { name: 'inventaire' }));
    expect(await nomsDe(agentB)).toContain('stock');
    // Renommé sans conflit, il change chez les deux agents.
    expect((await catalogue.patch(tenantId, agentA, stock!.id, { name: 'stock_vu' }))?.name).toBe('stock_vu');
    expect(await nomsDe(agentB)).toContain('stock_vu');
  });

  it('🔴 le rattachement refuse un outil dont l’agent porte déjà le nom, et dit pourquoi', async () => {
    expect(await catalogue.ajouter(tenantId, agentB, action('commande'))).not.toBeNull();
    const commande = await catalogue.ajouterConnecteur(tenantId, agentA, appel('commande'));
    expect(await catalogue.rattacher(tenantId, agentB, commande!.id)).toEqual({ ok: false, refus: 'nom_pris' });
    expect((await catalogue.listToutes(tenantId, agentB)).filter((o) => o.name === 'commande').map((o) => o.origin))
      .toEqual(['mba']);
    const autre = await catalogue.ajouterConnecteur(tenantId, agentA, appel('commande_suivi'));
    expect(await catalogue.rattacher(tenantId, agentB, autre!.id)).toEqual({ ok: true });
  });

  it('🔴 l’offre dit quand l’agent porte déjà le nom, et la bibliothèque entière ne le dit jamais', async () => {
    // L'assistant de construction écarte une telle offre : branchée après l'écriture de la fiche, la porte la refuserait.
    const facture = await catalogue.ajouterConnecteur(tenantId, agentA, appel('facture'));
    const avoir = await catalogue.ajouterConnecteur(tenantId, agentA, appel('avoir'));
    expect(await catalogue.ajouter(tenantId, agentB, action('facture'))).not.toBeNull();
    const offre = await catalogue.offrablesPour(tenantId, consommateurAgent(agentB));
    expect(offre.find((o) => o.id === facture!.id)?.nomPris).toBe(true);
    expect(offre.find((o) => o.id === avoir!.id)?.nomPris).toBe(false);
    expect((await catalogue.listCatalogue(tenantId)).find((o) => o.id === facture!.id)?.nomPris).toBe(false);
  });

  it('🔴 une action et un appel du même nom créés EN MÊME TEMPS : un seul passe', async () => {
    // La raison d'un index plutôt que d'une vérification lue puis écrite : les deux lectures verraient le nom libre.
    for (const nom of ['course_1', 'course_2', 'course_3', 'course_4', 'course_5']) {
      const issues = await Promise.allSettled([
        catalogue.ajouter(tenantId, agentA, action(nom)),
        catalogue.ajouterConnecteur(tenantId, agentA, appel(nom)),
      ]);
      expect(issues.map((i) => i.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect(issues.find((i): i is PromiseRejectedResult => i.status === 'rejected')?.reason)
        .toBeInstanceOf(NomOutilDejaPris);
      expect((await nomsDe(agentA)).filter((n) => n === nom)).toHaveLength(1);
    }
  });

  it('🔴 le nom suit un renommage : l’ancien se libère, le nouveau se prend', async () => {
    // Sans la cascade de `tool_name`, l'index garderait l'ANCIEN nom : il refuserait le nom libéré et laisserait
    // passer le nouveau, c'est-à-dire le doublon que 0211 ferme.
    const ancien = await catalogue.ajouterConnecteur(tenantId, agentA, appel('ancien_nom'));
    expect((await catalogue.patch(tenantId, agentA, ancien!.id, { name: 'nouveau_nom' }))?.name).toBe('nouveau_nom');
    expect(await catalogue.ajouter(tenantId, agentA, action('ancien_nom'))).not.toBeNull();
    await refuse(catalogue.ajouter(tenantId, agentA, action('nouveau_nom')));
  });

  it('le même nom chez deux agents DIFFÉRENTS reste permis', async () => {
    // Le témoin : un index trop large (l'espace au lieu du consommateur) refuserait ce que 0157 a voulu permettre.
    expect(await catalogue.ajouterConnecteur(tenantId, agentA, appel('tarif'))).not.toBeNull();
    expect(await catalogue.ajouter(tenantId, agentB, action('tarif'))).not.toBeNull();
  });

  it('🔴 toute liaison écrite par le catalogue porte le nom de son outil', async () => {
    // Une liaison sans nom échapperait à l'index (`null` n'égale rien), et depuis 0213 la base la refuse. Les deux
    // chemins de l'agent de Meta sont joués ici, ceux des agents IA l'ont été plus haut : les quatre insertions.
    expect(await catalogue.ajouterConnecteurPourMba(tenantId, '1234567890', appel('appel_meta'))).not.toBeNull();
    expect(await catalogue.ajouterMaisonPourMba(tenantId, '1234567890', {
      name: 'marquer_vip_meta', title: 'VIP', description: 'Pose vip.', nePasUtiliser: '',
      cible: { handler: 'tag_fixe', tag: 'vip' },
    }, userId)).not.toBeNull();
    const r = await pool.query<{ total: string; sans_nom: string; fausses: string }>(
      `select count(*) as total,
              count(*) filter (where c.tool_name is null) as sans_nom,
              count(*) filter (where c.tool_name is distinct from t.name) as fausses
         from agent_tool_consommateurs c join agent_tools t on t.id = c.tool_id
        where c.tenant_id = $1`,
      [tenantId],
    );
    expect(Number(r.rows[0]!.total)).toBeGreaterThan(10);
    expect(r.rows[0]).toMatchObject({ sans_nom: '0', fausses: '0' });
  });
});
