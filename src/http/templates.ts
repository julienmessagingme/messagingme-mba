import type { FastifyInstance } from 'fastify';
import { forbidNonAdmin } from '../auth/middleware';
import type { Guard } from '../auth/middleware';
import type { MetaTemplateClient, CreateTemplateInput, TemplateButton, CarouselCard, TemplateHeader } from '../meta/templates';
import type { CampaignStatus } from '../campaign/types';
import { parseParamHints } from '../crm/template';
import type { ParamSource } from '../crm/template';
import { isValidTemplateLanguage } from '../meta/languages';

export interface TemplateRouteDeps {
  /** Client templates Meta résolu PAR TENANT (B1 : token du tenant, repli global en sommeil). */
  templatesFor(tenantId: string): Promise<MetaTemplateClient>;
  /** WABA du tenant (les templates sont au niveau WABA). */
  getWabaId(tenantId: string): Promise<string | null>;
  /** Optionnel : pré-check « ce flowId est-il PUBLISHED pour ce tenant ? » avant d'appeler Meta.
   *  Absent -> pas de pré-check (Meta reste seul juge, 422 passthrough). */
  getPublishedFlow?(tenantId: string, flowId: string): Promise<boolean>;
  /** Garde-fou D1 : campagnes ACTIVES (draft/running/paused) référençant ce template (name, langue optionnelle).
   *  Absent -> pas de garde-fou (édition/suppression non bloquées). */
  listActiveCampaignsForTemplate?(
    tenantId: string,
    templateName: string,
    templateLanguage?: string,
  ): Promise<Array<{ id: string; name: string; status: CampaignStatus; templateLanguage: string }>>;
  /** Indices « variable -> champ » posés au design (sélecteur de champ) : persistés pour pré-remplir la
   *  campagne. Optionnels : absents -> feature de propagation désactivée (le template se crée quand même). */
  saveParamHints?(tenantId: string, name: string, language: string, hints: Array<{ position: number; source: ParamSource }>): Promise<void>;
  getParamHints?(tenantId: string, name: string, language: string): Promise<Array<{ position: number; source: ParamSource }>>;
  removeParamHints?(tenantId: string, name: string): Promise<void>;
}

/** Persistance best-effort des indices variable->champ : un hoquet DB ne doit pas faire échouer un template
 *  DÉJÀ créé chez Meta (la propagation se dégrade juste : la campagne ne pré-remplira pas). */
async function saveHintsSafe(deps: TemplateRouteDeps, tenant: string, name: string, language: string, raw: unknown): Promise<void> {
  if (!deps.saveParamHints) return;
  // Clé ABSENTE (undefined) = « ne touche pas aux indices » (un PATCH qui ne concerne pas les variables ne
  // doit PAS effacer les indices existants). Seul un tableau EXPLICITE (même vide) remplace.
  if (raw === undefined) return;
  const hints = parseParamHints(raw);
  if (hints === null) return; // déjà validé en 400 en amont ; garde défensive
  try {
    await deps.saveParamHints(tenant, name, language, hints);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('saveParamHints ignoré:', err instanceof Error ? err.message : err);
  }
}

function scopeTenant(req: { params: unknown; auth?: { tenantId: string } }): string | null {
  const { tenantId } = req.params as { tenantId: string };
  const authTenant = req.auth?.tenantId;
  if (authTenant !== undefined && authTenant !== tenantId) return null;
  return authTenant ?? tenantId;
}

const CATEGORIES = new Set(['MARKETING', 'UTILITY']);
/** Statuts qu'un template Meta autorise à éditer (POST /{id}). PENDING/IN_APPEAL non éditables. */
const EDITABLE_STATUSES = new Set(['APPROVED', 'REJECTED', 'PAUSED']);

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}
function validButtons(v: unknown): v is TemplateButton[] | undefined {
  if (v === undefined) return true;
  if (!Array.isArray(v)) return false;
  const okEach = v.every((b) => {
    const btn = b as { type?: unknown; text?: unknown; url?: unknown; flowId?: unknown };
    if (btn.type === 'QUICK_REPLY') return nonEmpty(btn.text);
    if (btn.type === 'URL') return nonEmpty(btn.text) && nonEmpty(btn.url);
    if (btn.type === 'FLOW') return nonEmpty(btn.text) && nonEmpty(btn.flowId);
    return false;
  });
  if (!okEach) return false;
  // Contrainte Meta : un bouton FLOW est EXCLUSIF (impossible de le mélanger à d'autres boutons).
  const hasFlow = v.some((b) => (b as { type?: unknown }).type === 'FLOW');
  return !hasFlow || v.length === 1;
}

/** Champs qui déterminent les components d'un template (partagés create + edit ; name/language exclus). */
type TemplateFields = Pick<CreateTemplateInput, 'category' | 'header' | 'body' | 'example' | 'footer' | 'buttons' | 'carousel'>;

const HEADER_MAX = 60;
const FOOTER_MAX = 60;

/** Valide l'en-tête (texte / média). null = pas d'en-tête. {error} ou {header}. */
function parseHeader(hRaw: unknown): { error: string } | { header?: TemplateHeader } {
  if (hRaw === undefined || hRaw === null) return { header: undefined };
  const hh = hRaw as { format?: unknown; text?: unknown; handle?: unknown; example?: unknown };
  if (hh.format === 'TEXT') {
    if (!nonEmpty(hh.text)) return { error: 'en-tête texte requis' };
    if (hh.text.length > HEADER_MAX) return { error: `en-tête texte trop long (max ${HEADER_MAX})` };
    // V1 : pas de variable dans l'en-tête texte. Le pipeline d'envoi (campagnes + inbox) ne sait pas fournir
    // un paramètre de header -> Meta rejetterait l'envoi (#132000). On bloque à la source (template inenvoyable).
    if (/\{\{\s*\d+\s*\}\}/.test(hh.text)) return { error: 'variable non supportée dans l\'en-tête (V1) : utilise un texte fixe' };
    return { header: { format: 'TEXT', text: hh.text.trim() } };
  }
  if (hh.format === 'IMAGE' || hh.format === 'VIDEO' || hh.format === 'DOCUMENT') {
    if (!nonEmpty(hh.handle)) return { error: 'en-tête média : handle requis (uploader le fichier d\'abord)' };
    return { header: { format: hh.format, handle: hh.handle } };
  }
  return { error: 'en-tête : format invalide (TEXT|IMAGE|VIDEO|DOCUMENT)' };
}

/**
 * Validation SYNCHRONE commune à la création et à l'édition : category, body, boutons, carousel, exemples.
 * Renvoie soit une erreur (message + code 400), soit les champs normalisés prêts à builder les components.
 * Le pré-check async « flow publié » (getPublishedFlow) et le WABA restent à la charge de l'appelant.
 */
function parseTemplateFields(b: Record<string, unknown>): { error: string } | { fields: TemplateFields } {
  if (typeof b.category !== 'string' || !CATEGORIES.has(b.category)) return { error: 'category invalide (MARKETING|UTILITY)' };
  if (!nonEmpty(b.body)) return { error: 'body requis' };
  if (!validButtons(b.buttons)) return { error: 'buttons invalides' };

  // Carousel : 2-10 cartes, chaque carte a une image (handle) + des boutons IDENTIQUES entre cartes.
  let carousel: { cards: CarouselCard[] } | undefined;
  const carRaw = b.carousel;
  if (carRaw !== undefined) {
    const cards = (carRaw as { cards?: unknown }).cards;
    if (!Array.isArray(cards) || cards.length < 2 || cards.length > 10) return { error: 'carousel : entre 2 et 10 cartes' };
    const sig = (c: { buttons?: unknown }) => (Array.isArray(c.buttons) ? c.buttons.map((x) => (x as { type?: string }).type).join(',') : '');
    const firstSig = sig(cards[0] as { buttons?: unknown });
    for (const raw of cards) {
      const c = raw as { headerHandle?: unknown; buttons?: unknown };
      if (!nonEmpty(c.headerHandle)) return { error: 'chaque carte doit avoir une image' };
      if (sig(c) !== firstSig) return { error: 'toutes les cartes doivent avoir les mêmes boutons' };
      if (Array.isArray(c.buttons)) {
        for (const bt of c.buttons) {
          const btn = bt as { type?: string; text?: unknown; url?: unknown };
          if (btn.type === 'QUICK_REPLY' && nonEmpty(btn.text)) continue;
          if (btn.type === 'URL' && nonEmpty(btn.text) && nonEmpty(btn.url)) continue;
          return { error: 'bouton de carte invalide (quick_reply|url uniquement)' };
        }
      }
    }
    carousel = { cards: cards as CarouselCard[] };
  }

  // En-tête (texte / image / vidéo). Ignoré si carousel (le carousel a ses en-têtes par carte).
  const h = parseHeader(b.header);
  if ('error' in h) return { error: h.error };

  // Pied de page (texte court, sans variable).
  let footer: string | undefined;
  if (b.footer !== undefined && b.footer !== null && b.footer !== '') {
    if (!nonEmpty(b.footer)) return { error: 'pied de page invalide' };
    if (b.footer.length > FOOTER_MAX) return { error: `pied de page trop long (max ${FOOTER_MAX})` };
    footer = b.footer.trim();
  }

  // Nb de variables {{n}} dans le corps -> exiger autant d'exemples.
  const varCount = new Set(((b.body as string).match(/\{\{\s*\d+\s*\}\}/g) ?? [])).size;
  const example = Array.isArray(b.example) ? b.example.map(String) : [];
  if (varCount > 0 && example.length < varCount) {
    return { error: `exemples manquants : ${varCount} variable(s) dans le corps` };
  }

  return {
    fields: {
      category: b.category as 'MARKETING' | 'UTILITY',
      body: b.body as string,
      ...(!carousel && h.header ? { header: h.header } : {}),
      ...(!carousel && footer ? { footer } : {}),
      ...(varCount > 0 ? { example: example.slice(0, varCount) } : {}),
      // Un carousel a ses boutons PAR CARTE : on ignore d'éventuels boutons top-level s'il est présent.
      ...(carousel ? { carousel } : Array.isArray(b.buttons) ? { buttons: b.buttons as TemplateButton[] } : {}),
    },
  };
}

/** Pré-check async : si un bouton FLOW est présent, le flow doit être PUBLISHED. true = OK / continuer. */
async function flowButtonOk(deps: TemplateRouteDeps, tenant: string, buttons: TemplateButton[] | undefined): Promise<boolean> {
  const flowBtn = buttons?.find((x) => x.type === 'FLOW');
  if (!flowBtn || !deps.getPublishedFlow) return true;
  return deps.getPublishedFlow(tenant, flowBtn.flowId ?? '');
}

/** Routes de templates : liste + création + édition + suppression (soumission à validation Meta). */
export function registerTemplates(app: FastifyInstance, deps: TemplateRouteDeps, requireAuth?: Guard): void {
  const guard = requireAuth ? { preHandler: requireAuth } : {};

  app.get('/tenants/:tenantId/templates', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const wabaId = await deps.getWabaId(tenant);
    if (!wabaId) return reply.code(200).send({ templates: [] });
    return reply.code(200).send({ templates: await (await deps.templatesFor(tenant)).list(wabaId) });
  });

  app.post('/tenants/:tenantId/templates', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;

    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!nonEmpty(b.name)) return reply.code(400).send({ error: 'name requis' });
    if (!nonEmpty(b.language)) return reply.code(400).send({ error: 'language requis' });
    // Langue = code Meta valide (whitelist). Le sélecteur front ne propose que des codes valides ; on garde le
    // garde-fou serveur pour un appel API direct (une langue invalide serait rejetée par Meta plus loin, sans message clair).
    if (!isValidTemplateLanguage(b.language)) return reply.code(400).send({ error: 'language non supportée (hors liste WhatsApp)' });
    const parsed = parseTemplateFields(b);
    if ('error' in parsed) return reply.code(400).send({ error: parsed.error });
    if (parseParamHints(b.paramHints) === null) return reply.code(400).send({ error: 'paramHints invalides' });

    const wabaId = await deps.getWabaId(tenant);
    if (!wabaId) return reply.code(400).send({ error: 'aucun WABA pour ce tenant' });
    if (!(await flowButtonOk(deps, tenant, parsed.fields.buttons))) {
      return reply.code(400).send({ error: 'le flow référencé n\'est pas publié' });
    }

    const input: CreateTemplateInput = { name: b.name, language: b.language, ...parsed.fields };
    const res = await (await deps.templatesFor(tenant)).create(wabaId, input);
    await saveHintsSafe(deps, tenant, b.name, b.language, b.paramHints);
    return reply.code(201).send(res);
  });

  // Indices variable -> champ d'un template (pour pré-remplir le mapping d'une campagne). Lecture seule.
  app.get('/tenants/:tenantId/templates/:templateName/param-hints', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { templateName } = req.params as { templateName: string };
    const q = req.query as { language?: string };
    if (!nonEmpty(q.language)) return reply.code(400).send({ error: 'language requis (query)' });
    const hints = deps.getParamHints ? await deps.getParamHints(tenant, decodeURIComponent(templateName), q.language) : [];
    return reply.code(200).send({ hints });
  });

  // Édition d'un template SIMPLE (body/boutons/category). Carousel non supporté (header_handle non récupérable).
  app.patch('/tenants/:tenantId/templates/:templateName', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;

    const { templateName } = req.params as { templateName: string };
    const name = decodeURIComponent(templateName);
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!nonEmpty(b.language)) return reply.code(400).send({ error: 'language requis' });
    const language = b.language;
    const parsed = parseTemplateFields(b);
    if ('error' in parsed) return reply.code(400).send({ error: parsed.error });
    if (parseParamHints(b.paramHints) === null) return reply.code(400).send({ error: 'paramHints invalides' });
    if (parsed.fields.carousel) return reply.code(422).send({ error: 'édition d\'un carousel non supportée' });

    const wabaId = await deps.getWabaId(tenant);
    if (!wabaId) return reply.code(400).send({ error: 'aucun WABA pour ce tenant' });

    // SÉCURITÉ : on résout l'id CÔTÉ SERVEUR depuis le WABA du tenant (l'edit Meta est par id global,
    // non scopé WABA -> un id fourni par le client permettrait d'éditer le template d'un autre tenant).
    const existing = (await (await deps.templatesFor(tenant)).list(wabaId)).find((t) => t.name === name && t.language === language);
    if (!existing) return reply.code(404).send({ error: 'template introuvable' });
    if (!existing.id) return reply.code(422).send({ error: 'id du template indisponible' });
    // Anti perte de données : un template avec HEADER / FOOTER / CAROUSEL verrait ces composants SUPPRIMÉS
    // par l'édition (buildComponents ne régénère que BODY/BUTTONS + Meta remplace tout). On refuse.
    if (!existing.editable) {
      return reply.code(422).send({ error: existing.isCarousel ? 'édition d\'un carousel non supportée' : 'édition non supportée : ce template a un en-tête ou un pied de page qui serait supprimé' });
    }
    if (!EDITABLE_STATUSES.has(existing.status)) {
      return reply.code(409).send({ error: `template non éditable (statut ${existing.status}) : seuls APPROVED/REJECTED/PAUSED le sont` });
    }

    // Garde-fou D1 : une campagne active utilise ce template -> l'éditer le renvoie en PENDING = 422 par envoi.
    if (deps.listActiveCampaignsForTemplate) {
      const active = await deps.listActiveCampaignsForTemplate(tenant, name, language);
      if (active.length > 0) return reply.code(409).send({ error: 'template utilisé par une campagne active', campaigns: active });
    }

    if (!(await flowButtonOk(deps, tenant, parsed.fields.buttons))) {
      return reply.code(400).send({ error: 'le flow référencé n\'est pas publié' });
    }

    const res = await (await deps.templatesFor(tenant)).update(existing.id, {
      category: parsed.fields.category,
      body: parsed.fields.body,
      ...(parsed.fields.header ? { header: parsed.fields.header } : {}),
      ...(parsed.fields.footer ? { footer: parsed.fields.footer } : {}),
      ...(parsed.fields.example ? { example: parsed.fields.example } : {}),
      ...(parsed.fields.buttons ? { buttons: parsed.fields.buttons } : {}),
    });
    await saveHintsSafe(deps, tenant, name, language, b.paramHints);
    return reply.code(200).send({ ...res, status: 'PENDING' });
  });

  // Suppression par nom = TOUTES les langues chez Meta -> garde-fou toutes langues (langue omise).
  app.delete('/tenants/:tenantId/templates/:templateName', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;

    const { templateName } = req.params as { templateName: string };
    const name = decodeURIComponent(templateName);

    if (deps.listActiveCampaignsForTemplate) {
      const active = await deps.listActiveCampaignsForTemplate(tenant, name);
      if (active.length > 0) return reply.code(409).send({ error: 'template utilisé par une campagne active', campaigns: active });
    }

    const wabaId = await deps.getWabaId(tenant);
    if (!wabaId) return reply.code(400).send({ error: 'aucun WABA pour ce tenant' });
    const res = await (await deps.templatesFor(tenant)).remove(wabaId, name);
    if (deps.removeParamHints) await deps.removeParamHints(tenant, name).catch(() => {});
    return reply.code(200).send(res);
  });
}
