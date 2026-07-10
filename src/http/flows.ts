import type { FastifyInstance } from 'fastify';
import { deriveFieldKeys, isFlowFieldType, DuplicateFieldKeyError } from '../meta/flow-json';
import type { FlowFieldInput, FlowField } from '../meta/flow-json';
import type { MetaFlowClient } from '../meta/flows';
import type { FlowRow } from '../flow/store.pg';
import type { Guard } from '../auth/middleware';

export interface FlowRouteDeps {
  flows: MetaFlowClient;
  getWabaId(tenantId: string): Promise<string | null>;
  insertFlow(tenantId: string, id: string, name: string, fields: FlowField[]): Promise<void>;
  listFlows(tenantId: string): Promise<FlowRow[]>;
  belongsTo(flowId: string, tenantId: string): Promise<boolean>;
  markPublished(flowId: string, tenantId: string): Promise<boolean>;
}

function scopeTenant(req: { params: unknown; auth?: { tenantId: string } }): string | null {
  const { tenantId } = req.params as { tenantId: string };
  const authTenant = req.auth?.tenantId;
  if (authTenant !== undefined && authTenant !== tenantId) return null;
  return authTenant ?? tenantId;
}

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/** Valide + normalise le tableau de champs du body. null si invalide. */
function parseFields(v: unknown): FlowFieldInput[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out: FlowFieldInput[] = [];
  for (const raw of v) {
    const f = raw as { label?: unknown; type?: unknown; required?: unknown };
    if (!nonEmpty(f.label) || !isFlowFieldType(f.type)) return null;
    out.push({ label: f.label.trim(), type: f.type, required: f.required === true });
  }
  return out;
}

/**
 * Routes Flows (constructeur de formulaire). GROUPE entièrement admin-only via `guard` (aucun usage
 * agent, contrairement aux templates dont le GET reste ouvert à l'inbox). Le tenant est dérivé du JWT.
 */
export function registerFlows(app: FastifyInstance, deps: FlowRouteDeps, guard?: Guard): void {
  const opts = guard ? { preHandler: guard } : {};

  app.post('/tenants/:tenantId/flows', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });

    const b = (req.body ?? {}) as { name?: unknown; fields?: unknown };
    if (!nonEmpty(b.name)) return reply.code(400).send({ error: 'name requis' });
    const fields = parseFields(b.fields);
    if (fields === null) return reply.code(400).send({ error: 'fields invalide (au moins 1 champ, chaque champ {label, type valide, required})' });

    let derived: FlowField[];
    try {
      derived = deriveFieldKeys(fields); // 400 AVANT tout appel Meta (zéro round-trip gâché)
    } catch (err) {
      if (err instanceof DuplicateFieldKeyError) return reply.code(400).send({ error: err.message });
      throw err;
    }

    const wabaId = await deps.getWabaId(tenant);
    if (!wabaId) return reply.code(400).send({ error: 'aucun WABA pour ce tenant' });

    const { id, status } = await deps.flows.create(wabaId, { name: b.name.trim(), fields: derived });
    await deps.insertFlow(tenant, id, b.name.trim(), derived);
    return reply.code(201).send({ id, status, name: b.name.trim(), fields: derived });
  });

  app.get('/tenants/:tenantId/flows', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    return reply.code(200).send({ flows: await deps.listFlows(tenant) });
  });

  app.post('/tenants/:tenantId/flows/:flowId/publish', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { flowId } = req.params as { flowId: string };
    // Ownership AVANT tout appel Meta : 404 si le flow n'est pas à ce tenant (pas d'action cross-tenant).
    if (!(await deps.belongsTo(flowId, tenant))) return reply.code(404).send({ error: 'flow inconnu' });
    await deps.flows.publish(flowId);
    await deps.markPublished(flowId, tenant);
    return reply.code(200).send({ id: flowId, status: 'PUBLISHED' });
  });
}
