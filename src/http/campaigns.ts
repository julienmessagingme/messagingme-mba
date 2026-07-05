import type { FastifyInstance } from 'fastify';
import type { Queue } from '../queue/queue';
import { createCampaignWithRecipients } from '../campaign/create';
import type { CampaignRepoLike } from '../campaign/create';
import type { CreateCampaignInput } from '../campaign/store.pg';
import type { CampaignCategory } from '../campaign/types';
import { validateParamMapping } from '../crm/template';

export interface CampaignRouteDeps {
  repo: CampaignRepoLike;
  queue: Queue;
  /** true si la campagne existe (pour le 404 du run). */
  campaignExists(id: string): Promise<boolean>;
}

const CATEGORIES = new Set<CampaignCategory>(['marketing', 'utility']);

function isCategory(v: unknown): v is CampaignCategory {
  return typeof v === 'string' && CATEGORIES.has(v as CampaignCategory);
}
function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/** Routes de campagne : création (+ construction des destinataires) et déclenchement du run. */
export function registerCampaigns(app: FastifyInstance, deps: CampaignRouteDeps): void {
  app.post('/tenants/:tenantId/campaigns', async (req, reply) => {
    const { tenantId } = req.params as { tenantId: string };
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

    // Valider paramMapping AVANT toute écriture : positions 1..N contiguës + sources bien
    // formées. Invalide -> 400 déterministe (indépendant du nb de contacts), pas un 500.
    const paramMapping = validateParamMapping(b.paramMapping ?? []);
    if (paramMapping === null) {
      return reply.code(400).send({ error: 'paramMapping invalide (positions 1..N contiguës, sources valides)' });
    }

    const input: CreateCampaignInput = {
      tenantId,
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

  app.post('/campaigns/:campaignId/run', async (req, reply) => {
    const { campaignId } = req.params as { campaignId: string };
    if (!(await deps.campaignExists(campaignId))) {
      return reply.code(404).send({ error: 'campagne inconnue' });
    }
    // singletonKey = campaignId : deux POST /run concurrents n'empilent pas deux jobs pour
    // la même campagne (le claim par destinataire est le garde-fou primaire, ceci le double).
    await deps.queue.enqueue('campaign-run', { campaignId }, { singletonKey: campaignId });
    return reply.code(202).send({ enqueued: true, campaignId });
  });
}
