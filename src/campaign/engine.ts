import type { Campaign, Recipient, RunReport, GuardrailThresholds, QualityRating } from './types';
import { frequencyAllows, qualityGate, buildComponents } from './guardrails';
import type { SendResult, TemplateSpec, MarketingParams } from '../meta/types';
import { MetaApiError } from '../meta/errors';

/** Satisfait par MetaClient (Loop 2). */
export interface MessageSender {
  sendMarketing(params: MarketingParams): Promise<SendResult>;
  sendTemplate(to: string, tpl: TemplateSpec): Promise<SendResult>;
}

export interface RecipientStore {
  listPending(campaignId: string): Promise<Recipient[]>;
  /**
   * Claim atomique d'un destinataire (pending -> sending). Retourne true si CE run l'a
   * réservé, false si un autre run/worker l'a déjà pris. Garantit qu'un destinataire n'est
   * envoyé qu'une fois malgré runs concurrents et replays pg-boss.
   */
  claim(id: string): Promise<boolean>;
  markResult(
    id: string,
    r: { status: 'sent' | 'failed' | 'skipped'; messageId?: string; error?: string; sentAt?: number; errorCode?: number },
  ): Promise<void>;
}

export interface CampaignStore {
  setStatus(campaignId: string, status: Campaign['status']): Promise<void>;
}

export interface FrequencyStore {
  lastSentAt(tenantId: string, key: string): Promise<number | null>;
  record(tenantId: string, key: string, atMs: number): Promise<void>;
}

export interface QualityProvider {
  getRating(phoneNumberId: string): Promise<QualityRating>;
}

export interface RateGate {
  acquire(): Promise<void>;
}

export interface EngineDeps {
  sender: MessageSender;
  recipients: RecipientStore;
  campaigns: CampaignStore;
  frequency: FrequencyStore;
  quality: QualityProvider;
  rateLimiter?: RateGate;
  now?: () => number;
  thresholds?: GuardrailThresholds;
}

const DEFAULT_THRESHOLDS: GuardrailThresholds = {
  frequencyWindowMs: 24 * 3600 * 1000,
  maxFailureRate: 0.3,
  minSendsForFailureCheck: 20,
};

/**
 * Exécute une campagne : parcourt les destinataires `pending` avec pacing + garde-fous
 * (quality gate, fréquence marketing), et pour chaque destinataire éligible le CLAIM
 * atomiquement (pending -> sending) AVANT l'appel Meta, puis envoie et enregistre le
 * résultat. Le claim garantit qu'un destinataire n'est envoyé qu'une fois même en cas de
 * runs concurrents ou de replay pg-boss (un envoi réussi dont la persistance échoue reste
 * en `sending`, jamais re-listé donc jamais ré-envoyé). Pause et arrête si le quality gate
 * déclenche. Le skip de fréquence est TRANSITOIRE : non persisté, le destinataire reste
 * `pending` et sera ré-évalué au prochain run (fenêtre expirée -> envoyé).
 */
export async function runCampaign(campaign: Campaign, deps: EngineDeps): Promise<RunReport> {
  const now = deps.now ?? (() => Date.now());
  const t = deps.thresholds ?? DEFAULT_THRESHOLDS;
  const report: RunReport = { sent: 0, skipped: 0, failed: 0, paused: false };

  await deps.campaigns.setStatus(campaign.id, 'running');
  const pending = await deps.recipients.listPending(campaign.id);

  for (const r of pending) {
    if (r.status === 'sent') continue; // idempotence défensive

    const rating = await deps.quality.getRating(campaign.phoneNumberId);
    const gate = qualityGate({ rating, sent: report.sent, failed: report.failed }, t);
    if (gate.pause) {
      report.paused = true;
      if (gate.reason !== undefined) report.reason = gate.reason;
      await deps.campaigns.setStatus(campaign.id, 'paused');
      return report;
    }

    // Fréquence : garde-fou MARKETING uniquement. Les messages utility relèvent de la
    // fenêtre de service et ne doivent pas être supprimés par un plafond marketing.
    if (campaign.category === 'marketing') {
      const last = await deps.frequency.lastSentAt(campaign.tenantId, r.toE164);
      if (!frequencyAllows(last, now(), t.frequencyWindowMs)) {
        report.skipped += 1;
        continue; // transitoire : reste `pending`, ré-évalué au prochain run
      }
    }

    // Claim atomique : si un autre run/worker a déjà pris ce destinataire, on passe.
    if (!(await deps.recipients.claim(r.id))) continue;

    if (deps.rateLimiter) await deps.rateLimiter.acquire();
    const tpl: TemplateSpec = {
      name: campaign.templateName,
      language: campaign.templateLanguage,
      components: buildComponents(r.resolvedParams),
    };

    // Envoi isolé : SEULE une erreur du sender (Meta) marque le destinataire `failed`.
    let res: SendResult;
    try {
      res =
        campaign.category === 'marketing'
          ? await deps.sender.sendMarketing({ to: r.toE164, template: tpl })
          : await deps.sender.sendTemplate(r.toE164, tpl);
    } catch (err) {
      const msg = err instanceof MetaApiError ? `${err.code ?? ''} ${err.message}`.trim() : String(err);
      const errorCode = err instanceof MetaApiError && typeof err.code === 'number' ? err.code : undefined;
      await deps.recipients.markResult(r.id, { status: 'failed', error: msg, ...(errorCode !== undefined ? { errorCode } : {}) });
      report.failed += 1;
      continue;
    }

    // Message livré. On persiste le succès HORS du catch d'envoi : une erreur de
    // persistance ne relabellise pas un message livré en `failed` (ça fausserait le
    // dénominateur du quality gate). Le destinataire est déjà en `sending` (claimé), donc
    // même si markResult échoue et que le job est rejoué, il ne sera pas ré-envoyé.
    const at = now();
    report.sent += 1;
    await deps.recipients.markResult(r.id, { status: 'sent', messageId: res.messageId, sentAt: at });
    await deps.frequency.record(campaign.tenantId, r.toE164, at);
  }

  await deps.campaigns.setStatus(campaign.id, 'completed');
  return report;
}
