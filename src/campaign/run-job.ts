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
import { resolveRatePerMinute } from './pacing';
import { TokenInvalidError } from '../meta/credentials';
import type { Campaign, GuardrailThresholds, RunReport } from './types';

export interface RunJobDeps {
  getCampaign(id: string): Promise<Campaign | null>;
  /** Construit le sender pour la campagne (MetaClient sur le token du tenant en prod, fake en test). Async : la
   *  résolution du token par tenant (B1) lit la base + déchiffre. */
  senderFor(campaign: Campaign): Promise<MessageSender>;
  recipients: RecipientStore;
  campaigns: CampaignStore;
  frequency: FrequencyStore;
  quality: QualityProvider;
  rateLimiter?: RateGate;
  /** Fabrique du limiteur PAR CAMPAGNE (intervalle minimal en ms). Défaut : un vrai RateLimiter.
   *  Injectable pour tester le câblage sans dépendre d'un vrai sleep temporel. */
  makeRateLimiter?: (minIntervalMs: number) => RateGate;
  /**
   * Débit par défaut (msg/min) appliqué aux campagnes SANS ratePerMinute explicite. Injecté par le worker
   * depuis config.CAMPAIGN_DEFAULT_RATE_PER_MINUTE. ABSENT des deps de test à dessein : sans lui, une campagne
   * à rate null reste en opt-out (aucun frein), donc les tests de câblage existants ne changent pas.
   */
  defaultRatePerMinute?: number;
  /**
   * Revalide que le numéro d'envoi de la campagne appartient toujours à son tenant, juste avant d'envoyer. Défense
   * contre une réaffectation de numéro survenue entre la création de la campagne et son exécution. OPTIONNEL :
   * absent des deps, la garde est sautée (les tests et l'e2e qui n'insèrent pas de ligne phone_numbers ne cassent
   * pas). Le worker l'injecte en prod.
   */
  phoneNumberBelongsToTenant?: (phoneNumberId: string, tenantId: string) => Promise<boolean>;
  /** Campagne WORKFLOW : démarre le workflow pour un destinataire (au lieu d'un envoi template).
   *  `firstTemplateParams` = variables du 1er template déjà résolues par contact (transmises à l'envoi). */
  startWorkflow?: (tenantId: string, workflowId: string, waId: string, contactId: string, firstTemplateParams: string[]) => Promise<void>;
  /** Campagne NODE (/v1/sends) : démarre le workflow à un bloc précis (fenêtre 24 h déjà vérifiée en amont). */
  startWorkflowFromNode?: (tenantId: string, workflowId: string, startNodeId: string, waId: string, contactId: string) => Promise<void>;
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

  // Garde d'appartenance du numéro (optionnelle, injectée en prod par le worker). Si le numéro a été réaffecté à un
  // autre tenant depuis la création de la campagne, on n'envoie RIEN et on remonte la raison dans le rapport (pas de
  // colonne dédiée) plutôt que d'envoyer depuis un numéro qui n'est plus le nôtre.
  if (deps.phoneNumberBelongsToTenant && !(await deps.phoneNumberBelongsToTenant(campaign.phoneNumberId, campaign.tenantId))) {
    return { sent: 0, skipped: 0, failed: 0, paused: true, reason: 'numéro non rattaché à ce workspace (réaffecté ?)' };
  }

  // Débit PAR CAMPAGNE : le rate posé sur la campagne prime ; à défaut, le défaut serveur (deps, absent en test
  // -> opt-out préservé). Un rate résolu > 0 instancie un RateLimiter dédié à CE run (intervalle minimal =
  // 60000/rate ms), prioritaire sur un éventuel limiteur statique. 1 job = 1 campagne, donc l'instance est
  // naturellement par-campagne. Le throttle attend AVANT de claimer le destinataire suivant : aucun destinataire
  // ne reste 'sending' plus longtemps qu'une latence d'envoi (le sweeper reclaim ne le voit pas).
  const rate = resolveRatePerMinute(campaign.ratePerMinute, deps.defaultRatePerMinute ?? 0);
  const makeLimiter = deps.makeRateLimiter ?? ((ms: number) => new RateLimiter(ms));
  const rateLimiter: RateGate | undefined =
    rate > 0 ? makeLimiter(Math.ceil(60_000 / rate)) : deps.rateLimiter;

  // Résolution du sender (token PAR TENANT). Un token révoqué/expiré -> TokenInvalidError : on met la campagne en
  // PAUSE proprement (rapport paused + raison) au lieu de laisser le throw remonter, ce qui ferait rejouer le job
  // en boucle par pg-boss. Miroir de la garde d'appartenance du numéro ci-dessus.
  let sender: MessageSender;
  try {
    sender = await deps.senderFor(campaign);
  } catch (err) {
    if (err instanceof TokenInvalidError) {
      return { sent: 0, skipped: 0, failed: 0, paused: true, reason: 'token WhatsApp révoqué/expiré, reconnectez le numéro' };
    }
    throw err;
  }

  return runCampaign(campaign, {
    sender,
    recipients: deps.recipients,
    campaigns: deps.campaigns,
    frequency: deps.frequency,
    quality: deps.quality,
    ...(rateLimiter ? { rateLimiter } : {}),
    ...(deps.startWorkflow ? { startWorkflow: deps.startWorkflow } : {}),
    ...(deps.startWorkflowFromNode ? { startWorkflowFromNode: deps.startWorkflowFromNode } : {}),
    ...(deps.recordOutbound ? { recordOutbound: deps.recordOutbound } : {}),
    ...(deps.thresholds ? { thresholds: deps.thresholds } : {}),
  });
}
