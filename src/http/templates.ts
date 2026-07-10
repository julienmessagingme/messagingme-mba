import type { FastifyInstance } from 'fastify';
import { forbidNonAdmin } from '../auth/middleware';
import type { Guard } from '../auth/middleware';
import type { MetaTemplateClient, CreateTemplateInput, TemplateButton } from '../meta/templates';

export interface TemplateRouteDeps {
  templates: MetaTemplateClient;
  /** WABA du tenant (les templates sont au niveau WABA). */
  getWabaId(tenantId: string): Promise<string | null>;
  /** Optionnel : pré-check « ce flowId est-il PUBLISHED pour ce tenant ? » avant d'appeler Meta.
   *  Absent -> pas de pré-check (Meta reste seul juge, 422 passthrough). */
  getPublishedFlow?(tenantId: string, flowId: string): Promise<boolean>;
}

function scopeTenant(req: { params: unknown; auth?: { tenantId: string } }): string | null {
  const { tenantId } = req.params as { tenantId: string };
  const authTenant = req.auth?.tenantId;
  if (authTenant !== undefined && authTenant !== tenantId) return null;
  return authTenant ?? tenantId;
}

const CATEGORIES = new Set(['MARKETING', 'UTILITY']);
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

/** Routes de templates : liste (statut Meta) + création (soumission à validation Meta). */
export function registerTemplates(app: FastifyInstance, deps: TemplateRouteDeps, requireAuth?: Guard): void {
  const guard = requireAuth ? { preHandler: requireAuth } : {};

  app.get('/tenants/:tenantId/templates', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const wabaId = await deps.getWabaId(tenant);
    if (!wabaId) return reply.code(200).send({ templates: [] });
    return reply.code(200).send({ templates: await deps.templates.list(wabaId) });
  });

  app.post('/tenants/:tenantId/templates', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;

    const b = (req.body ?? {}) as Partial<CreateTemplateInput> & { buttons?: unknown };
    if (!nonEmpty(b.name)) return reply.code(400).send({ error: 'name requis' });
    if (typeof b.category !== 'string' || !CATEGORIES.has(b.category)) {
      return reply.code(400).send({ error: 'category invalide (MARKETING|UTILITY)' });
    }
    if (!nonEmpty(b.language)) return reply.code(400).send({ error: 'language requis' });
    if (!nonEmpty(b.body)) return reply.code(400).send({ error: 'body requis' });
    if (!validButtons(b.buttons)) return reply.code(400).send({ error: 'buttons invalides' });

    const wabaId = await deps.getWabaId(tenant);
    if (!wabaId) return reply.code(400).send({ error: 'aucun WABA pour ce tenant' });

    // Bouton FLOW : le flow référencé doit être PUBLISHED (pré-check avant Meta si dispo).
    const flowBtn = Array.isArray(b.buttons) ? (b.buttons as TemplateButton[]).find((x) => x.type === 'FLOW') : undefined;
    if (flowBtn && deps.getPublishedFlow && !(await deps.getPublishedFlow(tenant, flowBtn.flowId ?? ''))) {
      return reply.code(400).send({ error: 'le flow référencé n\'est pas publié' });
    }

    // Nb de variables {{n}} dans le corps -> exiger autant d'exemples.
    const varCount = new Set((b.body.match(/\{\{\s*\d+\s*\}\}/g) ?? [])).size;
    const example = Array.isArray(b.example) ? b.example.map(String) : [];
    if (varCount > 0 && example.length < varCount) {
      return reply.code(400).send({ error: `exemples manquants : ${varCount} variable(s) dans le corps` });
    }

    const input: CreateTemplateInput = {
      name: b.name,
      category: b.category as 'MARKETING' | 'UTILITY',
      language: b.language,
      body: b.body,
      ...(varCount > 0 ? { example: example.slice(0, varCount) } : {}),
      ...(Array.isArray(b.buttons) ? { buttons: b.buttons as TemplateButton[] } : {}),
    };
    const res = await deps.templates.create(wabaId, input);
    return reply.code(201).send(res);
  });
}
