import { runCampaign } from './engine';
import type {
  MessageSender,
  RecipientStore,
  CampaignStore,
  FrequencyStore,
  QualityProvider,
  RateGate,
} from './engine';
import { RateLimiter } from '../meta/http';
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
  /** Fabrique du limiteur PAR CAMPAGNE (intervalle minimal en ms). Défaut : un vrai RateLimiter.
   *  Injectable pour tester le câblage sans dépendre d'un vrai sleep temporel. */
  makeRateLimiter?: (minIntervalMs: number) => RateGate;
  /** Campagne WORKFLOW : démarre le workflow pour un destinataire (au lieu d'un envoi template).
   *  `firstTemplateParams` = variables du 1er template déjà résolues par contact (transmises à l'envoi). */
  startWorkflow?: (tenantId: string, workflowId: string, waId: string, contactId: string, firstTemplateParams: string[]) => Promise<void>;
  /** Journalise l'envoi sortant dans le fil de conversation (best-effort). */
  recordOutbound?: (
    tenantId: string,
    waId: string,
    msg: { body: string; messageId: string | null; type?: string; templateCategory?: string | null; templateName?: string | null },
  ) => Promise<void>;
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

  // Débit PAR CAMPAGNE : si un ratePerMinute est posé, on instancie un RateLimiter dédié à CE run (intervalle
  // minimal = 60000/rate ms). Il prime sur un éventuel limiteur statique. 1 job = 1 campagne, donc l'instance
  // est naturellement par-campagne. Le throttle attend AVANT de claimer le destinataire suivant : aucun
  // destinataire ne reste 'sending' plus longtemps qu'une latence d'envoi (le sweeper reclaim ne le voit pas).
  const rate = campaign.ratePerMinute;
  const makeLimiter = deps.makeRateLimiter ?? ((ms: number) => new RateLimiter(ms));
  const rateLimiter: RateGate | undefined =
    rate && rate > 0 ? makeLimiter(Math.ceil(60_000 / rate)) : deps.rateLimiter;

  return runCampaign(campaign, {
    sender: deps.senderFor(campaign),
    recipients: deps.recipients,
    campaigns: deps.campaigns,
    frequency: deps.frequency,
    quality: deps.quality,
    ...(rateLimiter ? { rateLimiter } : {}),
    ...(deps.startWorkflow ? { startWorkflow: deps.startWorkflow } : {}),
    ...(deps.recordOutbound ? { recordOutbound: deps.recordOutbound } : {}),
    ...(deps.thresholds ? { thresholds: deps.thresholds } : {}),
  });
}
