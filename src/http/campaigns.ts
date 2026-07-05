import type { FastifyInstance } from 'fastify';
import type { Queue } from '../queue/queue';
import { createCampaignWithRecipients } from '../campaign/create';
import type { CampaignRepoLike } from '../campaign/create';
import type { CreateCampaignInput, CampaignSummary, CampaignDetail, PhoneNumberRow } from '../campaign/store.pg';
import type { CampaignCategory } from '../campaign/types';
import { validateParamMapping } from '../crm/template';
import { forbidNonAdmin } from '../auth/middleware';
import type { PreHandler } from '../auth/middleware';

export interface CampaignRouteDeps {
  repo: CampaignRepoLike;
  queue: Queue;
  /** Le numéro appartient-il au tenant ? (empêche d'envoyer depuis le numéro d'autrui.) */
  phoneNumberBelongsToTenant(phoneNumberId: string, tenantId: string): Promise<boolean>;
  /** La campagne appartient-elle au tenant ? (scope le run, 404 sinon.) */
  campaignBelongsTo(campaignId: string, tenantId: string): Promise<boolean>;
  listCampaigns(tenantId: string): Promise<CampaignSummary[]>;
  getCampaignDetail(campaignId: string, tenantId: string): Promise<CampaignDetail | null>;
  listPhoneNumbers(tenantId: string): Promise<PhoneNumberRow[]>;
}

const CATEGORIES = new Set<CampaignCategory>(['marketing', 'utility']);

function isCategory(v: unknown): v is CampaignCategory {
  return typeof v === 'string' && CATEGORIES.has(v as CampaignCategory);
}
function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/** Tenant effectif = celui du JWT ; l'URL doit correspondre. null si interdit. */
function scopeTenant(req: { params: unknown; auth?: { tenantId: string } }): string | null {
  const { tenantId } = req.params as { tenantId: string };
  const authTenant = req.auth?.tenantId;
  if (authTenant !== undefined && authTenant !== tenantId) return null;
  return authTenant ?? tenantId;
}

/** Routes de campagne : lecture (liste/détail/numéros), création et déclenchement du run. */
export function registerCampaigns(app: FastifyInstance, deps: CampaignRouteDeps, requireAuth?: PreHandler): void {
  const guard = requireAuth ? { preHandler: requireAuth } : {};

  app.get('/tenants/:tenantId/campaigns', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    return reply.code(200).send({ campaigns: await deps.listCampaigns(tenant) });
  });

  app.get('/tenants/:tenantId/campaigns/:campaignId', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { campaignId } = req.params as { campaignId: string };
    const detail = await deps.getCampaignDetail(campaignId, tenant);
    if (!detail) return reply.code(404).send({ error: 'campagne inconnue' });
    return reply.code(200).send(detail);
  });

  app.get('/tenants/:tenantId/phone-numbers', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    return reply.code(200).send({ phoneNumbers: await deps.listPhoneNumbers(tenant) });
  });

  app.post('/tenants/:tenantId/campaigns', guard, async (req, reply) => {
    const effectiveTenant = scopeTenant(req);
    if (effectiveTenant === null) {
      return reply.code(403).send({ error: 'tenant interdit' });
    }
    if (forbidNonAdmin(req, reply)) return;

    const b = (req.body ?? {}) as Partial<{
      phoneNumberId: string;
      name: string;
      category: CampaignCategory;
      templateName: string;
      templateLanguage: string;
      paramMapping: unknown;
    }>;

    if (!isCategory(b.category)) return reply.code(400).send({ error: 'category invalide (marketing|utility)' });
    if (!nonEmpty(b.phoneNumberId)) return reply.code(400).send({ error: 'phoneNumberId requis' });
    if (!nonEmpty(b.name)) return reply.code(400).send({ error: 'name requis' });
    if (!nonEmpty(b.templateName)) return reply.code(400).send({ error: 'templateName requis' });
    if (!nonEmpty(b.templateLanguage)) return reply.code(400).send({ error: 'templateLanguage requis' });

    // Le numéro doit appartenir au tenant (sinon envoi depuis le numéro d'un autre client).
    if (!(await deps.phoneNumberBelongsToTenant(b.phoneNumberId, effectiveTenant))) {
      return reply.code(400).send({ error: 'phoneNumberId inconnu pour ce tenant' });
    }

    // Valider paramMapping AVANT toute écriture : positions 1..N contiguës + sources bien
    // formées. Invalide -> 400 déterministe (indépendant du nb de contacts), pas un 500.
    const paramMapping = validateParamMapping(b.paramMapping ?? []);
    if (paramMapping === null) {
      return reply.code(400).send({ error: 'paramMapping invalide (positions 1..N contiguës, sources valides)' });
    }

    const input: CreateCampaignInput = {
      tenantId: effectiveTenant,
      phoneNumberId: b.phoneNumberId,
      name: b.name,
      category: b.category,
      templateName: b.templateName,
      templateLanguage: b.templateLanguage,
      paramMapping,
    };
    const result = await createCampaignWithRecipients(input, deps.repo);
    return reply.code(201).send(result);
  });

  app.post('/campaigns/:campaignId/run', guard, async (req, reply) => {
    if (forbidNonAdmin(req, reply)) return;
    const { campaignId } = req.params as { campaignId: string };
    const authTenant = req.auth?.tenantId ?? '';
    // Scope tenant : 404 si la campagne n'appartient pas à l'appelant (pas d'IDOR cross-tenant).
    if (!(await deps.campaignBelongsTo(campaignId, authTenant))) {
      return reply.code(404).send({ error: 'campagne inconnue' });
    }
    // singletonKey = campaignId : deux POST /run concurrents n'empilent pas deux jobs pour
    // la même campagne (le claim par destinataire est le garde-fou primaire, ceci le double).
    await deps.queue.enqueue('campaign-run', { campaignId }, { singletonKey: campaignId });
    return reply.code(202).send({ enqueued: true, campaignId });
  });
}
