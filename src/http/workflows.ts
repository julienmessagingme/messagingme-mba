import type { FastifyInstance } from 'fastify';
import { forbidNonAdmin } from '../auth/middleware';
import type { Guard } from '../auth/middleware';
import { parseGraph } from '../workflow/graph';
import type { WorkflowGraph } from '../workflow/graph';
import type { WorkflowRow } from '../workflow/store.pg';

export interface WorkflowRouteDeps {
  createWorkflow(tenantId: string, name: string, graph: WorkflowGraph): Promise<{ id: string }>;
  listWorkflows(tenantId: string): Promise<WorkflowRow[]>;
  getWorkflow(id: string, tenantId: string): Promise<WorkflowRow | null>;
  updateWorkflow(id: string, tenantId: string, patch: { name?: string; graph?: WorkflowGraph; status?: 'draft' | 'active' }): Promise<boolean>;
  deleteWorkflow(id: string, tenantId: string): Promise<boolean>;
  /** Déclare dans le référentiel Tags les tags saisis dans les blocs « ajout de tag » du graphe (best-effort).
   *  Absent -> pas de déclaration (rétro-compatible). */
  declareTags?(tenantId: string, tags: string[]): Promise<void>;
}

/** Tags saisis dans les blocs `tag` du graphe (dédupliqués, trim + tronqués à 64 comme la route Tags). */
function tagsInGraph(graph: WorkflowGraph): string[] {
  const out = new Set<string>();
  for (const n of graph.nodes) {
    if (n.type !== 'tag') continue;
    const t = String((n.data as { tag?: unknown }).tag ?? '').trim().slice(0, 64);
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
    const graph = b.graph === undefined ? { nodes: [], edges: [] } : parseGraph(b.graph);
    if (graph === null) return reply.code(400).send({ error: 'graphe invalide (nodes/edges, types, arêtes orphelines)' });
    const { id } = await deps.createWorkflow(tenant, b.name.trim(), graph);
    // Rend les tags des blocs « ajout de tag » visibles tout de suite dans Contenus > Tags (best-effort : ne
    // fait jamais échouer la sauvegarde du workflow).
    if (deps.declareTags) { try { await deps.declareTags(tenant, tagsInGraph(graph)); } catch { /* best-effort */ } }
    return reply.code(201).send({ id, name: b.name.trim(), status: 'draft', graph });
  });

  app.get('/tenants/:tenantId/workflows', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    return reply.code(200).send({ workflows: await deps.listWorkflows(tenant) });
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
    const b = (req.body ?? {}) as { name?: unknown; graph?: unknown; status?: unknown };

    const patch: { name?: string; graph?: WorkflowGraph; status?: 'draft' | 'active' } = {};
    if (b.name !== undefined) {
      if (!nonEmpty(b.name)) return reply.code(400).send({ error: 'name vide' });
      patch.name = b.name.trim();
    }
    if (b.graph !== undefined) {
      const graph = parseGraph(b.graph);
      if (graph === null) return reply.code(400).send({ error: 'graphe invalide (nodes/edges, types, arêtes orphelines)' });
      patch.graph = graph;
    }
    if (b.status !== undefined) {
      if (b.status !== 'draft' && b.status !== 'active') return reply.code(400).send({ error: 'status invalide (draft|active)' });
      patch.status = b.status;
    }
    if (Object.keys(patch).length === 0) return reply.code(400).send({ error: 'rien à modifier (name/graph/status)' });

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
