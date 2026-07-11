import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { deriveElements, fieldsOf, isFlowFieldType, flowFieldToUserFieldType, DuplicateFieldKeyError } from '../meta/flow-json';
import type { FlowElementInput, FlowElement } from '../meta/flow-json';
import type { MetaFlowClient } from '../meta/flows';
import type { FlowRow } from '../flow/store.pg';
import type { UserFieldType } from '../crm/types';
import type { Guard } from '../auth/middleware';

export interface FlowRouteDeps {
  flows: MetaFlowClient;
  getWabaId(tenantId: string): Promise<string | null>;
  insertFlow(tenantId: string, id: string, name: string, elements: FlowElement[], ref: string, mapping: Record<string, string>): Promise<void>;
  listFlows(tenantId: string): Promise<FlowRow[]>;
  belongsTo(flowId: string, tenantId: string): Promise<boolean>;
  markPublished(flowId: string, tenantId: string): Promise<boolean>;
  /** Crée le user field s'il n'existe pas (mapping par défaut : chaque champ -> son propre user field). */
  ensureUserField(tenantId: string, label: string, type: UserFieldType): Promise<void>;
}

function scopeTenant(req: { params: unknown; auth?: { tenantId: string } }): string | null {
  const { tenantId } = req.params as { tenantId: string };
  const authTenant = req.auth?.tenantId;
  if (authTenant !== undefined && authTenant !== tenantId) return null;
  return authTenant ?? tenantId;
}
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

const IMG_MAX = 400 * 1024; // base64 borné (~300KB binaire) — l'image Flow s'embarque dans le flow_json
const stripDataUrl = (s: string): string => s.replace(/^data:image\/[a-z]+;base64,/i, '');

/**
 * Valide le corps riche : éléments texte/image/champ + `saveTo` optionnel par champ (user field cible).
 * Renvoie les éléments (sans saveTo, pour le flow_json) + les saveTo alignés sur l'ordre des champs.
 * null si invalide (au moins 1 champ requis, sinon rien à collecter).
 */
function parseFlowBody(v: unknown): { elements: FlowElementInput[]; saveTos: Array<string | undefined> } | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const elements: FlowElementInput[] = [];
  const saveTos: Array<string | undefined> = [];
  let fieldCount = 0;
  for (const raw of v) {
    const el = raw as { kind?: unknown; text?: unknown; src?: unknown; label?: unknown; type?: unknown; required?: unknown; saveTo?: unknown };
    if (el.kind === 'heading' || el.kind === 'subheading' || el.kind === 'body' || el.kind === 'caption') {
      if (!nonEmpty(el.text)) return null;
      elements.push({ kind: el.kind, text: el.text.trim() });
    } else if (el.kind === 'image') {
      if (!nonEmpty(el.src)) return null;
      const src = stripDataUrl(el.src);
      if (src.length === 0 || src.length > IMG_MAX) return null;
      elements.push({ kind: 'image', src });
    } else if (el.kind === 'field') {
      if (!nonEmpty(el.label) || !isFlowFieldType(el.type)) return null;
      elements.push({ kind: 'field', label: el.label.trim(), type: el.type, required: el.required === true });
      saveTos.push(nonEmpty(el.saveTo) ? el.saveTo.trim() : undefined);
      fieldCount += 1;
    } else {
      return null;
    }
  }
  return fieldCount > 0 ? { elements, saveTos } : null;
}

/**
 * Routes Flows (constructeur de formulaire RICHE). GROUPE admin-only via `guard`. Le tenant vient du JWT.
 * À la création : dérive les clés, génère un `ref` (discriminant du flow au retour), construit le mapping
 * champ -> user field (défaut = même clé, on ensure le user field ; sinon la cible choisie), crée chez Meta
 * puis persiste.
 */
export function registerFlows(app: FastifyInstance, deps: FlowRouteDeps, guard?: Guard): void {
  // bodyLimit relevé (défaut global = 1 Mo) : un flow riche peut embarquer plusieurs images base64
  // (~400 Ko chacune) dans le body. Aligné sur la route media. S'applique aussi à GET/publish (sans effet).
  const opts = { ...(guard ? { preHandler: guard } : {}), bodyLimit: 7 * 1024 * 1024 };

  app.post('/tenants/:tenantId/flows', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });

    const b = (req.body ?? {}) as { name?: unknown; elements?: unknown };
    if (!nonEmpty(b.name)) return reply.code(400).send({ error: 'name requis' });
    const parsed = parseFlowBody(b.elements);
    if (parsed === null) return reply.code(400).send({ error: 'elements invalide (au moins 1 champ ; texte non vide ; image base64 <= 300KB ; type de champ valide)' });

    let derived: FlowElement[];
    try {
      derived = deriveElements(parsed.elements); // 400 AVANT tout appel Meta
    } catch (err) {
      if (err instanceof DuplicateFieldKeyError) return reply.code(400).send({ error: err.message });
      throw err;
    }

    const wabaId = await deps.getWabaId(tenant);
    if (!wabaId) return reply.code(400).send({ error: 'aucun WABA pour ce tenant' });

    // Mapping champ -> user field. Défaut (saveTo vide) : le champ va dans un user field de sa propre clé
    // (qu'on ensure). Sinon : la cible explicite choisie (user field existant).
    const fields = fieldsOf(derived);
    const mapping: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 1) {
      const f = fields[i]!;
      const saveTo = parsed.saveTos[i];
      if (saveTo) {
        mapping[f.key] = saveTo;
      } else {
        mapping[f.key] = f.key;
        // email/phone/textarea (types Flow) -> 'text' (type user field) : sinon ensureField -> 500.
        await deps.ensureUserField(tenant, f.label, flowFieldToUserFieldType(f.type));
      }
    }

    const ref = randomUUID();
    const name = b.name.trim();
    const { id, status } = await deps.flows.create(wabaId, { name, elements: derived, ref });
    await deps.insertFlow(tenant, id, name, derived, ref, mapping);
    return reply.code(201).send({ id, status, name, fields });
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
    if (!(await deps.belongsTo(flowId, tenant))) return reply.code(404).send({ error: 'flow inconnu' });
    await deps.flows.publish(flowId);
    await deps.markPublished(flowId, tenant);
    return reply.code(200).send({ id: flowId, status: 'PUBLISHED' });
  });
}
