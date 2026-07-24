import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { deriveScreens, fieldsOfScreens, isFlowFieldType, isChoiceFieldType, flowFieldToUserFieldType, DuplicateFieldKeyError, VisibleIfError, MAX_SCREENS } from '../meta/flow-json';
import type { FlowElementInput, FlowScreenInput, FlowScreenDef, FlowFieldElInput, VisibleIfInput } from '../meta/flow-json';
import type { MetaFlowClient } from '../meta/flows';
import type { FlowRow } from '../flow/store.pg';
import type { UserFieldType, UserFieldDef } from '../crm/types';
import { WHATSAPP_OPTIN_FIELD_KEY } from '../crm/fields';
import type { Guard } from '../auth/middleware';

export interface FlowRouteDeps {
  /** Client flows Meta résolu PAR TENANT (B1 : token du tenant, repli global en sommeil). */
  flowsFor(tenantId: string): Promise<MetaFlowClient>;
  getWabaId(tenantId: string): Promise<string | null>;
  insertFlow(tenantId: string, id: string, name: string, screens: FlowScreenDef[], ref: string, mapping: Record<string, string>, cta?: string): Promise<void>;
  listFlows(tenantId: string): Promise<FlowRow[]>;
  belongsTo(flowId: string, tenantId: string): Promise<boolean>;
  markPublished(flowId: string, tenantId: string): Promise<boolean>;
  /** Crée le user field s'il n'existe pas (mapping par défaut : chaque champ -> son propre user field). */
  ensureUserField(tenantId: string, label: string, type: UserFieldType): Promise<void>;
  /** Définitions des user fields du tenant : valider qu'une cible de consentement choisie est bien booléenne. */
  listUserFields(tenantId: string): Promise<UserFieldDef[]>;
  /** Crée (idempotent, PAR CLÉ) le champ booléen de consentement par défaut `whatsapp_optin`. */
  ensureOptinField(tenantId: string): Promise<void>;
  /** Un flow par id, scopé tenant (édition/duplication : lire status + screens). null si absent. */
  getFlow(flowId: string, tenantId: string): Promise<FlowRow | null>;
  /** Met à jour un flow DRAFT en base (fields re-dérivé côté store). true si une ligne DRAFT a bougé. */
  updateFlowRow(tenantId: string, id: string, name: string, screens: FlowScreenDef[], ref: string, mapping: Record<string, string>, cta?: string): Promise<boolean>;
  /** Retire le flow du store local (après suppression/dépréciation Meta). true si supprimé. */
  removeFlowRow(flowId: string, tenantId: string): Promise<boolean>;
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

/** Forme (pas la sémantique) d'un visibleIf : { field: libellé source, op eq/neq, value string|boolean }.
 *  La résolution/validation sémantique (source existante, avant, même écran, valeur ∈ options) vit dans
 *  deriveScreens. undefined si absent, null si malformé. */
function parseVisibleIf(raw: unknown): VisibleIfInput | undefined | null {
  if (raw === undefined || raw === null) return undefined;
  const v = raw as { field?: unknown; op?: unknown; value?: unknown };
  if (!nonEmpty(v.field)) return null;
  if (v.op !== 'eq' && v.op !== 'neq') return null;
  if (typeof v.value !== 'string' && typeof v.value !== 'boolean') return null;
  return { field: v.field.trim(), op: v.op, value: v.value };
}

/** Valide UNE liste d'éléments (un écran). Renvoie null si invalide ; les saveTo sont POUSSÉS dans
 *  l'accumulateur global (alignés sur l'ordre global des champs, écran par écran). */
function parseElements(v: unknown, saveTos: Array<string | undefined>): { elements: FlowElementInput[]; fieldCount: number } | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const elements: FlowElementInput[] = [];
  let fieldCount = 0;
  for (const raw of v) {
    const el = raw as { kind?: unknown; text?: unknown; src?: unknown; label?: unknown; type?: unknown; required?: unknown; saveTo?: unknown; visibleIf?: unknown };
    const visibleIf = parseVisibleIf(el.visibleIf);
    if (visibleIf === null) return null;
    const vi = visibleIf ? { visibleIf } : {};
    if (el.kind === 'heading' || el.kind === 'subheading' || el.kind === 'body' || el.kind === 'caption') {
      if (!nonEmpty(el.text)) return null;
      elements.push({ kind: el.kind, text: el.text.trim(), ...vi });
    } else if (el.kind === 'image') {
      if (!nonEmpty(el.src)) return null;
      const src = stripDataUrl(el.src);
      if (src.length === 0 || src.length > IMG_MAX) return null;
      elements.push({ kind: 'image', src, ...vi });
    } else if (el.kind === 'field') {
      if (!nonEmpty(el.label) || !isFlowFieldType(el.type)) return null;
      const field: FlowFieldElInput = { kind: 'field', label: el.label.trim(), type: el.type, required: el.required === true, ...vi };
      if (isChoiceFieldType(el.type)) {
        // Un champ de choix (dropdown/radio/checkbox) exige >= 2 options distinctes non vides.
        const raw = (el as { options?: unknown }).options;
        const opts = Array.isArray(raw) ? [...new Set(raw.map((o) => String(o).trim()).filter((o) => o !== ''))] : [];
        if (opts.length < 2) return null;
        field.options = opts;
      }
      elements.push(field);
      // saveTo = champ cible explicite (facultatif). Pour un consentement (optin), la cible doit être un
      // champ BOOLÉEN (validé dans deriveAndMap) ; sans cible, défaut = whatsapp_optin (créé à la volée).
      saveTos.push(nonEmpty(el.saveTo) ? el.saveTo.trim() : undefined);
      fieldCount += 1;
    } else {
      return null;
    }
  }
  return { elements, fieldCount };
}

/**
 * Valide le corps riche, en MULTI-ÉCRANS (Lot 7). Deux formes acceptées :
 * - `screens: [{ title?, cta?, elements: [...] }]` (le front actuel) — 1 à MAX_SCREENS écrans, chacun >= 1
 *   élément, >= 1 champ AU GLOBAL ;
 * - `elements: [...]` (forme historique mono-écran, tests/API directs) — enveloppée en 1 écran.
 * Renvoie les écrans + les saveTo alignés sur l'ordre GLOBAL des champs. null si invalide.
 */
function parseFlowBody(body: { screens?: unknown; elements?: unknown }): { screens: FlowScreenInput[]; saveTos: Array<string | undefined> } | null {
  const saveTos: Array<string | undefined> = [];
  if (body.screens !== undefined) {
    if (!Array.isArray(body.screens) || body.screens.length === 0 || body.screens.length > MAX_SCREENS) return null;
    const screens: FlowScreenInput[] = [];
    let totalFields = 0;
    for (const raw of body.screens) {
      const s = raw as { title?: unknown; cta?: unknown; elements?: unknown };
      const parsed = parseElements(s.elements, saveTos);
      if (parsed === null) return null;
      totalFields += parsed.fieldCount;
      screens.push({
        ...(nonEmpty(s.title) ? { title: s.title.trim().slice(0, 30) } : {}),
        ...(nonEmpty(s.cta) ? { cta: s.cta.trim().slice(0, 30) } : {}),
        elements: parsed.elements,
      });
    }
    return totalFields > 0 ? { screens, saveTos } : null;
  }
  const parsed = parseElements(body.elements, saveTos);
  if (parsed === null || parsed.fieldCount === 0) return null;
  return { screens: [{ elements: parsed.elements }], saveTos };
}

/**
 * Dérive les écrans (clés champ GLOBALEMENT uniques, collision -> DuplicateFieldKeyError ; visibleIf
 * résolus/validés -> VisibleIfError) PUIS construit le mapping champ -> user field : défaut (saveTo vide)
 * = user field de la clé du champ (qu'on ensure), sinon la cible explicite choisie. Le ensureUserField est
 * effectué ici. Renvoie une erreur (message 400) ou le trio prêt. Partagé par la création ET l'édition.
 */
async function deriveAndMap(
  deps: FlowRouteDeps,
  tenant: string,
  parsed: { screens: FlowScreenInput[]; saveTos: Array<string | undefined> },
): Promise<{ error: string } | { derived: FlowScreenDef[]; mapping: Record<string, string>; fields: ReturnType<typeof fieldsOfScreens> }> {
  let derived: FlowScreenDef[];
  try {
    derived = deriveScreens(parsed.screens);
  } catch (err) {
    if (err instanceof DuplicateFieldKeyError || err instanceof VisibleIfError) return { error: err.message };
    throw err;
  }
  const fields = fieldsOfScreens(derived);
  const mapping: Record<string, string> = {};
  // Défs chargées UNE fois, seulement si un consentement (optin) désigne une cible explicite à valider.
  let defs: UserFieldDef[] | null = null;
  for (let i = 0; i < fields.length; i += 1) {
    const f = fields[i]!;
    const saveTo = parsed.saveTos[i];
    if (f.type === 'optin') {
      // Consentement : cible = champ BOOLÉEN choisi (validé) ou, à défaut, whatsapp_optin (créé à la volée).
      if (saveTo) {
        defs ??= await deps.listUserFields(tenant);
        const target = defs.find((d) => d.key === saveTo);
        if (!target || target.type !== 'boolean') {
          return { error: `le consentement « ${f.label} » doit être enregistré dans un champ Oui/Non existant` };
        }
        mapping[f.key] = saveTo;
      } else {
        await deps.ensureOptinField(tenant);
        mapping[f.key] = WHATSAPP_OPTIN_FIELD_KEY;
      }
    } else if (saveTo) {
      mapping[f.key] = saveTo;
    } else {
      mapping[f.key] = f.key;
      // email/phone/textarea (types Flow) -> 'text' (type user field) : sinon ensureField -> 500.
      await deps.ensureUserField(tenant, f.label, flowFieldToUserFieldType(f.type));
    }
  }
  // Deux consentements ne peuvent pas viser le MÊME champ (sinon le 2e écrase la valeur du 1er alors que le
  // gate opt-in s'ouvre au moindre « oui » : incohérence stockée). Vaut pour le défaut (tous -> whatsapp_optin)
  // comme pour deux cibles explicites identiques.
  const optinTargets = fields.filter((f) => f.type === 'optin').map((f) => mapping[f.key]!);
  if (new Set(optinTargets).size !== optinTargets.length) {
    return { error: 'deux consentements enregistrent dans le même champ : donnez une cible distincte à chacun' };
  }
  return { derived, mapping, fields };
}

const INVALID_ELEMENTS = 'screens/elements invalide (1 à 10 écrans, chacun >= 1 élément ; au moins 1 champ au global ; texte non vide ; image base64 <= 300KB ; type de champ valide ; visibleIf {field, op eq/neq, value})';

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

    const b = (req.body ?? {}) as { name?: unknown; screens?: unknown; elements?: unknown; cta?: unknown };
    if (!nonEmpty(b.name)) return reply.code(400).send({ error: 'name requis' });
    const parsed = parseFlowBody(b);
    if (parsed === null) return reply.code(400).send({ error: INVALID_ELEMENTS });
    const cta = nonEmpty(b.cta) ? b.cta.trim() : undefined;

    const wabaId = await deps.getWabaId(tenant);
    if (!wabaId) return reply.code(400).send({ error: 'aucun WABA pour ce tenant' });

    const mapped = await deriveAndMap(deps, tenant, parsed); // 400 (collision/condition) AVANT tout appel Meta
    if ('error' in mapped) return reply.code(400).send({ error: mapped.error });

    const ref = randomUUID();
    const name = b.name.trim();
    const { id, status } = await (await deps.flowsFor(tenant)).create(wabaId, { name, screens: mapped.derived, ref, ...(cta ? { cta } : {}) });
    await deps.insertFlow(tenant, id, name, mapped.derived, ref, mapped.mapping, cta);
    return reply.code(201).send({ id, status, name, fields: mapped.fields });
  });

  // Édition d'un flow DRAFT : réécrit le flow_json (/assets multipart) + le store. PUBLISHED -> 409 (immuable).
  app.patch('/tenants/:tenantId/flows/:flowId', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { flowId } = req.params as { flowId: string };

    const b = (req.body ?? {}) as { name?: unknown; screens?: unknown; elements?: unknown; cta?: unknown };
    if (!nonEmpty(b.name)) return reply.code(400).send({ error: 'name requis' });
    const parsed = parseFlowBody(b);
    if (parsed === null) return reply.code(400).send({ error: INVALID_ELEMENTS });
    const cta = nonEmpty(b.cta) ? b.cta.trim() : undefined;

    const existing = await deps.getFlow(flowId, tenant);
    if (!existing) return reply.code(404).send({ error: 'flow inconnu' });
    if (existing.status === 'PUBLISHED') return reply.code(409).send({ error: 'flow publié : immuable. Utilise « Dupliquer pour modifier ».' });
    // Legacy (screens null = colonne elements vide/absente) : le builder repartirait d'un formulaire vide et
    // ÉCRASERAIT le contenu d'origine. Symétrique au garde-fou de la duplication (422).
    if (!existing.screens) {
      return reply.code(422).send({ error: 'flow antérieur au modèle riche : à recréer plutôt qu\'à éditer' });
    }

    const wabaId = await deps.getWabaId(tenant);
    if (!wabaId) return reply.code(400).send({ error: 'aucun WABA pour ce tenant' });

    const mapped = await deriveAndMap(deps, tenant, parsed);
    if ('error' in mapped) return reply.code(400).send({ error: mapped.error });

    // On GARDE le même ref (le flow Meta est le même id ; findByRef du webhook ne doit pas être orphelin).
    const ref = existing.ref ?? randomUUID();
    const name = b.name.trim();
    await (await deps.flowsFor(tenant)).updateDraft(flowId, { name, screens: mapped.derived, ref, ...(cta ? { cta } : {}) }); // Meta AVANT store
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
    if (!source.screens) {
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
    const { id, status } = await (await deps.flowsFor(tenant)).create(wabaId, { name, screens: source.screens, ref, ...(cta ? { cta } : {}) });
    await deps.insertFlow(tenant, id, name, source.screens, ref, mapping, cta);
    return reply.code(201).send({ id, status, name, fields: fieldsOfScreens(source.screens) });
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
    await (await deps.flowsFor(tenant)).publish(flowId);
    await deps.markPublished(flowId, tenant);
    return reply.code(200).send({ id: flowId, status: 'PUBLISHED' });
  });

  // Suppression : un DRAFT se supprime (DELETE), un PUBLISHED se déprécie (immuable, on le retire de l'usage).
  // Meta AVANT le store : si Meta refuse (flow encore rattaché à un template approuvé), on remonte SON message
  // (errorHandler global) et on ne touche pas la base -> pas d'orphelin « supprimé chez nous, vivant chez Meta ».
  app.delete('/tenants/:tenantId/flows/:flowId', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { flowId } = req.params as { flowId: string };
    const flow = await deps.getFlow(flowId, tenant);
    if (!flow) return reply.code(404).send({ error: 'flow inconnu' });
    if (flow.status === 'PUBLISHED') await (await deps.flowsFor(tenant)).deprecate(flowId);
    else await (await deps.flowsFor(tenant)).delete(flowId);
    await deps.removeFlowRow(flowId, tenant);
    return reply.code(200).send({ id: flowId, deleted: true });
  });
}
