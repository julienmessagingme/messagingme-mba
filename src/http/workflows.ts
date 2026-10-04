import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import { parseGraph, isWorkflowNodeType } from '../workflow/graph';
import type { WorkflowGraph } from '../workflow/graph';
import type { WorkflowRow, MajScenario } from '../workflow/store.pg';
import type { WorkflowResumeRow } from '../workflow/store.pg';
import { mintNodeCodes } from '../workflow/node-codes';
import { collectNodes } from '../workflow/node-list';
import { newTestToken, waMeTestLink } from '../workflow/test-token';
import { grapheEditable, WorkflowUtiliseParLienChaine } from '../workflow/store.pg';
import { makeJournal, type AuditSink } from '../audit/journal';
import { espaceVerifie, nonEmpty, estUuid } from './scope';
import { executerFonctionJs } from '../workflow/fonction-js';
import { normaliserEtiquette } from '../crm/poser-etiquette';

/**
 * La sauvegarde n'exige pas qu'un scénario commence par un template : un scénario qui ouvre sur un message de
 * session est valide pour un déclenchement où la fenêtre est garantie. Les deux protections contre un envoi hors
 * fenêtre (Meta 131047) sont ailleurs : la garde de campagne (`http/campaigns.ts`, 400 si l'entrée n'est pas un
 * template) et la garde d'exécution (`workflow/executor.ts`, levée selon le type de lancement : `fenetreLevee`).
 */

/** Ce que les routes lisent et écrivent des scénarios. */
export interface ScenariosDep {
  insert(tenantId: string, name: string, graph: WorkflowGraph): Promise<{ id: string }>;
  list(tenantId: string): Promise<WorkflowRow[]>;
  /**
   * La liste résumée servie au navigateur : jamais les graphes, mais le nombre de blocs, l'existence d'un
   * brouillon et l'éligibilité en campagne, qui sont les trois seules choses que les écrans en tiraient.
   */
  listResume(tenantId: string): Promise<WorkflowResumeRow[]>;
  getById(id: string, tenantId: string): Promise<WorkflowRow | null>;
  update(id: string, tenantId: string, patch: { name?: string; graph?: WorkflowGraph }): Promise<MajScenario>;
  /**
   * Met le brouillon en ligne, seul chemin qui touche le graphe exécuté. Rend la ligne à jour, null si le
   * scénario n'est pas au tenant.
   */
  publish(id: string, tenantId: string): Promise<WorkflowRow | null>;
  remove(id: string, tenantId: string): Promise<boolean>;
  /** Pose (une fois) le jeton de test du scénario et le renvoie. null si le scénario n'est pas au tenant. */
  ensureTestToken(id: string, tenantId: string, token: string): Promise<string | null>;
}

export interface WorkflowRouteDeps {
  scenarios: ScenariosDep;
  /** Code client racine (tenants.public_code, self-heal) : sert à minter les codes publics des nodes au save. */
  tenantCode(tenantId: string): Promise<string>;
  publicites: {
    /**
     * Les publicités vivantes qui utilisent ce scénario, par leur nom ; vide = la suppression passe. Requise :
     * `publicites.workflow_id` est en `on delete set null`, donc un `delete` réussirait en silence et laisserait
     * une publicité dont les prospects, qui ont coûté un clic, n'arrivent nulle part. Les tests qui n'en parlent
     * pas déclarent `aucunePubliciteUtilise` (`tests/pubs-fixtures.ts`).
     */
    publicitesQuiUtilisent(tenantId: string, workflowId: string): Promise<string[]>;
  };
  /** Journal d'audit (les fixtures qui ne l'observent pas passent `journalMuet`). */
  audit: AuditSink;
  /** Déclare dans le référentiel Tags les tags saisis dans les blocs « ajout de tag » du graphe (best-effort). */
  declareTags(tenantId: string, tags: string[]): Promise<void>;
  /** Numéro WhatsApp affiché du tenant, pour construire le lien wa.me. null si aucun numéro connecté. */
  getDisplayPhoneNumber(tenantId: string): Promise<string | null>;
}

/** Tags saisis dans les blocs `tag` du graphe (dédupliqués, normalisés comme à la pose : `normaliserEtiquette`). */
function tagsInGraph(graph: WorkflowGraph): string[] {
  const out = new Set<string>();
  for (const n of graph.nodes) {
    const d = n.data as { tag?: unknown; actionKind?: unknown };
    // Bloc `tag` legacy OU bloc `action` en mode « ajouter un tag » : on déclare le tag posé dans le référentiel.
    // Un retrait de tag (remove_tag) ne « dé-déclare » rien -> ignoré ici.
    const isTagAdd = n.type === 'tag' || (n.type === 'action' && d.actionKind === 'add_tag');
    if (!isTagAdd) continue;
    const t = normaliserEtiquette(String(d.tag ?? ''));
    if (t !== '') out.add(t);
  }
  return [...out];
}

/**
 * Routes du bot builder (workflows), admin via `garde`, espace du JWT. Le graphe est toujours validé par
 * `parseGraph` avant persistance (400 si invalide). bodyLimit relevé : un graphe porte de la config par bloc.
 */
export function registerWorkflows(app: FastifyInstance, deps: WorkflowRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde, bodyLimit: 2 * 1024 * 1024 };
  const journal = makeJournal(deps.audit);

  /**
   * Éprouver une « Fonction JS » sur une valeur d'essai, depuis l'écran du bloc. Déclarée avant `/workflows/:id`
   * (sinon `js-test` serait lu comme un identifiant). 🔴 Du code écrit par le client tourne ici sur notre
   * infrastructure : par le même bac à sable et les mêmes plafonds que le parcours.
   */
  app.post('/tenants/:tenantId/workflows/js-test', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const b = (req.body ?? {}) as { code?: unknown; valeur?: unknown; champSource?: unknown };
    if (typeof b.code !== 'string') return reply.code(400).send({ error: 'code requis' });
    // La valeur d'essai est une chaîne, comme le sera le champ source à l'exécution : accepter un nombre ici
    // ferait réussir un essai que le parcours ne saurait pas reproduire.
    const valeur = typeof b.valeur === 'string' ? b.valeur : '';
    // 200 même en cas d'échec : l'erreur est le résultat de l'essai, pas une panne de la route. Le champ source
    // voyage jusqu'ici : le paramètre de la fonction porte son nom, comme à l'exécution. Il n'est pas validé ici,
    // `nomDeParametreSur` refuse déjà tout identifiant non sûr et retombe sur `valeur`.
    const champSource = typeof b.champSource === 'string' ? b.champSource : undefined;
    return reply.code(200).send(await executerFonctionJs(b.code, valeur,
      champSource ? { nomParametre: champSource } : {}));
  });

  app.post('/tenants/:tenantId/workflows', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const b = (req.body ?? {}) as { name?: unknown; graph?: unknown };
    if (!nonEmpty(b.name)) return reply.code(400).send({ error: 'name requis' });
    // graph optionnel à la création (démarrage vide) ; s'il est fourni, il doit être valide.
    const parsed = b.graph === undefined ? { nodes: [], edges: [] } : parseGraph(b.graph);
    if (parsed === null) return reply.code(400).send({ error: 'graphe invalide (nodes/edges, types, arêtes orphelines)' });
    // Mint serveur des codes publics de node (nod_<client>_<ulid>) : rempli/re-minté ici, jamais imposé par le client.
    const graph = mintNodeCodes(parsed, await deps.tenantCode(tenant));
    const { id } = await deps.scenarios.insert(tenant, b.name.trim(), graph);
    // Rend les tags des blocs « ajout de tag » visibles tout de suite dans Contenus > Tags (best-effort : ne
    // fait jamais échouer la sauvegarde du workflow).
    try { await deps.declareTags(tenant, tagsInGraph(graph)); } catch { /* best-effort */ }
    return reply.code(201).send({ id, name: b.name.trim(), graph });
  });

  // Dupliquer un scénario : un nouveau scénario « X (copie) » (puis « (copie 2) »…). Codes de node re-mintés :
  // `mintNodeCodes` conserverait sinon les codes valides, et la copie partagerait les identifiants publics de
  // l'original (contrat API cassé). Le `code` du scénario est minté frais à l'insertion.
  app.post('/tenants/:tenantId/workflows/:id/duplicate', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { id } = req.params as { id: string };
    if (!estUuid(id)) return reply.code(404).send({ error: 'workflow inconnu' });
    const source = await deps.scenarios.getById(id, tenant);
    if (!source) return reply.code(404).send({ error: 'workflow inconnu' });

    const taken = new Set((await deps.scenarios.list(tenant)).map((w) => w.name));
    let name = `${source.name} (copie)`;
    for (let n = 2; taken.has(name); n += 1) name = `${source.name} (copie ${n})`;

    // Retire le code de chaque node avant de re-minter. On copie ce que l'auteur voit (le brouillon s'il y en a
    // un), pas la version en ligne ; la copie naît en brouillon (cf. `insert`).
    const modele = grapheEditable(source);
    const stripped: WorkflowGraph = {
      nodes: modele.nodes.map((node) => ({ ...node, data: { ...node.data, code: undefined } })),
      edges: modele.edges,
    };
    const graph = mintNodeCodes(stripped, await deps.tenantCode(tenant));
    const { id: newId } = await deps.scenarios.insert(tenant, name, graph);
    try { await deps.declareTags(tenant, tagsInGraph(graph)); } catch { /* best-effort */ }
    return reply.code(201).send({ id: newId, name, graph });
  });

  app.get('/tenants/:tenantId/workflows', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    // Le résumé, pas les graphes : les écrans de liste n'affichent qu'un nom, et le graphe complet reste sur
    // `GET /workflows/:id`.
    return reply.code(200).send({ workflows: await deps.scenarios.listResume(tenant) });
  });

  // Contenu > Blocs : liste à plat de tous les nodes des scénarios de l'espace, requêtable par ?type=. Chaque
  // node porte son code public (nod_..., ou null s'il n'a jamais été re-sauvegardé). Lecture dérivée des workflows.
  app.get('/tenants/:tenantId/nodes', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const q = (req.query ?? {}) as { type?: unknown };
    const type = isWorkflowNodeType(q.type) ? q.type : undefined;
    const workflows = await deps.scenarios.list(tenant);
    return reply.code(200).send({ nodes: collectNodes(workflows, type) });
  });

  app.get('/tenants/:tenantId/workflows/:id', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { id } = req.params as { id: string };
    if (!estUuid(id)) return reply.code(404).send({ error: 'workflow inconnu' });
    const wf = await deps.scenarios.getById(id, tenant);
    if (!wf) return reply.code(404).send({ error: 'workflow inconnu' });
    return reply.code(200).send({ workflow: wf });
  });

  app.patch('/tenants/:tenantId/workflows/:id', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { id } = req.params as { id: string };
    if (!estUuid(id)) return reply.code(404).send({ error: 'workflow inconnu' });
    const b = (req.body ?? {}) as { name?: unknown; graph?: unknown };

    const patch: { name?: string; graph?: WorkflowGraph } = {};
    if (b.name !== undefined) {
      if (!nonEmpty(b.name)) return reply.code(400).send({ error: 'name vide' });
      patch.name = b.name.trim();
    }
    if (b.graph !== undefined) {
      const graph = parseGraph(b.graph);
      if (graph === null) return reply.code(400).send({ error: 'graphe invalide (nodes/edges, types, arêtes orphelines)' });
      // Mint serveur des codes de node (code valide du tenant conservé, absent/étranger re-minté).
      patch.graph = mintNodeCodes(graph, await deps.tenantCode(tenant));
    }
    if (Object.keys(patch).length === 0) return reply.code(400).send({ error: 'rien à modifier (name/graph)' });

    const maj = await deps.scenarios.update(id, tenant, patch);
    if (!maj.trouve) return reply.code(404).send({ error: 'workflow inconnu' });
    if (patch.graph) { try { await deps.declareTags(tenant, tagsInGraph(patch.graph)); } catch { /* best-effort */ } }
    // `brouillon` : reste-t-il quelque chose à publier après cette écriture ? C'est la base qui répond, et
    // c'est ce qui allume (ou éteint) le bouton « Publier ». L'éditeur ne peut pas le déduire seul : un
    // enregistrement identique au publié n'y laisse rien, et il s'en produit un à la simple ouverture d'un
    // scénario (React Flow mesure les blocs au montage).
    return reply.code(200).send({ id, ...patch, brouillon: maj.brouillon });
  });

  /**
   * Met en ligne le brouillon : seul chemin qui touche le graphe publié, donc qui change quelque chose pour les
   * contacts. Un parcours déjà en cours bascule sur la nouvelle version, une campagne programmée part avec la
   * version en ligne le jour de l'expédition. Sans retour arrière : la version précédente n'est conservée nulle part.
   */
  app.post('/tenants/:tenantId/workflows/:id/publish', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { id } = req.params as { id: string };
    if (!estUuid(id)) return reply.code(404).send({ error: 'workflow inconnu' });
    const row = await deps.scenarios.publish(id, tenant);
    if (!row) return reply.code(404).send({ error: 'workflow inconnu' });
    // Le journal porte qui a publié : la table `workflows`, elle, ne garde que la date. Détail non identifiant
    // (un nombre de blocs), comme partout dans ce journal.
    await journal(tenant, req, 'workflow.published', { kind: 'workflow', id }, { blocs: row.graph.nodes.length });
    return reply.code(200).send({ id, graph: row.graph, publishedAt: row.publishedAt ?? null });
  });

  app.delete('/tenants/:tenantId/workflows/:id', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { id } = req.params as { id: string };
    if (!estUuid(id)) return reply.code(404).send({ error: 'workflow inconnu' });
    /**
     * 🔴 Le refus se pose avant la suppression : la clé étrangère des publicités est en `on delete set null`, et
     * placé après, ce contrôle regarderait une publicité qui a déjà perdu son scénario.
     */
    const pubs = await deps.publicites.publicitesQuiUtilisent(tenant, id);
    if (pubs.length > 0) {
      return reply.code(409).send({
        error: `ce scénario répond aux prospects de ${pubs.length > 1 ? 'ces publicités' : 'cette publicité'} : ${pubs.slice(0, 3).join(', ')}${pubs.length > 3 ? '…' : ''}. Changez leur destination, ou supprimez-les, puis réessayez.`,
        code: 'utilise_par_publicite',
      });
    }
    try {
      const ok = await deps.scenarios.remove(id, tenant);
      if (!ok) return reply.code(404).send({ error: 'workflow inconnu' });
      return reply.code(200).send({ ok: true });
    } catch (err) {
      // `channelsme_links.workflow_id` est en `on delete restrict` : sans cette traduction, la violation 23503
      // sortirait en 500, sans dire qu'un lien de chaîne bloque.
      if (err instanceof WorkflowUtiliseParLienChaine) {
        return reply.code(409).send({ error: 'ce scénario est utilisé par un lien de chaîne WhatsApp : éteins le lien, puis réessaie' });
      }
      throw err;
    }
  });

  /**
   * Lien de test d'un scénario : le jeton, le lien wa.me et le numéro, pour tester depuis son téléphone sans
   * campagne. POST : le premier appel pose le jeton, idempotent ensuite. `link` null = aucun numéro connecté ; le
   * jeton est rendu quand même (le testeur peut écrire le mot à la main).
   */
  app.post('/tenants/:tenantId/workflows/:id/test-link', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { id } = req.params as { id: string };
    if (!estUuid(id)) return reply.code(404).send({ error: 'workflow inconnu' });
    const token = await deps.scenarios.ensureTestToken(id, tenant, newTestToken());
    if (token === null) return reply.code(404).send({ error: 'workflow inconnu' });
    const phone = await deps.getDisplayPhoneNumber(tenant);
    return reply.code(200).send({ token, phone, link: waMeTestLink(phone, token) });
  });
}
