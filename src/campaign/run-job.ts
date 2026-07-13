import { runCampaign } from './engine';
import type {
  MessageSender,
  RecipientStore,
  CampaignStore,
  FrequencyStore,
  QualityProvider,
  RateGate,
} from './engine';
import type { Campaign, GuardrailThresholds, RunReport } from './types';

export interface RunJobDeps {
  getCampaign(id: string): Promise<Campaign | null>;
  /** Construit le sender pour la campagne (MetaClient sur son phone_number_id en prod, fake en test). */
  senderFor(campaign: Campaign): MessageSender;
  recipients: RecipientStore;
  campaigns: CampaignStore;
  frequency: FrequencyStore;
  quality: QualityProvider;
  rateLimiter?: RateGate;
  /** Campagne WORKFLOW : démarre le workflow pour un destinataire (au lieu d'un envoi template). */
  startWorkflow?: (tenantId: string, workflowId: string, waId: string, contactId: string) => Promise<void>;
  thresholds?: GuardrailThresholds;
}

/**
 * Handler du job `campaign-run` : charge la campagne, assemble ses dépendances et
 * exécute runCampaign. Payload de job non fiable -> valide `campaignId`.
 */
export async function campaignRunJob(data: unknown, deps: RunJobDeps): Promise<RunReport> {
  const campaignId = (data as { campaignId?: unknown } | null)?.campaignId;
  if (typeof campaignId !== 'string' || campaignId === '') {
    throw new Error('campaign-run : campaignId manquant dans le payload');
  }
  const campaign = await deps.getCampaign(campaignId);
  if (!campaign) throw new Error(`campaign-run : campagne inconnue ${campaignId}`);

  return runCampaign(campaign, {
    sender: deps.senderFor(campaign),
    recipients: deps.recipients,
    campaigns: deps.campaigns,
    frequency: deps.frequency,
    quality: deps.quality,
    ...(deps.rateLimiter ? { rateLimiter: deps.rateLimiter } : {}),
    ...(deps.startWorkflow ? { startWorkflow: deps.startWorkflow } : {}),
    ...(deps.thresholds ? { thresholds: deps.thresholds } : {}),
  });
}
