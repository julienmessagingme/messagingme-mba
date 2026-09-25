import type { FastifyInstance } from 'fastify';
import { forbidNonAdmin } from '../auth/middleware';
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
import { scopeTenant, nonEmpty, estUuid } from './scope';
import { executerFonctionJs } from '../workflow/fonction-js';

/**
 * NOTE (Lot D) : le SAVE n'exige PLUS qu'un scénario commence par un template. Un scénario peut désormais
 * ouvrir sur un formulaire / message rapide : il n'est simplement pas utilisable en CAMPAGNE broadcast (audience
 * froide, hors fenêtre 24 h), mais il est parfaitement valide pour un déclenchement où la fenêtre est garantie
 * (contact qui vient d'écrire : /v1/sends cible node, avance par webhook, et demain les déclencheurs Automation).
 *
 * Les deux protections qui comptent restent EN PLACE et sont indépendantes de ce save :
 *  - garde CAMPAGNE (`http/campaigns.ts`) : POST /campaigns refuse en 400 un workflow dont l'entrée n'est pas un
 *    template. C'est elle qui empêche réellement un envoi hors fenêtre (Meta 131047).
 *  - garde RUNTIME (`workflow/executor.ts` runFrom) : `start()` refuse de démarrer un run dont les actions
 *    ouvrent par un message de session, sauf `allowSessionOpen` (posé par le seul chemin qui a vérifié la fenêtre).
 */

export interface WorkflowRouteDeps {
  createWorkflow(tenantId: string, name: string, graph: WorkflowGraph): Promise<{ id: string }>;
  /** Code client racine (tenants.public_code, self-heal) : sert à minter les codes publics des nodes au save. */
  tenantCode(tenantId: string): Promise<string>;
  listWorkflows(tenantId: string): Promise<WorkflowRow[]>;
  /**
   * La liste RÉSUMÉE servie au navigateur : jamais les graphes, mais le nombre de blocs, l'existence d'un
   * brouillon et l'éligibilité en campagne, qui sont les trois seules choses que les écrans en tiraient.
   *
   * Optionnelle : absente, la route retombe sur `listWorkflows` (comportement d'avant, graphes compris).
   * C'est ce qui permet aux câblages de test de ne rien changer.
   */
  listWorkflowsResume?(tenantId: string): Promise<WorkflowResumeRow[]>;
  getWorkflow(id: string, tenantId: string): Promise<WorkflowRow | null>;
  updateWorkflow(id: string, tenantId: string, patch: { name?: string; graph?: WorkflowGraph }): Promise<MajScenario>;
  /** Met le brouillon EN LIGNE. Rend la ligne à jour, null si le scénario n'est pas au tenant. Absent ->
   *  la route de publication répond 503 (câblages de test qui ne montent pas le store). */
  publishWorkflow?(id: string, tenantId: string): Promise<WorkflowRow | null>;
  deleteWorkflow(id: string, tenantId: string): Promise<boolean>;
  /**
   * LES PUBLICITÉS VIVANTES QUI UTILISENT CE SCÉNARIO, par leur nom. Vide = aucune, la suppression passe.
   *
   * 🔴 REQUISE, JAMAIS OPTIONNELLE, et c'est une garde au sens strict. `publicites.workflow_id` est en
   * `on delete set null` (migration 0170), choisi pour qu'une suppression de scénario ne fasse jamais
   * échouer une contrainte sur un geste ordinaire. La conséquence est qu'un `delete` RÉUSSIT en silence et
   * laisse la publicité avec une destination `scenario` et plus aucun scénario : ses prospects, qui ont
   * coûté un clic, n'arrivent alors nulle part. Un câblage qui oublierait cette dépendance produirait
   * exactement ce trou, et rien ne le signalerait. Le dépôt a payé deux fois ce motif (`estDesabonne`,
   * la garde d'authentification), d'où le type qui l'impose.
   *
   * ⚠️ Les câblages de test qui ne parlent pas de publicités déclarent `aucunePubliciteUtilise`
   * (`tests/pubs-fixtures.ts`), qui DIT l'hypothèse au lieu de la cacher, comme `jamaisDesabonne`.
   */
  publicitesQuiUtilisent(tenantId: string, workflowId: string): Promise<string[]>;
  /** Journal d'audit. Optionnel : absent -> publication sans trace (câblages de test). */
  audit?: AuditSink;
  /** Déclare dans le référentiel Tags les tags saisis dans les blocs « ajout de tag » du graphe (best-effort).
   *  Absent -> pas de déclaration (rétro-compatible). */
  declareTags?(tenantId: string, tags: string[]): Promise<void>;
  /** Pose (une fois) le jeton de test du scénario et le renvoie. null si le scénario n'est pas au tenant. */
  ensureTestToken?(id: string, tenantId: string, token: string): Promise<string | null>;
  /** Numéro WhatsApp affiché du tenant, pour construire le lien wa.me. null si aucun numéro connecté. */
  getDisplayPhoneNumber?(tenantId: string): Promise<string | null>;
}

/** Tags saisis dans les blocs `tag` du graphe (dédupliqués, trim + tronqués à 64 comme la route Tags). */
function tagsInGraph(graph: WorkflowGraph): string[] {
  const out = new Set<string>();
  for (const n of graph.nodes) {
    const d = n.data as { tag?: unknown; actionKind?: unknown };
    // Bloc `tag` legacy OU bloc `action` en mode « ajouter un tag » : on déclare le tag posé dans le référentiel.
    // Un retrait de tag (remove_tag) ne « dé-déclare » rien -> ignoré ici.
    const isTagAdd = n.type === 'tag' || (n.type === 'action' && d.actionKind === 'add_tag');
    if (!isTagAdd) continue;
    const t = String(d.tag ?? '').trim().slice(0, 64);
    if (t !== '') out.add(t);
  }
  return [...out];
}

/**
 * Routes du bot builder (workflows). Admin-only via `garde`. Tenant dérivé du JWT. Le graphe est TOUJOURS
 * validé/sanitisé par `parseGraph` avant persistance (400 si invalide). bodyLimit relevé : un graphe peut
 * porter plusieurs blocs avec de la config. PB1 : CRUD + graphe. Pas d'exécution (PB2).
 */
export function registerWorkflows(app: FastifyInstance, deps: WorkflowRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde, bodyLimit: 2 * 1024 * 1024 };
  const journal = makeJournal(deps.audit);

  /**
   * ÉPROUVER une « Fonction JS » sur une valeur d'essai, depuis l'écran du bloc.
   *
   * 🔴 DÉCLARÉE AVANT `/workflows/:id`, et ce n'est pas cosmétique : `js-test` serait sinon lu comme un
   * identifiant de scénario. Le dépôt a déjà payé ce piège sur `/conversations/unread-count`.
   *
   * ⚠️ CE BOUTON FAIT TOURNER DU CODE ÉCRIT PAR LE CLIENT sur notre infrastructure, exactement comme le
   * parcours le fera. Il passe donc par LE MÊME bac à sable, avec les mêmes plafonds : un essai qui
   * réussirait là où l'exécution échoue serait pire que pas d'essai du tout. Réservé aux administrateurs,
   * comme tout ce module.
   */
  app.post('/tenants/:tenantId/workflows/js-test', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const b = (req.body ?? {}) as { code?: unknown; valeur?: unknown; champSource?: unknown };
    if (typeof b.code !== 'string') return reply.code(400).send({ error: 'code requis' });
    // La valeur d'essai est une CHAÎNE, comme le sera le champ source à l'exécution : accepter un nombre ici
    // ferait réussir un essai que le parcours ne saurait pas reproduire.
    const valeur = typeof b.valeur === 'string' ? b.valeur : '';
    // 200 même en cas d'échec : l'erreur est le RÉSULTAT de l'essai, pas une panne de la route. Un 4xx ferait
    // afficher un message d'infrastructure là où le client attend la faute de SON code.
    /**
     * 🔴 LE CHAMP SOURCE VOYAGE JUSQU'ICI, ET SON ABSENCE ÉTAIT UN DÉFAUT (relevé en revue le 2026-09-14).
     * Le paramètre de la fonction porte le nom du champ choisi ; sans lui, l'essai échouait sur
     * « adresse is not defined » alors que le MÊME code marche en production. C'est exactement le symptôme
     * que ce lot répare, laissé intact sur le seul chemin où le client le vérifie, et ça démentait la
     * promesse écrite juste à côté (« le même bac à sable que l'exécution »).
     *
     * ⚠️ NON VALIDÉ ICI, et ce n'est pas un oubli : `nomDeParametreSur` refuse déjà tout ce qui n'est pas un
     * identifiant JavaScript sûr, et retombe sur `valeur`. Une garde de plus ne ferait que dupliquer la règle.
     */
    const champSource = typeof b.champSource === 'string' ? b.champSource : undefined;
    return reply.code(200).send(await executerFonctionJs(b.code, valeur,
      champSource ? { nomParametre: champSource } : {}));
  });

  app.post('/tenants/:tenantId/workflows', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const b = (req.body ?? {}) as { name?: unknown; graph?: unknown };
    if (!nonEmpty(b.name)) return reply.code(400).send({ error: 'name requis' });
    // graph optionnel à la création (démarrage vide) ; s'il est fourni, il doit être valide.
    const parsed = b.graph === undefined ? { nodes: [], edges: [] } : parseGraph(b.graph);
    if (parsed === null) return reply.code(400).send({ error: 'graphe invalide (nodes/edges, types, arêtes orphelines)' });
    // Mint SERVEUR des codes publics de node (nod_<client>_<ulid>) : rempli/re-minté ici, jamais imposé par le client.
    const graph = mintNodeCodes(parsed, await deps.tenantCode(tenant));
    const { id } = await deps.createWorkflow(tenant, b.name.trim(), graph);
    // Rend les tags des blocs « ajout de tag » visibles tout de suite dans Contenus > Tags (best-effort : ne
    // fait jamais échouer la sauvegarde du workflow).
    if (deps.declareTags) { try { await deps.declareTags(tenant, tagsInGraph(graph)); } catch { /* best-effort */ } }
    return reply.code(201).send({ id, name: b.name.trim(), graph });
  });

  // Dupliquer un scénario : clone le graphe en un NOUVEAU scénario. Nom « X (copie) » (puis « (copie 2) »… si
  // pris). Codes de node RE-MINTÉS : sans ça, mintNodeCodes CONSERVE les codes valides du même tenant -> la copie
  // partagerait les identifiants publics de l'original (contrat API cassé). Le `code` du scénario est minté frais
  // par createWorkflow (insert). Aucune méthode store dédiée : réutilise getWorkflow/listWorkflows/createWorkflow.
  app.post('/tenants/:tenantId/workflows/:id/duplicate', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    if (!estUuid(id)) return reply.code(404).send({ error: 'workflow inconnu' });
    const source = await deps.getWorkflow(id, tenant);
    if (!source) return reply.code(404).send({ error: 'workflow inconnu' });

    const taken = new Set((await deps.listWorkflows(tenant)).map((w) => w.name));
    let name = `${source.name} (copie)`;
    for (let n = 2; taken.has(name); n += 1) name = `${source.name} (copie ${n})`;

    // Retire le code de chaque node AVANT de re-minter -> tous les codes sont frais (jamais conservés de la source).
    // On copie ce que l'auteur VOIT dans l'éditeur (le brouillon s'il y en a un), pas la version en ligne :
    // dupliquer sert à repartir de son travail en cours. La copie, elle, naît en brouillon (cf. `insert`).
    const modele = grapheEditable(source);
    const stripped: WorkflowGraph = {
      nodes: modele.nodes.map((node) => ({ ...node, data: { ...node.data, code: undefined } })),
      edges: modele.edges,
    };
    const graph = mintNodeCodes(stripped, await deps.tenantCode(tenant));
    const { id: newId } = await deps.createWorkflow(tenant, name, graph);
    if (deps.declareTags) { try { await deps.declareTags(tenant, tagsInGraph(graph)); } catch { /* best-effort */ } }
    return reply.code(201).send({ id: newId, name, graph });
  });

  app.get('/tenants/:tenantId/workflows', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    // 🔴 Le RÉSUMÉ, pas les graphes. La liste renvoyait DEUX graphes complets par ligne (le publié et le
    // brouillon) pour des écrans qui n'affichent qu'un nom : avec des centaines de scénarios, chaque écran
    // paie le transfert et l'analyse de tous les JSON. Le graphe complet reste sur `GET /workflows/:id`,
    // que l'écran d'édition appelle déjà à l'ouverture.
    if (deps.listWorkflowsResume) return reply.code(200).send({ workflows: await deps.listWorkflowsResume(tenant) });
    return reply.code(200).send({ workflows: await deps.listWorkflows(tenant) });
  });

  // Contenu > Blocs : liste à plat de TOUS les nodes des scénarios du tenant, requêtable par ?type=.
  // Chaque node porte son code public (nod_..., ou null s'il n'a jamais été re-sauvegardé depuis le Lot 4b).
  // Route de LECTURE : dérivée des workflows (aucun store dédié), admin-only via `opts`.
  app.get('/tenants/:tenantId/nodes', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const q = (req.query ?? {}) as { type?: unknown };
    const type = isWorkflowNodeType(q.type) ? q.type : undefined;
    const workflows = await deps.listWorkflows(tenant);
    return reply.code(200).send({ nodes: collectNodes(workflows, type) });
  });

  app.get('/tenants/:tenantId/workflows/:id', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { id } = req.params as { id: string };
    if (!estUuid(id)) return reply.code(404).send({ error: 'workflow inconnu' });
    const wf = await deps.getWorkflow(id, tenant);
    if (!wf) return reply.code(404).send({ error: 'workflow inconnu' });
    return reply.code(200).send({ workflow: wf });
  });

  app.patch('/tenants/:tenantId/workflows/:id', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
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
      // Mint SERVEUR des codes de node (code valide du tenant conservé, absent/étranger re-minté).
      patch.graph = mintNodeCodes(graph, await deps.tenantCode(tenant));
    }
    if (Object.keys(patch).length === 0) return reply.code(400).send({ error: 'rien à modifier (name/graph)' });

    const maj = await deps.updateWorkflow(id, tenant, patch);
    if (!maj.trouve) return reply.code(404).send({ error: 'workflow inconnu' });
    if (patch.graph && deps.declareTags) { try { await deps.declareTags(tenant, tagsInGraph(patch.graph)); } catch { /* best-effort */ } }
    // `brouillon` : reste-t-il quelque chose à publier APRÈS cette écriture ? C'est la base qui répond, et
    // c'est ce qui allume (ou éteint) le bouton « Publier ». L'éditeur ne peut pas le déduire seul : un
    // enregistrement identique au publié n'y laisse rien, et il s'en produit un à la simple ouverture d'un
    // scénario (React Flow mesure les blocs au montage).
    return reply.code(200).send({ id, ...patch, brouillon: maj.brouillon });
  });

  /**
   * MET EN LIGNE le brouillon (lot 7). C'est le seul chemin qui touche le graphe publié, donc le seul qui
   * change quoi que ce soit pour les contacts.
   *
   * Ce que la publication emporte, décidé par Julien le 2026-09-01 : un parcours DÉJÀ en cours bascule sur la
   * nouvelle version (il n'est pas épinglé à celle qui l'a démarré), et une campagne programmée part avec la
   * version en ligne le jour de l'expédition, pas celle de sa préparation. La version en ligne est la seule
   * qui existe à l'exécution.
   *
   * ⚠️ Sans retour arrière : publier écrase la version précédente, qui n'est conservée nulle part.
   */
  app.post('/tenants/:tenantId/workflows/:id/publish', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    if (!deps.publishWorkflow) return reply.code(503).send({ error: 'publication indisponible sur cette instance' });
    const { id } = req.params as { id: string };
    if (!estUuid(id)) return reply.code(404).send({ error: 'workflow inconnu' });
    const row = await deps.publishWorkflow(id, tenant);
    if (!row) return reply.code(404).send({ error: 'workflow inconnu' });
    // Le journal porte QUI a publié : la table `workflows`, elle, ne garde que la date. Détail non identifiant
    // (un nombre de blocs), comme partout dans ce journal.
    await journal(tenant, req, 'workflow.published', { kind: 'workflow', id }, { blocs: row.graph.nodes.length });
    return reply.code(200).send({ id, graph: row.graph, publishedAt: row.publishedAt ?? null });
  });

  app.delete('/tenants/:tenantId/workflows/:id', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    if (!estUuid(id)) return reply.code(404).send({ error: 'workflow inconnu' });
    /**
     * 🔴 LE REFUS SE POSE AVANT LA SUPPRESSION, ET C'EST TOUT CE QUI LE REND EFFICACE. La clé étrangère des
     * publicités est en `on delete set null` : placé après, ce contrôle regarderait une publicité qui a DÉJÀ
     * perdu son scénario, donc il ne verrait plus rien à refuser. C'est le motif « une garde ne garde que ce
     * qui vient après elle », mesuré dans ce dépôt sur un `only:` posé sous un appel réseau.
     */
    const pubs = await deps.publicitesQuiUtilisent(tenant, id);
    if (pubs.length > 0) {
      return reply.code(409).send({
        error: `ce scénario répond aux prospects de ${pubs.length > 1 ? 'ces publicités' : 'cette publicité'} : ${pubs.slice(0, 3).join(', ')}${pubs.length > 3 ? '…' : ''}. Changez leur destination, ou supprimez-les, puis réessayez.`,
        code: 'utilise_par_publicite',
      });
    }
    try {
      const ok = await deps.deleteWorkflow(id, tenant);
      if (!ok) return reply.code(404).send({ error: 'workflow inconnu' });
      return reply.code(200).send({ ok: true });
    } catch (err) {
      // 🔴 `channelsme_links.workflow_id` est en `on delete restrict` (migration 0114, seule FK `restrict`
      // de ce dépôt vers `workflows`) : sans cette traduction, la violation Postgres 23503 sortirait en 500,
      // page d'erreur Cloudflare comprise, sans que l'utilisateur puisse deviner qu'un lien de chaîne bloque.
      if (err instanceof WorkflowUtiliseParLienChaine) {
        return reply.code(409).send({ error: 'ce scénario est utilisé par un lien de chaîne WhatsApp : éteins le lien, puis réessaie' });
      }
      throw err;
    }
  });

  /**
   * Lien de TEST d'un scénario (Lot F) : renvoie le jeton, le lien wa.me et le numéro, pour que le client
   * teste depuis SON téléphone sans campagne. POST et non GET : le premier appel POSE le jeton (écriture).
   * Idempotent ensuite (le jeton est stable, le QR reste valable).
   *
   * `link` null = aucun numéro WhatsApp connecté : on renvoie quand même le jeton (le testeur peut écrire le
   * mot à la main), plutôt qu'un lien cassé.
   */
  app.post('/tenants/:tenantId/workflows/:id/test-link', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    if (!deps.ensureTestToken) return reply.code(503).send({ error: 'test indisponible sur cette instance' });
    const { id } = req.params as { id: string };
    if (!estUuid(id)) return reply.code(404).send({ error: 'workflow inconnu' });
    const token = await deps.ensureTestToken(id, tenant, newTestToken());
    if (token === null) return reply.code(404).send({ error: 'workflow inconnu' });
    const phone = deps.getDisplayPhoneNumber ? await deps.getDisplayPhoneNumber(tenant) : null;
    return reply.code(200).send({ token, phone, link: waMeTestLink(phone, token) });
  });
}
