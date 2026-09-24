import type { Pool } from 'pg';
import type { WorkflowGraph } from './graph';
import { makeCode } from '../ids/code';
import { resolveTenantCode } from '../ids/tenant-code';
import { scanOpening } from './engine';

/**
 * PAR QUOI ce scénario ouvre, quand il peut ouvrir une campagne. `null` = il ne le peut pas.
 *
 * 🔴 IL SE CALCULE DEPUIS LE GRAPHE, IL NE SE STOCKE PAS. Une colonne serait une seconde vérité à tenir
 * d'accord avec le graphe, et c'est le graphe qui fait foi : à la première divergence, c'est la colonne,
 * périmée, qu'on lirait.
 *
 * Miroir exact de la règle de l'écran (`web/lib/campaign-eligibility.ts`), calculé côté serveur pour que la
 * liste n'ait plus à envoyer les graphes au navigateur. Les deux s'appuient sur le même `scanOpening`, dont
 * la parité est déjà gardée par `tests/web-campaign-eligibility.test.ts`.
 *
 * Une campagne part sur une audience FROIDE : hors fenêtre de 24 h, seul un template (ou un bloc RCS, qui ne
 * passe pas par WhatsApp) peut ouvrir.
 *
 * ⚠️ L'ORDRE COMPTE : `rcsOpen` est examiné AVANT `firstTemplate`, comme dans la règle d'origine. Un
 * scénario qui ouvre par un bloc RCS ouvre en RCS, même s'il porte un template plus loin.
 *
 * ⚠️ LE MODÈLE SANS NOM EST REFUSÉ DEUX FOIS, et c'est REDONDANT PAR CONSTRUCTION (mesuré en mutant) :
 * `scanOpening` pose `unnamedOpeningTemplate` dans la même itération où il pose `firstTemplate`, donc la
 * garde du haut suffit et le contrôle du nom, en bas, n'est jamais le seul à décider. Les deux sont gardés
 * parce qu'ils viennent de la règle d'origine et qu'il s'agit d'un contrat lu par trois écrans : on ne
 * retire pas une ceinture sur ce chemin-là. Retirer les DEUX fait tomber `tests/workflow-ouverture.test.ts`.
 */
export type CanalOuverture = 'whatsapp' | 'rcs' | null;

export function canalDOuverture(graph: WorkflowGraph): CanalOuverture {
  const scan = scanOpening(graph);
  if (scan.sessionOpen || scan.waitBeforeTemplate || scan.ambiguousTemplate || scan.unnamedOpeningTemplate) return null;
  if (scan.rcsOpen) return 'rcs';
  if (!scan.firstTemplate) return null;
  return String(scan.firstTemplate.data.templateName ?? '').trim() !== '' ? 'whatsapp' : null;
}

/**
 * Le scénario peut-il OUVRIR une campagne ?
 *
 * 🔴 DÉRIVÉ DE `canalDOuverture`, ET PAS RECALCULÉ EN PARALLÈLE. Deux implémentations de la même règle
 * finissent par diverger, et la divergence serait muette : l'écran proposerait un scénario que la création
 * refuse, ou cacherait un scénario qu'elle accepte. `campaignEligible` est un contrat lu par TROIS écrans,
 * sa valeur ne doit pas bouger d'un pouce.
 */
function campagneOuvrable(graph: WorkflowGraph): boolean {
  return canalDOuverture(graph) !== null;
}

/**
 * Une ligne de la liste des scénarios, SANS les graphes. Ce que les écrans lisaient réellement du graphe est
 * devenu trois champs : combien de blocs, y a-t-il un brouillon, peut-il ouvrir une campagne.
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
   * Par quoi il ouvre, quand il le peut. `null` = il ne peut pas ouvrir de campagne.
   *
   * ⚠️ À CÔTÉ de `campaignEligible`, jamais à sa place : les trois écrans qui lisent le booléen continuent
   * de le lire. Le canal ne sert qu'à ne proposer, sur un étage donné, que des scénarios capables de
   * l'ouvrir.
   */
  canalOuverture: CanalOuverture;
}

/** Un scénario EN LIGNE tel que le catalogue de l'API publique le lit : le graphe PUBLIÉ, jamais le brouillon. */
export interface ScenarioPublie {
  code: string | null;
  name: string;
  /** null = mis en ligne avant que la date soit suivie (0095), pas « jamais publié ». */
  publishedAt: string | null;
  graph: WorkflowGraph;
}

export interface WorkflowRow {
  id: string;
  tenantId: string;
  name: string;
  /** Code public « scn_<client>_<ulid> » (schéma A). null tant que le backfill n'a pas tourné (lignes anciennes). */
  code?: string | null;
  /**
   * Le graphe PUBLIÉ : celui que l'exécuteur, les campagnes, les automations et l'API publique lisent. Il ne
   * change QUE par `publish`. Toutes les lectures d'exécution du dépôt passent par ce champ, et c'est
   * volontaire (cf. migration 0095).
   */
  graph: WorkflowGraph;
  /** Le BROUILLON en attente de publication. null = aucun, le publié fait foi. Seul l'éditeur le lit. */
  draftGraph?: WorkflowGraph | null;
  /** Dernière mise en ligne. null = jamais publié depuis l'arrivée du bouton (lignes antérieures comprises). */
  publishedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

const EMPTY_GRAPH: WorkflowGraph = { nodes: [], edges: [] };

/** Les colonnes lues partout : une seule liste, sinon un champ ajouté ici manque à une des quatre requêtes. */
const COLS = 'id, tenant_id, name, code, graph, draft_graph, published_at, created_at, updated_at';

/**
 * Résultat d'un enregistrement de l'éditeur.
 *
 * `brouillon` est l'état APRÈS écriture, tel que la base le voit : c'est lui, et pas « un PATCH a réussi »,
 * qui dit s'il reste quelque chose à publier. La nuance compte, parce qu'un enregistrement dont le contenu
 * est identique au publié ne laisse AUCUN brouillon derrière lui (cf. `update`), et l'éditeur ne doit alors
 * pas proposer de publier le vide.
 */
export interface MajScenario {
  /** Une ligne du tenant a-t-elle bougé ? false = scénario inconnu (ou d'un autre espace) -> 404. */
  trouve: boolean;
  /** Reste-t-il un brouillon non publié ? */
  brouillon: boolean;
}

/**
 * Suppression refusée par la base : un lien de chaîne WhatsApp (Channels Me) référence encore ce scénario
 * (`channelsme_links.workflow_id ... on delete restrict`, posée par la migration 0114 : la PREMIÈRE clé
 * étrangère `restrict` de ce dépôt vers `workflows`, les cinq autres étant `cascade` ou `set null`). Sans
 * cette traduction, la violation Postgres 23503 remonterait telle quelle au gestionnaire d'erreur global, donc
 * en 500, page d'erreur Cloudflare comprise, sans que l'utilisateur puisse deviner qu'un lien de chaîne bloque.
 */
export class WorkflowUtiliseParLienChaine extends Error {
  constructor() { super('ce scénario est utilisé par un lien de chaîne WhatsApp'); this.name = 'WorkflowUtiliseParLienChaine'; }
}

/**
 * Store Postgres des workflows (bot builder). Scopé tenant.
 *
 * 🔴 DEUX GRAPHES DEPUIS LE LOT 7 : `graph` est le PUBLIÉ (ce qui tourne), `draft_graph` le brouillon (ce qui
 * s'édite). Toute écriture de l'éditeur va au brouillon ; `graph` ne bouge que par `publish`. Écrire `graph`
 * ailleurs qu'ici remettrait l'édition en direct sur la production, ce que le bouton « Publier » est censé
 * empêcher.
 */
export class PgWorkflowStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Crée un scénario. Le graphe fourni part en BROUILLON, jamais en publié : rien n'est en ligne tant que
   * personne n'a cliqué « Publier ». Une seule règle à retenir, valable aussi pour la duplication.
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
   * La liste RÉSUMÉE, pour les écrans : jamais les graphes.
   *
   * 🔴 `list()` renvoie DEUX graphes complets par ligne (le publié et le brouillon), pour des écrans qui
   * n'affichent qu'un nom. Constat du contre-audit du 2026-09-01. Avec quelques dizaines de scénarios c'est
   * indolore ; avec des centaines de graphes riches, chaque écran paie le transfert et l'analyse de tous les
   * JSON pour rendre une colonne de libellés.
   *
   * Ce que les écrans faisaient RÉELLEMENT du graphe, et qui devient un champ : compter les blocs, savoir
   * s'il existe un brouillon, savoir si le scénario peut ouvrir une campagne. Les deux premiers se calculent
   * en SQL, sans transporter le graphe. L'éligibilité, elle, demande un parcours du graphe : elle est donc
   * calculée ICI, avec `scanOpening`, la MÊME fonction que la garde de création de campagne. La lire côté
   * navigateur obligeait à lui envoyer le graphe entier.
   *
   * ⚠️ Ce que ça ne fait PAS : la base envoie toujours le graphe à l'application (l'éligibilité en a besoin).
   * Ce qui disparaît est le trajet application -> navigateur et l'analyse JSON côté client, c'est-à-dire ce
   * que les écrans paient vraiment. Supprimer aussi la lecture en base demanderait de dénormaliser le nombre
   * de blocs et l'éligibilité en colonnes tenues à l'écriture, avec le risque de péremption que ça implique :
   * à faire le jour où la lecture pèse, pas avant.
   *
   * `list()` reste inchangée : la résolution d'un scénario ou d'un bloc par code (`/v1/sends`) a réellement
   * besoin des graphes.
   */
  async listResume(tenantId: string): Promise<WorkflowResumeRow[]> {
    const res = await this.pool.query<{
      id: string; tenant_id: string; name: string; code: string | null;
      created_at: Date; updated_at: Date; published_at: Date | null;
      node_count: number; has_draft: boolean; graph: WorkflowGraph;
    }>(
      // `jsonb_array_length` et `is not null` se calculent DANS Postgres : ces deux-là ne transportent rien.
      // `coalesce(...,'[]')` : un graphe sans `nodes` (ligne ancienne) ne doit pas faire échouer la requête
      // entière pour tous les scénarios de l'espace.
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
      // MÊME fonction que la garde serveur de création de campagne : l'écran ne peut donc pas proposer un
      // scénario que la création refusera, ni cacher un scénario qu'elle accepterait. Le booléen est DÉRIVÉ
      // du canal, donc les deux ne peuvent pas se contredire.
      campaignEligible: campagneOuvrable(r.graph),
      canalOuverture: canalDOuverture(r.graph),
    }));
  }

  /**
   * Les scénarios EN LIGNE, pour le catalogue de l'API publique (`GET /v1/scenarios`).
   *
   * 🔴 « EN LIGNE » VEUT DIRE : LE GRAPHE PUBLIÉ PORTE AU MOINS UN BLOC. Un scénario neuf part en brouillon
   * avec un publié VIDE (`insert`), et un envoi joue le publié : l'annoncer ferait construire à un
   * intégrateur un appel qui ne peut rien jouer. `published_at` ne décide PAS : il vaut null sur les
   * scénarios mis en ligne avant 0095, qui tournent pourtant.
   *
   * ⚠️ Le graphe est transporté parce que l'ouverture se calcule dessus (`ouvertureApi`, lot 2), comme
   * `listResume` le fait pour la console. Il ne sort pas vers l'intégrateur : la route n'en rend que
   * l'ouverture.
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

  /** MAJ partielle (name/graph). true si une ligne du tenant a bougé. `coalesce` : un champ absent
   *  ne l'écrase pas. Le graphe passé est DÉJÀ validé/sanitisé par la route (parseGraph).
   *
   *  ⚠️ Le graphe atterrit dans le BROUILLON. C'est ici que se joue la promesse du bouton « Publier » :
   *  l'éditeur enregistre en continu (auto-save toutes les 1,2 s), et aucune de ces écritures ne doit
   *  atteindre les contacts en cours de parcours. */
  async update(id: string, tenantId: string, patch: { name?: string; graph?: WorkflowGraph }): Promise<MajScenario> {
    const res = await this.pool.query<{ brouillon: boolean }>(
      // `forme` : le graphe débarrassé de ce qui ne change RIEN pour un contact, c'est-à-dire la POSITION des
      // blocs sur le canevas. Le moteur ne lit jamais `position` (seul `parseGraph` la valide) : déplacer un
      // bloc est du rangement, pas une modification à publier.
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
   * MET EN LIGNE le brouillon : il devient le graphe publié, et il n'y a pas de retour arrière (décision de
   * Julien le 2026-09-01 : on ne garde pas la version précédente).
   *
   * Idempotent et sans effet quand il n'y a rien à publier : `draft_graph` null laisse `graph` intact grâce au
   * `coalesce`. Sans lui, republier deux fois d'affilée écraserait le publié par NULL, donc effacerait le
   * scénario en production.
   *
   * Renvoie la ligne à jour (null si le scénario n'est pas au tenant) : l'appelant a besoin du graphe publié
   * et de la date pour répondre, et un second aller-retour pourrait déjà avoir été doublé par une autre
   * publication.
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
   * Jeton de test du scénario, créé À LA DEMANDE et STABLE ensuite : le lien wa.me et son QR restent valables,
   * on ne les régénère pas à chaque essai. Renvoie le jeton existant s'il y en a déjà un (idempotent), sinon
   * en pose un neuf. null si le scénario n'appartient pas au tenant.
   *
   * `coalesce` dans l'UPDATE + `returning` : un seul aller-retour, et deux clics simultanés sur « Tester » ne
   * peuvent pas produire deux jetons (le second lit celui que le premier vient d'écrire).
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
   * Scénario associé à un jeton de test. CHEMIN CHAUD (un message entrant qui ressemble à un jeton) : sert
   * l'index unique partiel `workflows_test_token_key`. Pas de scope tenant en entrée, justement parce que le
   * jeton est ce qui DÉSIGNE le tenant : c'est l'appelant qui vérifie ensuite que le numéro correspond.
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
 * Ce que l'ÉDITEUR ouvre, et ce que le lien de TEST joue : le brouillon s'il existe, sinon le publié.
 *
 * Un point de passage unique, parce que c'est la seule question à laquelle il ne faut pas répondre deux fois
 * de deux façons. Tout le reste du dépôt lit `row.graph`, c'est-à-dire le publié : essayer son scénario avant
 * de le mettre en ligne est précisément à quoi sert un brouillon, mais un contact réel, lui, ne doit jamais
 * tomber dedans.
 */
export function grapheEditable(row: WorkflowRow): WorkflowGraph {
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
