import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { deriveElements, fieldsOf, isFlowFieldType, isChoiceFieldType, flowFieldToUserFieldType, DuplicateFieldKeyError } from '../meta/flow-json';
import type { FlowElementInput, FlowElement, FlowFieldElInput } from '../meta/flow-json';
import type { MetaFlowClient } from '../meta/flows';
import type { FlowRow } from '../flow/store.pg';
import type { UserFieldType } from '../crm/types';
import type { Guard } from '../auth/middleware';

export interface FlowRouteDeps {
  flows: MetaFlowClient;
  getWabaId(tenantId: string): Promise<string | null>;
  insertFlow(tenantId: string, id: string, name: string, elements: FlowElement[], ref: string, mapping: Record<string, string>, cta?: string): Promise<void>;
  listFlows(tenantId: string): Promise<FlowRow[]>;
  belongsTo(flowId: string, tenantId: string): Promise<boolean>;
  markPublished(flowId: string, tenantId: string): Promise<boolean>;
  /** Crée le user field s'il n'existe pas (mapping par défaut : chaque champ -> son propre user field). */
  ensureUserField(tenantId: string, label: string, type: UserFieldType): Promise<void>;
  /** Un flow par id, scopé tenant (édition/duplication : lire status + elements). null si absent. */
  getFlow(flowId: string, tenantId: string): Promise<FlowRow | null>;
  /** Met à jour un flow DRAFT en base (fields re-dérivé côté store). true si une ligne DRAFT a bougé. */
  updateFlowRow(tenantId: string, id: string, name: string, elements: FlowElement[], ref: string, mapping: Record<string, string>, cta?: string): Promise<boolean>;
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
      const field: FlowFieldElInput = { kind: 'field', label: el.label.trim(), type: el.type, required: el.required === true };
      if (isChoiceFieldType(el.type)) {
        // Un champ de choix (dropdown/radio/checkbox) exige >= 2 options distinctes non vides.
        const raw = (el as { options?: unknown }).options;
        const opts = Array.isArray(raw) ? [...new Set(raw.map((o) => String(o).trim()).filter((o) => o !== ''))] : [];
        if (opts.length < 2) return null;
        field.options = opts;
      }
      elements.push(field);
      // Un consentement (optin) se range TOUJOURS dans un champ booléen dédié : on ignore tout saveTo
      // fourni (défense en profondeur contre un appel API direct qui écrirait le booléen ailleurs).
      saveTos.push(field.type !== 'optin' && nonEmpty(el.saveTo) ? el.saveTo.trim() : undefined);
      fieldCount += 1;
    } else {
      return null;
    }
  }
  return fieldCount > 0 ? { elements, saveTos } : null;
}

/**
 * Dérive les elements (clés champ, collision -> DuplicateFieldKeyError) PUIS construit le mapping
 * champ -> user field : défaut (saveTo vide) = user field de la clé du champ (qu'on ensure), sinon la cible
 * explicite choisie. Le ensureUserField est effectué ici. Renvoie une erreur (message 400) ou le trio prêt.
 * Partagé par la création ET l'édition d'un flow (même sémantique de mapping).
 */
async function deriveAndMap(
  deps: FlowRouteDeps,
  tenant: string,
  parsed: { elements: FlowElementInput[]; saveTos: Array<string | undefined> },
): Promise<{ error: string } | { derived: FlowElement[]; mapping: Record<string, string>; fields: ReturnType<typeof fieldsOf> }> {
  let derived: FlowElement[];
  try {
    derived = deriveElements(parsed.elements);
  } catch (err) {
    if (err instanceof DuplicateFieldKeyError) return { error: err.message };
    throw err;
  }
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
  return { derived, mapping, fields };
}

const INVALID_ELEMENTS = 'elements invalide (au moins 1 champ ; texte non vide ; image base64 <= 300KB ; type de champ valide)';

/**
 * Routes Flows (constructeur de formulaire RICHE). GROUPE admin-only via `guard`. Le tenant vient du JWT.
 * Création : dérive les clés, génère un `ref` (discriminant au retour), construit le mapping, crée chez Meta
 * puis persiste. Édition (DRAFT only) : réécrit le flow_json via /assets + met à jour le store, MÊME ref.
 * Duplication : clone un flow (source publié ou draft) en un nouveau DRAFT avec un ref FRAIS.
 */
export function registerFlows(app: FastifyInstance, deps: FlowRouteDeps, guard?: Guard): void {
  // bodyLimit relevé (défaut global = 1 Mo) : un flow riche peut embarquer plusieurs images base64
  // (~400 Ko chacune) dans le body. Aligné sur la route media. S'applique aussi à GET/publish (sans effet).
  const opts = { ...(guard ? { preHandler: guard } : {}), bodyLimit: 7 * 1024 * 1024 };

  app.post('/tenants/:tenantId/flows', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });

    const b = (req.body ?? {}) as { name?: unknown; elements?: unknown; cta?: unknown };
    if (!nonEmpty(b.name)) return reply.code(400).send({ error: 'name requis' });
    const parsed = parseFlowBody(b.elements);
    if (parsed === null) return reply.code(400).send({ error: INVALID_ELEMENTS });
    const cta = nonEmpty(b.cta) ? b.cta.trim() : undefined;

    const wabaId = await deps.getWabaId(tenant);
    if (!wabaId) return reply.code(400).send({ error: 'aucun WABA pour ce tenant' });

    const mapped = await deriveAndMap(deps, tenant, parsed); // 400 (collision) AVANT tout appel Meta
    if ('error' in mapped) return reply.code(400).send({ error: mapped.error });

    const ref = randomUUID();
    const name = b.name.trim();
    const { id, status } = await deps.flows.create(wabaId, { name, elements: mapped.derived, ref, ...(cta ? { cta } : {}) });
    await deps.insertFlow(tenant, id, name, mapped.derived, ref, mapped.mapping, cta);
    return reply.code(201).send({ id, status, name, fields: mapped.fields });
  });

  // Édition d'un flow DRAFT : réécrit le flow_json (/assets multipart) + le store. PUBLISHED -> 409 (immuable).
  app.patch('/tenants/:tenantId/flows/:flowId', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { flowId } = req.params as { flowId: string };

    const b = (req.body ?? {}) as { name?: unknown; elements?: unknown; cta?: unknown };
    if (!nonEmpty(b.name)) return reply.code(400).send({ error: 'name requis' });
    const parsed = parseFlowBody(b.elements);
    if (parsed === null) return reply.code(400).send({ error: INVALID_ELEMENTS });
    const cta = nonEmpty(b.cta) ? b.cta.trim() : undefined;

    const existing = await deps.getFlow(flowId, tenant);
    if (!existing) return reply.code(404).send({ error: 'flow inconnu' });
    if (existing.status === 'PUBLISHED') return reply.code(409).send({ error: 'flow publié : immuable. Utilise « Dupliquer pour modifier ».' });
    // Legacy (elements null) : le builder repartirait d'un formulaire vide et ÉCRASERAIT le contenu d'origine.
    // Symétrique au garde-fou de la duplication (422). Recréer plutôt qu'éditer.
    if (!existing.elements || existing.elements.length === 0) {
      return reply.code(422).send({ error: 'flow antérieur au modèle riche : à recréer plutôt qu\'à éditer' });
    }

    const wabaId = await deps.getWabaId(tenant);
    if (!wabaId) return reply.code(400).send({ error: 'aucun WABA pour ce tenant' });

    const mapped = await deriveAndMap(deps, tenant, parsed);
    if ('error' in mapped) return reply.code(400).send({ error: mapped.error });

    // On GARDE le même ref (le flow Meta est le même id ; findByRef du webhook ne doit pas être orphelin).
    const ref = existing.ref ?? randomUUID();
    const name = b.name.trim();
    await deps.flows.updateDraft(flowId, { name, elements: mapped.derived, ref, ...(cta ? { cta } : {}) }); // Meta AVANT store
    await deps.updateFlowRow(tenant, flowId, name, mapped.derived, ref, mapped.mapping, cta);
    return reply.code(200).send({ id: flowId, status: 'DRAFT', name, fields: mapped.fields });
  });

  // « Dupliquer pour modifier » (D10) : clone un flow en un NOUVEAU DRAFT (ref frais). Meta AVANT store.
  app.post('/tenants/:tenantId/flows/:flowId/duplicate', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { flowId } = req.params as { flowId: string };

    const source = await deps.getFlow(flowId, tenant);
    if (!source) return reply.code(404).send({ error: 'flow inconnu' });
    if (!source.elements || source.elements.length === 0) {
      return reply.code(422).send({ error: 'flow sans elements : duplication indisponible (flow antérieur au modèle riche)' });
    }

    const wabaId = await deps.getWabaId(tenant);
    if (!wabaId) return reply.code(400).send({ error: 'aucun WABA pour ce tenant' });

    const ref = randomUUID(); // index unique sur ref -> jamais réutiliser celui de la source
    // Nom de flow unique par WABA (Meta l'exige) : « X (copie) », puis « X (copie 2) »... si déjà pris.
    const taken = new Set((await deps.listFlows(tenant)).map((f) => f.name));
    let name = `${source.name} (copie)`;
    for (let n = 2; taken.has(name); n += 1) name = `${source.name} (copie ${n})`;
    const mapping = source.mapping ?? {};
    const cta = source.cta ?? undefined;
    const { id, status } = await deps.flows.create(wabaId, { name, elements: source.elements, ref, ...(cta ? { cta } : {}) });
    await deps.insertFlow(tenant, id, name, source.elements, ref, mapping, cta);
    return reply.code(201).send({ id, status, name, fields: fieldsOf(source.elements) });
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
