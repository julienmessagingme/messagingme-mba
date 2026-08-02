import type { FastifyInstance } from 'fastify';
import { forbidNonAdmin } from '../auth/middleware';
import type { Guard } from '../auth/middleware';
import { parseGraph, isWorkflowNodeType } from '../workflow/graph';
import type { WorkflowGraph } from '../workflow/graph';
import type { WorkflowRow } from '../workflow/store.pg';
import { mintNodeCodes } from '../workflow/node-codes';
import { collectNodes } from '../workflow/node-list';

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
  getWorkflow(id: string, tenantId: string): Promise<WorkflowRow | null>;
  updateWorkflow(id: string, tenantId: string, patch: { name?: string; graph?: WorkflowGraph }): Promise<boolean>;
  deleteWorkflow(id: string, tenantId: string): Promise<boolean>;
  /** Déclare dans le référentiel Tags les tags saisis dans les blocs « ajout de tag » du graphe (best-effort).
   *  Absent -> pas de déclaration (rétro-compatible). */
  declareTags?(tenantId: string, tags: string[]): Promise<void>;
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

function scopeTenant(req: { params: unknown; auth?: { tenantId: string } }): string | null {
  const { tenantId } = req.params as { tenantId: string };
  const authTenant = req.auth?.tenantId;
  if (authTenant !== undefined && authTenant !== tenantId) return null;
  return authTenant ?? tenantId;
}
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/**
 * Routes du bot builder (workflows). Admin-only via `guard`. Tenant dérivé du JWT. Le graphe est TOUJOURS
 * validé/sanitisé par `parseGraph` avant persistance (400 si invalide). bodyLimit relevé : un graphe peut
 * porter plusieurs blocs avec de la config. PB1 : CRUD + graphe. Pas d'exécution (PB2).
 */
export function registerWorkflows(app: FastifyInstance, deps: WorkflowRouteDeps, guard?: Guard): void {
  const opts = { ...(guard ? { preHandler: guard } : {}), bodyLimit: 2 * 1024 * 1024 };

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
    const source = await deps.getWorkflow(id, tenant);
    if (!source) return reply.code(404).send({ error: 'workflow inconnu' });

    const taken = new Set((await deps.listWorkflows(tenant)).map((w) => w.name));
    let name = `${source.name} (copie)`;
    for (let n = 2; taken.has(name); n += 1) name = `${source.name} (copie ${n})`;

    // Retire le code de chaque node AVANT de re-minter -> tous les codes sont frais (jamais conservés de la source).
    const stripped: WorkflowGraph = {
      nodes: source.graph.nodes.map((node) => ({ ...node, data: { ...node.data, code: undefined } })),
      edges: source.graph.edges,
    };
    const graph = mintNodeCodes(stripped, await deps.tenantCode(tenant));
    const { id: newId } = await deps.createWorkflow(tenant, name, graph);
    if (deps.declareTags) { try { await deps.declareTags(tenant, tagsInGraph(graph)); } catch { /* best-effort */ } }
    return reply.code(201).send({ id: newId, name, graph });
  });

  app.get('/tenants/:tenantId/workflows', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
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
    const wf = await deps.getWorkflow(id, tenant);
    if (!wf) return reply.code(404).send({ error: 'workflow inconnu' });
    return reply.code(200).send({ workflow: wf });
  });

  app.patch('/tenants/:tenantId/workflows/:id', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
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

    const ok = await deps.updateWorkflow(id, tenant, patch);
    if (!ok) return reply.code(404).send({ error: 'workflow inconnu' });
    if (ok && patch.graph && deps.declareTags) { try { await deps.declareTags(tenant, tagsInGraph(patch.graph)); } catch { /* best-effort */ } }
    return reply.code(200).send({ id, ...patch });
  });

  app.delete('/tenants/:tenantId/workflows/:id', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const ok = await deps.deleteWorkflow(id, tenant);
    if (!ok) return reply.code(404).send({ error: 'workflow inconnu' });
    return reply.code(200).send({ ok: true });
  });
}
