import { runCampaign } from './engine';
import type {
  MessageSender,
  RecipientStore,
  CampaignStore,
  FrequencyStore,
  QualityProvider,
  RateGate,
  EngineDeps,
} from './engine';
import { RateLimiter } from '../meta/http';
import { resolveRatePerMinute } from './pacing';
import { TokenInvalidError } from '../meta/credentials';
import type { OutboundCarouselCard } from '../meta/template-components';
import type { Campaign, GuardrailThresholds, RunReport } from './types';
import type { CampaignSender } from './sender';

export interface RunJobDeps extends Pick<
  EngineDeps,
  'startWorkflow' | 'startWorkflowFromNode' | 'getTemplateCarousel' | 'getTemplateHeaderMedia' | 'recordOutbound' | 'thresholds'
> {
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
  /**
   * Sender du canal RCS pour CETTE campagne. `null` = aucun agent RCS exploitable (agent absent du tenant,
   * message manquant) -> campagne mise en PAUSE avec la raison, jamais un envoi à vide. ABSENT des deps =
   * canal RCS non câblé sur ce serveur : une campagne RCS est mise en pause au lieu de repartir en silence
   * sur le chemin WhatsApp, qui l'enverrait depuis un `phone_number_id` vide.
   */
  rcsSenderFor?: (campaign: Campaign) => Promise<CampaignSender | null>;
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
  // Canal RCS : il n'y a pas de numéro Meta à revalider (`phone_number_id` est vide), et l'interroger
  // répondrait toujours « non » -> campagne mise en pause avec une raison fausse.
  const isRcs = campaign.channel === 'rcs';
  if (!isRcs && deps.phoneNumberBelongsToTenant && !(await deps.phoneNumberBelongsToTenant(campaign.phoneNumberId, campaign.tenantId))) {
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
  // Canal RCS : on ne résout AUCUN token Meta (il n'y en a pas), on construit le sender de canal. Absent ou
  // sans agent exploitable -> PAUSE avec la raison, jamais un run qui repart sur le chemin WhatsApp.
  let channelSender: CampaignSender | undefined;
  if (isRcs) {
    if (!deps.rcsSenderFor) {
      return { sent: 0, skipped: 0, failed: 0, paused: true, reason: 'canal RCS non câblé sur ce serveur' };
    }
    const cs = await deps.rcsSenderFor(campaign);
    if (!cs) {
      return { sent: 0, skipped: 0, failed: 0, paused: true, reason: 'aucun agent RCS exploitable pour cette campagne' };
    }
    channelSender = cs;
  }

  let sender: MessageSender;
  if (isRcs) {
    // `EngineDeps.sender` est requis par le type, mais le moteur branche sur `channelSender` AVANT de
    // l'utiliser. Ce garde rend l'invariant explicite : s'il est un jour appelé, c'est un bug de branchement,
    // et on veut le voir immédiatement plutôt qu'un envoi Meta parti d'une campagne RCS.
    const interdit = async (): Promise<never> => {
      throw new Error('campagne RCS : le sender Meta ne doit jamais être appelé');
    };
    sender = { sendMarketing: interdit, sendTemplate: interdit };
  } else {
    try {
      sender = await deps.senderFor(campaign);
    } catch (err) {
      if (err instanceof TokenInvalidError) {
        return { sent: 0, skipped: 0, failed: 0, paused: true, reason: 'token WhatsApp révoqué/expiré, reconnectez le numéro' };
      }
      throw err;
    }
  }

  return runCampaign(campaign, {
    sender,
    ...(channelSender ? { channelSender } : {}),
    recipients: deps.recipients,
    campaigns: deps.campaigns,
    frequency: deps.frequency,
    quality: deps.quality,
    ...(rateLimiter ? { rateLimiter } : {}),
    ...(deps.startWorkflow ? { startWorkflow: deps.startWorkflow } : {}),
    ...(deps.startWorkflowFromNode ? { startWorkflowFromNode: deps.startWorkflowFromNode } : {}),
    ...(deps.getTemplateCarousel ? { getTemplateCarousel: deps.getTemplateCarousel } : {}),
    ...(deps.getTemplateHeaderMedia ? { getTemplateHeaderMedia: deps.getTemplateHeaderMedia } : {}),
    ...(deps.recordOutbound ? { recordOutbound: deps.recordOutbound } : {}),
    ...(deps.thresholds ? { thresholds: deps.thresholds } : {}),
  });
}
