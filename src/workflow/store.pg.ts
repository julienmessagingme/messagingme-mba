import type { Pool } from 'pg';
import type { WorkflowGraph } from './graph';
import { makeCode } from '../ids/code';
import { resolveTenantCode } from '../ids/tenant-code';
import { scanOpening } from './engine';

/**
 * Par quoi ce scénario ouvre, quand il peut ouvrir une campagne. `null` = il ne le peut pas.
 *
 * Calculé depuis le graphe, jamais stocké : une colonne serait une seconde vérité qui finirait périmée.
 * Miroir de la règle de l'écran (`web/lib/campaign-eligibility.ts`), sur le même `scanOpening` (parité gardée
 * par `tests/web-campaign-eligibility.test.ts`), calculé côté serveur pour ne pas envoyer les graphes au
 * navigateur.
 *
 * Une campagne part sur une audience froide : hors fenêtre de 24 h, seul un template (ou un bloc RCS) peut
 * ouvrir. `rcsOpen` est examiné avant `firstTemplate` : un scénario qui ouvre par un bloc RCS ouvre en RCS,
 * même s'il porte un template plus loin. Le modèle sans nom est refusé deux fois (redondant, gardé comme
 * ceinture sur un contrat lu par trois écrans).
 */
export type CanalOuverture = 'whatsapp' | 'rcs' | null;

export function canalDOuverture(graph: WorkflowGraph): CanalOuverture {
  const scan = scanOpening(graph);
  if (scan.sessionOpen || scan.waitBeforeTemplate || scan.ambiguousTemplate || scan.unnamedOpeningTemplate) return null;
  if (scan.rcsOpen) return 'rcs';
  if (!scan.firstTemplate) return null;
  return String(scan.firstTemplate.data.templateName ?? '').trim() !== '' ? 'whatsapp' : null;
}

/** 'inconnu' = absent de cet espace. 'vide' = aucune version publiée. 'ok' = démarrable. */
export type EtatScenario = 'inconnu' | 'vide' | 'ok';

/**
 * Ce scénario peut-il DÉMARRER ? La question que se posent ceux qui désignent un scénario à démarrer plus tard, sans
 * personne devant : le bouton d'un lien de chaîne, la bulle d'un widget. Écrite une fois, pour eux deux.
 *
 * « Aucune version publiée » se lit sur le graphe PUBLIÉ, le seul que l'exécuteur lise : vide, il ne démarrerait
 * rien, même avec un brouillon à côté. `null` = la lecture par `getById(id, tenant)` n'a rien trouvé, donc un
 * scénario d'un autre espace se lit comme un inconnu.
 *
 * ⚠️ Une ancienne ligne peut porter un graphe SANS `nodes` (`listResume` le prévoit par `coalesce`) : lire
 * `.length` sans garde lèverait, donc une 500 à la console et un « échec interne » au MCP pour un scénario que
 * `list_scenarios` montre pourtant comme non publié. Il se lit `vide`, comme ce qu'il est.
 */
export function etatDuScenario(wf: Pick<WorkflowRow, 'graph'> | null): EtatScenario {
  if (wf === null) return 'inconnu';
  return (wf.graph.nodes?.length ?? 0) > 0 ? 'ok' : 'vide';
}

/**
 * Une ligne de la liste des scénarios, sans les graphes : ce que les écrans en lisaient est devenu trois
 * champs (nombre de blocs, brouillon, ouverture de campagne).
 */
export interface WorkflowResumeRow {
  id: string;
  tenantId: string;
  name: string;
  code: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  nodeCount: number;
  hasDraft: boolean;
  campaignEligible: boolean;
  /**
   * Par quoi il ouvre, quand il le peut. `null` = il ne peut pas ouvrir de campagne. À côté de
   * `campaignEligible`, jamais à sa place : il sert à ne proposer, sur un étage, que des scénarios capables
   * de l'ouvrir.
   */
  canalOuverture: CanalOuverture;
}

/** Un scénario en ligne tel que le catalogue de l'API publique le lit : le graphe publié, jamais le brouillon. */
export interface ScenarioPublie {
  code: string | null;
  name: string;
  /** null = mis en ligne avant que la date soit suivie, pas « jamais publié ». */
  publishedAt: string | null;
  graph: WorkflowGraph;
}

export interface WorkflowRow {
  id: string;
  tenantId: string;
  name: string;
  /** Code public « scn_<client>_<ulid> ». null tant que le backfill n'a pas tourné (lignes anciennes). */
  code?: string | null;
  /**
   * Le graphe publié : celui que l'exécuteur, les campagnes, les automations et l'API publique lisent. Il ne
   * change que par `publish`.
   */
  graph: WorkflowGraph;
  /** Le brouillon en attente de publication. null = aucun, le publié fait foi. Seul l'éditeur le lit. */
  draftGraph?: WorkflowGraph | null;
  /** Dernière mise en ligne. null = jamais publié depuis l'arrivée du bouton (lignes antérieures comprises). */
  publishedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

const EMPTY_GRAPH: WorkflowGraph = { nodes: [], edges: [] };

/** Les colonnes lues partout : une seule liste, sinon un champ ajouté manque à l'une des requêtes. */
const COLS = 'id, tenant_id, name, code, graph, draft_graph, published_at, created_at, updated_at';

/**
 * Résultat d'un enregistrement de l'éditeur. `brouillon` est l'état après écriture : un enregistrement
 * identique au publié ne laisse aucun brouillon (cf. `update`), et l'éditeur ne doit pas proposer de publier
 * le vide.
 */
export interface MajScenario {
  /** Une ligne du tenant a-t-elle bougé ? false = scénario inconnu (ou d'un autre espace) -> 404. */
  trouve: boolean;
  /** Reste-t-il un brouillon non publié ? */
  brouillon: boolean;
}

/**
 * Suppression refusée par la base : un lien de chaîne WhatsApp (Channels Me) référence encore ce scénario
 * (`channelsme_links.workflow_id ... on delete restrict`). Traduite en 409, sinon la violation 23503
 * remonterait en 500 sans dire qu'un lien de chaîne bloque.
 */
export class WorkflowUtiliseParLienChaine extends Error {
  constructor() { super('ce scénario est utilisé par un lien de chaîne WhatsApp'); this.name = 'WorkflowUtiliseParLienChaine'; }
}

/**
 * Store Postgres des workflows (bot builder). Scopé tenant.
 *
 * Deux graphes : `graph` est le publié (ce qui tourne), `draft_graph` le brouillon (ce qui s'édite). Toute
 * écriture de l'éditeur va au brouillon ; `graph` ne bouge que par `publish`. L'écrire ailleurs remettrait
 * l'édition en direct sur la production.
 */
export class PgWorkflowStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Crée un scénario. Le graphe fourni part en brouillon, jamais en publié : rien n'est en ligne tant que
   * personne n'a cliqué « Publier » (vaut aussi pour la duplication).
   */
  async insert(tenantId: string, name: string, graph: WorkflowGraph): Promise<{ id: string }> {
    const code = makeCode('scn', await resolveTenantCode(this.pool, tenantId));
    const res = await this.pool.query<{ id: string }>(
      `insert into workflows (tenant_id, name, draft_graph, code) values ($1, $2, $3::jsonb, $4) returning id`,
      [tenantId, name, JSON.stringify(graph), code],
    );
    return { id: res.rows[0]!.id };
  }

  /**
   * La liste résumée, pour les écrans : jamais les graphes, qui pèseraient sur chaque écran qui n'affiche
   * qu'un nom.
   *
   * Nombre de blocs et présence d'un brouillon se calculent en SQL ; l'éligibilité demande un parcours du
   * graphe et se calcule ici, avec `scanOpening`, la même fonction que la garde de création de campagne. La
   * base envoie donc toujours le graphe à l'application : seul le trajet vers le navigateur disparaît. `list()`
   * reste pour ce qui a réellement besoin des graphes (résolution par code de `/v1/sends`).
   */
  async listResume(tenantId: string): Promise<WorkflowResumeRow[]> {
    const res = await this.pool.query<{
      id: string; tenant_id: string; name: string; code: string | null;
      created_at: Date; updated_at: Date; published_at: Date | null;
      node_count: number; has_draft: boolean; graph: WorkflowGraph;
    }>(
      // `jsonb_array_length` et `is not null` se calculent dans Postgres. `coalesce(...,'[]')` : un graphe sans
      // `nodes` (ligne ancienne) ne doit pas faire échouer la requête pour tout l'espace.
      `select id, tenant_id, name, code, created_at, updated_at, published_at,
              jsonb_array_length(coalesce(graph->'nodes', '[]'::jsonb)) as node_count,
              (draft_graph is not null) as has_draft,
              graph
         from workflows where tenant_id = $1 order by created_at desc`,
      [tenantId],
    );
    return res.rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      name: r.name,
      code: r.code,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
      publishedAt: r.published_at ? r.published_at.toISOString() : null,
      nodeCount: r.node_count,
      hasDraft: r.has_draft,
      // Même fonction que la garde serveur de création de campagne : l'écran ne peut ni proposer un scénario
      // qu'elle refusera, ni cacher un scénario qu'elle accepterait. Le booléen est dérivé du canal.
      campaignEligible: canalDOuverture(r.graph) !== null,
      canalOuverture: canalDOuverture(r.graph),
    }));
  }

  /**
   * Les scénarios en ligne, pour le catalogue de l'API publique (`GET /v1/scenarios`).
   *
   * « En ligne » = le graphe publié porte au moins un bloc. Un scénario neuf a un publié vide (`insert`) et un
   * envoi joue le publié : l'annoncer ferait construire un appel qui ne joue rien. `published_at` ne décide
   * pas : il vaut null sur des scénarios anciens qui tournent. Le graphe est transporté pour calculer
   * l'ouverture (`ouvertureApi`), il ne sort pas vers l'intégrateur.
   */
  async listPublies(tenantId: string): Promise<ScenarioPublie[]> {
    const res = await this.pool.query<{ code: string | null; name: string; published_at: Date | null; graph: WorkflowGraph }>(
      `select code, name, published_at, graph
         from workflows
        where tenant_id = $1
          and jsonb_array_length(coalesce(graph->'nodes', '[]'::jsonb)) > 0
        order by name, created_at`,
      [tenantId],
    );
    return res.rows.map((r) => ({
      code: r.code,
      name: r.name,
      publishedAt: r.published_at ? r.published_at.toISOString() : null,
      graph: r.graph,
    }));
  }

  async list(tenantId: string): Promise<WorkflowRow[]> {
    const res = await this.pool.query<Row>(
      `select ${COLS} from workflows where tenant_id = $1 order by created_at desc`,
      [tenantId],
    );
    return res.rows.map(toRow);
  }

  async getById(id: string, tenantId: string): Promise<WorkflowRow | null> {
    const res = await this.pool.query<Row>(
      `select ${COLS} from workflows where id = $1 and tenant_id = $2 limit 1`,
      [id, tenantId],
    );
    const r = res.rows[0];
    return r ? toRow(r) : null;
  }

  /** MAJ partielle (name/graph). `coalesce` : un champ absent ne l'écrase pas. Le graphe passé est déjà
   *  validé/sanitisé par la route (parseGraph).
   *
   *  Le graphe atterrit dans le brouillon : l'éditeur enregistre en continu (auto-save), et aucune de ces
   *  écritures ne doit atteindre les contacts en cours de parcours. */
  async update(id: string, tenantId: string, patch: { name?: string; graph?: WorkflowGraph }): Promise<MajScenario> {
    const res = await this.pool.query<{ brouillon: boolean }>(
      // `forme` : le graphe sans la position des blocs, que le moteur ne lit jamais : déplacer un bloc est du
      // rangement, pas une modification à publier.
      `with sans_positions as (
         select jsonb_build_object(
           'edges', w.graph->'edges',
           'nodes', (select coalesce(jsonb_agg(n - 'position' order by ord), '[]'::jsonb)
                       from jsonb_array_elements(coalesce(w.graph->'nodes', '[]'::jsonb)) with ordinality as t(n, ord))
         ) as forme
         from workflows w where w.id = $1 and w.tenant_id = $2
       ),
       neuf as (
         select $4::jsonb as g, jsonb_build_object(
           'edges', $4::jsonb->'edges',
           'nodes', (select coalesce(jsonb_agg(n - 'position' order by ord), '[]'::jsonb)
                       from jsonb_array_elements(coalesce($4::jsonb->'nodes', '[]'::jsonb)) with ordinality as t(n, ord))
         ) as forme
       )
       update workflows w set
         name = coalesce($3, name),
         -- MÊME SCÉNARIO, blocs déplacés : la nouvelle disposition va DANS le publié. Le rangement est
         -- conservé (il serait perdu au rechargement) sans demander à personne de publier une mise en page.
         graph = case when n.g is not null and n.forme = c.forme then n.g else w.graph end,
         -- Un brouillon IDENTIQUE au publié, AUX POSITIONS PRÈS, n'en est pas un : on le ramène à null, et
         -- l'écran cesse d'annoncer « modifications non publiées ». Sans ce cas, la simple OUVERTURE d'un
         -- scénario suffisait à en poser un (React Flow mesure les blocs au montage, ce qui déclenche
         -- l'auto-save), et tout scénario seulement consulté aurait porté le badge à vie.
         --
         -- ⚠️ Sans le cas des POSITIONS, le badge revenait indéfiniment (constaté le 2026-09-02) : publier,
         -- puis pousser un bloc de 40 px, et l'écran réclame de publier à nouveau. À deux sur un même
         -- scénario, plus personne ne pouvait le voir « en ligne ».
         draft_graph = case
           when n.g is null then w.draft_graph
           when n.forme = c.forme then null
           else n.g
         end,
         updated_at = now()
       from sans_positions c, neuf n
       where w.id = $1 and w.tenant_id = $2
       returning w.draft_graph is not null as brouillon`,
      [id, tenantId, patch.name ?? null, patch.graph ? JSON.stringify(patch.graph) : null],
    );
    const r = res.rows[0];
    return r ? { trouve: true, brouillon: r.brouillon } : { trouve: false, brouillon: false };
  }

  /**
   * Met en ligne le brouillon : il devient le graphe publié, sans retour arrière (la version précédente n'est
   * pas gardée).
   *
   * Sans effet quand il n'y a rien à publier : `draft_graph` null laisse `graph` intact grâce au `coalesce`.
   * Sans lui, republier deux fois écraserait le publié par NULL, donc effacerait le scénario en production.
   *
   * Renvoie la ligne à jour (null si le scénario n'est pas au tenant), en un seul aller-retour qu'une autre
   * publication ne peut pas doubler.
   */
  async publish(id: string, tenantId: string): Promise<WorkflowRow | null> {
    const res = await this.pool.query<Row>(
      `update workflows set
         graph = coalesce(draft_graph, graph),
         -- La date ne bouge QUE s'il y avait quelque chose à mettre en ligne : sinon elle daterait d'un clic
         -- une publication qui n'a rien changé, et on ne pourrait plus dire depuis quand la version en cours
         -- est en ligne.
         published_at = case when draft_graph is not null then now() else published_at end,
         draft_graph = null,
         updated_at = now()
       where id = $1 and tenant_id = $2
       returning ${COLS}`,
      [id, tenantId],
    );
    const r = res.rows[0];
    return r ? toRow(r) : null;
  }

  /**
   * Supprime le scénario. Lève `WorkflowUtiliseParLienChaine` (traduite en 409 par la route) quand un lien de
   * chaîne WhatsApp le référence encore : `channelsme_links.workflow_id` est en `on delete restrict`, donc
   * Postgres refuse la suppression (23503) plutôt que de la laisser passer.
   */
  async remove(id: string, tenantId: string): Promise<boolean> {
    try {
      const res = await this.pool.query(`delete from workflows where id = $1 and tenant_id = $2`, [id, tenantId]);
      return (res.rowCount ?? 0) > 0;
    } catch (err) {
      if ((err as { code?: string } | null)?.code === '23503') throw new WorkflowUtiliseParLienChaine();
      throw err;
    }
  }

  /**
   * Jeton de test du scénario, créé à la demande puis stable (le lien wa.me et son QR restent valables).
   * Renvoie le jeton existant, sinon en pose un neuf ; null si le scénario n'appartient pas au tenant.
   * `coalesce` dans l'UPDATE : deux clics simultanés sur « Tester » ne peuvent pas produire deux jetons.
   */
  async ensureTestToken(id: string, tenantId: string, token: string): Promise<string | null> {
    const res = await this.pool.query<{ test_token: string }>(
      `update workflows set test_token = coalesce(test_token, $3), updated_at = updated_at
       where id = $1 and tenant_id = $2 returning test_token`,
      [id, tenantId, token],
    );
    return res.rows[0]?.test_token ?? null;
  }

  /**
   * Scénario associé à un jeton de test. Chemin chaud (un message entrant qui ressemble à un jeton), servi
   * par l'index unique partiel `workflows_test_token_key`. 🔴 Pas de scope tenant en entrée : le jeton désigne
   * le tenant, et c'est l'appelant qui vérifie ensuite que le numéro correspond.
   */
  async findByTestToken(token: string): Promise<WorkflowRow | null> {
    const res = await this.pool.query<Row>(
      `select ${COLS} from workflows where test_token = $1 limit 1`,
      [token],
    );
    const r = res.rows[0];
    return r ? toRow(r) : null;
  }
}

/**
 * Ce que l'éditeur ouvre, et ce que le lien de test joue : le brouillon s'il existe, sinon le publié. Point
 * de passage unique : tout le reste du dépôt lit `row.graph` (le publié), et un contact réel ne doit jamais
 * tomber dans un brouillon.
 */
export function grapheEditable(row: Pick<WorkflowRow, 'graph' | 'draftGraph'>): WorkflowGraph {
  return row.draftGraph ?? row.graph;
}

interface Row {
  id: string; tenant_id: string; name: string; code: string | null;
  graph: WorkflowGraph | null; draft_graph: WorkflowGraph | null;
  published_at: Date | null; created_at: Date; updated_at: Date;
}
function toRow(r: Row): WorkflowRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    code: r.code,
    graph: r.graph ?? EMPTY_GRAPH,
    draftGraph: r.draft_graph ?? null,
    publishedAt: r.published_at ? r.published_at.toISOString() : null,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}
