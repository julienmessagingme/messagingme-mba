import { randomUUID } from 'node:crypto';
import { journaliser } from '../lib/journal';
import type { FastifyInstance } from 'fastify';
import { deriveScreens, fieldsOfScreens, isFlowFieldType, isChoiceFieldType, flowFieldToUserFieldType, DuplicateFieldKeyError, VisibleIfError, MAX_SCREENS } from '../meta/flow-json';
import type { FlowElementInput, FlowScreenInput, FlowScreenDef, FlowFieldElInput, VisibleIfInput } from '../meta/flow-json';
import type { MetaFlowClient } from '../meta/flows';
import type { FlowRow } from '../flow/store.pg';
import type { UserFieldType, UserFieldDef } from '../crm/types';
import { WHATSAPP_OPTIN_FIELD_KEY } from '../crm/fields';
import { estCleReservee } from '../crm/champs-fiche';
import type { Guard } from '../auth/middleware';
import { espaceVerifie, nonEmpty } from './scope';

/** Ce que les routes lisent et écrivent des flows enregistrés en local. */
export interface FlowsDep {
  list(tenantId: string): Promise<FlowRow[]>;
  belongsTo(flowId: string, tenantId: string): Promise<boolean>;
  markPublished(flowId: string, tenantId: string): Promise<boolean>;
  /** Un flow par id, scopé tenant (édition/duplication : lire status + screens). null si absent. */
  getById(flowId: string, tenantId: string): Promise<FlowRow | null>;
  /** Retire le flow du store local (après suppression/dépréciation Meta). true si supprimé. */
  remove(flowId: string, tenantId: string): Promise<boolean>;
  /** Réconciliation : aligne nom + statut d'un flow local sur Meta. true si la ligne a vraiment changé. */
  alignFromMeta(flowId: string, tenantId: string, patch: { name: string; status: 'DRAFT' | 'PUBLISHED' }): Promise<boolean>;
}

export interface FlowRouteDeps {
  meta: {
    /** Client flows Meta résolu par espace (token de l'espace, repli global en sommeil). */
    flowClientForTenant(tenantId: string): Promise<MetaFlowClient>;
  };
  repo: { getTenantWabaId(tenantId: string): Promise<string | null> };
  flows: FlowsDep;
  insertFlow(tenantId: string, id: string, name: string, screens: FlowScreenDef[], ref: string, mapping: Record<string, string>, cta?: string): Promise<void>;
  /** Crée le user field s'il n'existe pas (mapping par défaut : chaque champ -> son propre user field). */
  ensureUserField(tenantId: string, label: string, type: UserFieldType): Promise<void>;
  champs: {
    /** Définitions des user fields du tenant : valider qu'une cible de consentement choisie est bien booléenne. */
    list(tenantId: string): Promise<UserFieldDef[]>;
  };
  /** Crée (idempotent, par clé) le champ booléen de consentement par défaut `whatsapp_optin`. */
  ensureOptinField(tenantId: string): Promise<void>;
  /** Met à jour un flow DRAFT en base (fields re-dérivé côté store). true si une ligne DRAFT a bougé. */
  updateFlowRow(tenantId: string, id: string, name: string, screens: FlowScreenDef[], ref: string, mapping: Record<string, string>, cta?: string): Promise<boolean>;
  /** Réconciliation : enregistre un flow vu chez Meta et absent en local (structure inconnue). true si créé. */
  insertExternalFlow(tenantId: string, flow: { id: string; name: string; status: 'DRAFT' | 'PUBLISHED' }): Promise<boolean>;
  /**
   * Les titres des messages interactifs de l'agent de Meta qui ouvrent ce formulaire (`messagesInteractifsDuFormulaire`,
   * `src/mba/messages-interactifs.ts`) : `[]` pour un espace sans agent, lève si Meta est en panne.
   */
  messagesInteractifsDuFormulaire(tenantId: string, flowId: string): Promise<string[]>;
}

const IMG_MAX = 400 * 1024; // base64 borné (~300 Ko binaire) : l'image Flow s'embarque dans le flow_json
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

/** Valide une liste d'éléments (un écran). Renvoie null si invalide ; les saveTo sont poussés dans
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
      // champ booléen (validé dans deriveAndMap) ; sans cible, défaut = whatsapp_optin (créé à la volée).
      saveTos.push(nonEmpty(el.saveTo) ? el.saveTo.trim() : undefined);
      fieldCount += 1;
    } else {
      return null;
    }
  }
  return { elements, fieldCount };
}

/**
 * Valide le corps riche, multi-écrans. Deux formes : `screens: [{ title?, cta?, elements }]` (1 à MAX_SCREENS
 * écrans, chacun avec au moins un élément, au moins un champ au total), ou `elements: [...]` (forme mono-écran,
 * enveloppée en un écran). Rend les écrans et les saveTo alignés sur l'ordre global des champs, null si invalide.
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
 * Dérive les écrans (clés de champ uniques au global, sinon DuplicateFieldKeyError ; visibleIf validés, sinon
 * VisibleIfError), puis construit le mapping champ -> user field (par défaut celui de la clé, créé ici ; sinon la
 * cible choisie). Rend une erreur (400) ou le trio prêt. Partagé par la création et l'édition.
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
  // Défs chargées une fois, seulement si un consentement (optin) désigne une cible explicite à valider.
  let defs: UserFieldDef[] | null = null;
  for (let i = 0; i < fields.length; i += 1) {
    const f = fields[i]!;
    const saveTo = parsed.saveTos[i];
    // La clé d'un champ FIXE de la fiche (`analyse_sentiment`, `external_id`...) n'est jamais une cible : un champ
    // perso homonyme se confondrait avec lui, et la dernière analyse n'est écrite que par l'analyse. ⚠️ Sauf `nom`
    // et `wa_id`, qu'un formulaire écrivait déjà avant la liste unique : une question « Nom » est la plus courante,
    // la refuser casserait la création comme l'édition des formulaires.
    const cible = saveTo ?? f.key;
    if (estCleReservee(cible) && cible !== 'nom' && cible !== 'wa_id') {
      return { error: `« ${f.label} » : « ${cible} » est un champ réservé de la fiche, renommez la question` };
    }
    if (f.type === 'optin') {
      // Consentement : cible = champ booléen choisi (validé) ou, à défaut, whatsapp_optin (créé à la volée).
      if (saveTo) {
        defs ??= await deps.champs.list(tenant);
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
  // Deux consentements ne peuvent pas viser le même champ : le second écraserait le premier alors que le gate
  // opt-in s'ouvre au moindre « oui ». Vaut pour le défaut (whatsapp_optin) comme pour deux cibles identiques.
  const optinTargets = fields.filter((f) => f.type === 'optin').map((f) => mapping[f.key]!);
  if (new Set(optinTargets).size !== optinTargets.length) {
    return { error: 'deux consentements enregistrent dans le même champ : donnez une cible distincte à chacun' };
  }
  return { derived, mapping, fields };
}

const INVALID_ELEMENTS = 'screens/elements invalide (1 à 10 écrans, chacun >= 1 élément ; au moins 1 champ au global ; texte non vide ; image base64 <= 300KB ; type de champ valide ; visibleIf {field, op eq/neq, value})';

/**
 * Routes Flows (constructeur de formulaire), admin via `garde`, espace du JWT. Création : dérive les clés, génère
 * un `ref` (discriminant au retour), crée chez Meta puis persiste. Édition (DRAFT seulement) : réécrit le
 * flow_json via /assets et le store, même ref. Duplication : un nouveau DRAFT avec un ref frais.
 */
export function registerFlows(app: FastifyInstance, deps: FlowRouteDeps, garde: Guard): void {
  // bodyLimit relevé (défaut global = 1 Mo) : un flow riche peut embarquer plusieurs images base64
  // (~400 Ko chacune) dans le body. Aligné sur la route media. S'applique aussi à GET/publish (sans effet).
  const opts = { preHandler: garde, bodyLimit: 7 * 1024 * 1024 };

  app.post('/tenants/:tenantId/flows', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);

    const b = (req.body ?? {}) as { name?: unknown; screens?: unknown; elements?: unknown; cta?: unknown };
    if (!nonEmpty(b.name)) return reply.code(400).send({ error: 'name requis' });
    const parsed = parseFlowBody(b);
    if (parsed === null) return reply.code(400).send({ error: INVALID_ELEMENTS });
    const cta = nonEmpty(b.cta) ? b.cta.trim() : undefined;

    const wabaId = await deps.repo.getTenantWabaId(tenant);
    if (!wabaId) return reply.code(400).send({ error: 'aucun WABA pour ce tenant' });

    const mapped = await deriveAndMap(deps, tenant, parsed); // 400 (collision/condition) avant tout appel Meta
    if ('error' in mapped) return reply.code(400).send({ error: mapped.error });

    const ref = randomUUID();
    const name = b.name.trim();
    const { id, status } = await (await deps.meta.flowClientForTenant(tenant)).create(wabaId, { name, screens: mapped.derived, ref, ...(cta ? { cta } : {}) });
    await deps.insertFlow(tenant, id, name, mapped.derived, ref, mapped.mapping, cta);
    return reply.code(201).send({ id, status, name, fields: mapped.fields });
  });

  // Édition d'un flow DRAFT : réécrit le flow_json (/assets multipart) + le store. PUBLISHED -> 409 (immuable).
  app.patch('/tenants/:tenantId/flows/:flowId', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { flowId } = req.params as { flowId: string };

    const b = (req.body ?? {}) as { name?: unknown; screens?: unknown; elements?: unknown; cta?: unknown };
    if (!nonEmpty(b.name)) return reply.code(400).send({ error: 'name requis' });
    const parsed = parseFlowBody(b);
    if (parsed === null) return reply.code(400).send({ error: INVALID_ELEMENTS });
    const cta = nonEmpty(b.cta) ? b.cta.trim() : undefined;

    const existing = await deps.flows.getById(flowId, tenant);
    if (!existing) return reply.code(404).send({ error: 'flow inconnu' });
    if (existing.status === 'PUBLISHED') return reply.code(409).send({ error: 'flow publié : immuable. Utilise « Dupliquer pour modifier ».' });
    // Legacy (screens null) : le builder repartirait d'un formulaire vide et écraserait le contenu d'origine.
    // Symétrique au garde-fou de la duplication (422).
    if (!existing.screens) {
      return reply.code(422).send({ error: 'flow antérieur au modèle riche : à recréer plutôt qu\'à éditer' });
    }

    const wabaId = await deps.repo.getTenantWabaId(tenant);
    if (!wabaId) return reply.code(400).send({ error: 'aucun WABA pour ce tenant' });

    const mapped = await deriveAndMap(deps, tenant, parsed);
    if ('error' in mapped) return reply.code(400).send({ error: mapped.error });

    // On garde le même ref (le flow Meta est le même id ; findByRef du webhook ne doit pas être orphelin).
    const ref = existing.ref ?? randomUUID();
    const name = b.name.trim();
    await (await deps.meta.flowClientForTenant(tenant)).updateDraft(flowId, { name, screens: mapped.derived, ref, ...(cta ? { cta } : {}) }); // Meta avant store
    await deps.updateFlowRow(tenant, flowId, name, mapped.derived, ref, mapped.mapping, cta);
    return reply.code(200).send({ id: flowId, status: 'DRAFT', name, fields: mapped.fields });
  });

  // « Dupliquer pour modifier » : clone un flow en un nouveau DRAFT (ref frais). Meta avant le store.
  app.post('/tenants/:tenantId/flows/:flowId/duplicate', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { flowId } = req.params as { flowId: string };

    const source = await deps.flows.getById(flowId, tenant);
    if (!source) return reply.code(404).send({ error: 'flow inconnu' });
    if (!source.screens) {
      return reply.code(422).send({ error: 'flow sans elements : duplication indisponible (flow antérieur au modèle riche)' });
    }

    const wabaId = await deps.repo.getTenantWabaId(tenant);
    if (!wabaId) return reply.code(400).send({ error: 'aucun WABA pour ce tenant' });

    const ref = randomUUID(); // index unique sur ref -> jamais réutiliser celui de la source
    // Nom de flow unique par WABA (Meta l'exige) : « X (copie) », puis « X (copie 2) »... si déjà pris.
    const taken = new Set((await deps.flows.list(tenant)).map((f) => f.name));
    let name = `${source.name} (copie)`;
    for (let n = 2; taken.has(name); n += 1) name = `${source.name} (copie ${n})`;
    const mapping = source.mapping ?? {};
    const cta = source.cta ?? undefined;
    const { id, status } = await (await deps.meta.flowClientForTenant(tenant)).create(wabaId, { name, screens: source.screens, ref, ...(cta ? { cta } : {}) });
    await deps.insertFlow(tenant, id, name, source.screens, ref, mapping, cta);
    return reply.code(201).send({ id, status, name, fields: fieldsOfScreens(source.screens) });
  });

  app.get('/tenants/:tenantId/flows', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    return reply.code(200).send({ flows: await deps.flows.list(tenant) });
  });

  /**
   * « Rafraîchir » : réconcilie la liste locale (servie par notre base, Meta ne rendant pas la structure d'un
   * flow) avec les formulaires du compte WhatsApp Manager.
   *  - importe les flows connus de Meta et absents en local (structure inconnue : leurs réponses n'alimentent pas
   *    les fiches) ; aligne nom et passage à PUBLISHED des flows connus ;
   *  - `ignores` : statuts hors de notre modèle (DEPRECATED, BLOCKED, THROTTLED) et id déjà pris par un autre espace ;
   *  - `absents` : compte les flows que Meta ne liste plus, sans rien supprimer (on perdrait le mapping d'un retour
   *    de formulaire encore en vol) : la suppression reste le bouton « Supprimer ».
   */
  app.post('/tenants/:tenantId/flows/refresh', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);

    const wabaId = await deps.repo.getTenantWabaId(tenant);
    if (!wabaId) return reply.code(400).send({ error: 'aucun WABA pour ce tenant' });

    const distants = await (await deps.meta.flowClientForTenant(tenant)).list(wabaId);
    const locaux = new Set((await deps.flows.list(tenant)).map((f) => f.id));
    const vus = new Set<string>();
    let importes = 0;
    let majs = 0;
    let ignores = 0;

    for (const d of distants) {
      if (!d.id) continue; // ligne Meta inexploitable : rien à rattacher
      vus.add(d.id);
      const statut = d.status === 'DRAFT' || d.status === 'PUBLISHED' ? d.status : null;
      if (statut === null) {
        ignores += 1;
        continue;
      }
      const nom = d.name.trim() || d.id; // un nom vide rendrait la carte inidentifiable
      if (locaux.has(d.id)) {
        if (await deps.flows.alignFromMeta(d.id, tenant, { name: nom, status: statut })) majs += 1;
      } else if (await deps.insertExternalFlow(tenant, { id: d.id, name: nom, status: statut })) {
        importes += 1;
      } else {
        ignores += 1; // id déjà pris par un autre tenant (WABA partagé) : surtout ne pas le lui prendre
      }
    }

    const absents = [...locaux].filter((id) => !vus.has(id)).length;
    return reply.code(200).send({ importes, majs, ignores, absents });
  });

  app.post('/tenants/:tenantId/flows/:flowId/publish', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { flowId } = req.params as { flowId: string };
    if (!(await deps.flows.belongsTo(flowId, tenant))) return reply.code(404).send({ error: 'flow inconnu' });
    await (await deps.meta.flowClientForTenant(tenant)).publish(flowId);
    await deps.flows.markPublished(flowId, tenant);
    return reply.code(200).send({ id: flowId, status: 'PUBLISHED' });
  });

  // Un DRAFT se supprime, un PUBLISHED se déprécie. Meta avant le store : si Meta refuse (flow rattaché à un
  // template approuvé), son message remonte et la base n'est pas touchée (pas d'orphelin vivant chez Meta).
  app.delete('/tenants/:tenantId/flows/:flowId', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { flowId } = req.params as { flowId: string };
    const flow = await deps.flows.getById(flowId, tenant);
    if (!flow) return reply.code(404).send({ error: 'flow inconnu' });
    // 🔴 Un message interactif de l'agent de Meta qui ouvre ce formulaire l'enverrait encore après sa suppression : on
    // refuse en le nommant. Une panne de Meta refuse aussi, en 422 et pas en 503 : Cloudflare remplace le corps d'un 5xx
    // par sa propre page, et le message qui dit de réessayer serait perdu.
    let utilisateurs: string[];
    try {
      utilisateurs = await deps.messagesInteractifsDuFormulaire(tenant, flowId);
    } catch (err) {
      journaliser('warn', 'formulaire_suppression_verification_impossible', { tenantId: tenant, flowId, err });
      return reply.code(422).send({ error: 'Impossible de vérifier si l’agent de Meta utilise ce formulaire. Réessayez dans un instant.' });
    }
    if (utilisateurs.length > 0) {
      return reply.code(409).send({
        error: `Ce formulaire est utilisé par ${utilisateurs.length === 1 ? 'un message interactif' : `${utilisateurs.length} messages interactifs`} de l’agent de Meta (${utilisateurs.join(', ')}). Supprimez-les d’abord.`,
        messages: utilisateurs,
      });
    }
    if (flow.status === 'PUBLISHED') await (await deps.meta.flowClientForTenant(tenant)).deprecate(flowId);
    else await (await deps.meta.flowClientForTenant(tenant)).delete(flowId);
    await deps.flows.remove(flowId, tenant);
    return reply.code(200).send({ id: flowId, deleted: true });
  });
}
