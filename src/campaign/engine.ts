import type { Campaign, Recipient, RunReport, GuardrailThresholds, QualityRating } from './types';
import { frequencyAllows, qualityGate, buildComponents } from './guardrails';
import { messagingTarget } from '../meta/types';
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
  /**
   * Campagne WORKFLOW : démarre le workflow pour un destinataire (au lieu d'envoyer un template).
   * `firstTemplateParams` = variables du 1er template DÉJÀ résolues par contact (buildRecipients à partir du
   * paramMapping de la campagne) -> l'executor les passe telles quelles au 1er envoi (pas de re-résolution).
   */
  startWorkflow?: (tenantId: string, workflowId: string, waId: string, contactId: string, firstTemplateParams: string[]) => Promise<void>;
  /**
   * Campagne NODE (/v1/sends, D-1) : démarre le workflow à un bloc PRÉCIS. Pas de `firstTemplateParams` (la
   * cible node n'est pas une ouverture de template paramétrée) et pas de garde fenêtre 24 h dans l'executor :
   * la fenêtre a été vérifiée destinataire par destinataire à la création de l'envoi.
   */
  startWorkflowFromNode?: (tenantId: string, workflowId: string, startNodeId: string, waId: string, contactId: string) => Promise<void>;
  /** Journalise l'envoi sortant dans le fil de conversation (best-effort). Absent -> pas de log (rétro-compatible). */
  recordOutbound?: (
    tenantId: string,
    waId: string,
    msg: { body: string; messageId: string | null; type?: string; templateCategory?: string | null; templateName?: string | null },
  ) => Promise<void>;
  now?: () => number;
  thresholds?: GuardrailThresholds;
}

const DEFAULT_THRESHOLDS: GuardrailThresholds = {
  // Cap anti-répétition marketing DÉSACTIVÉ par défaut (pilote, décision 2026-07-15) : l'opérateur choisit
  // explicitement ses destinataires -> un plafond 24h silencieux laissait des contacts « en attente » sans
  // explication (cf. bug campagne workflow). 0 = désactivé (court-circuité). Mettre >0 (ex. 24*3600*1000) le réactive.
  frequencyWindowMs: 0,
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

    // Fréquence : garde-fou MARKETING uniquement, et seulement si une fenêtre > 0 est configurée (désactivé par
    // défaut, cf. DEFAULT_THRESHOLDS). Fenêtre 0 -> court-circuit : aucune requête, aucun saut, l'envoi part.
    // Les messages utility relèvent de la fenêtre de service et ne sont jamais soumis à ce plafond.
    if (campaign.category === 'marketing' && t.frequencyWindowMs > 0) {
      const last = await deps.frequency.lastSentAt(campaign.tenantId, r.toE164);
      if (!frequencyAllows(last, now(), t.frequencyWindowMs)) {
        report.skipped += 1;
        continue; // transitoire : reste `pending`, ré-évalué au prochain run
      }
    }

    // Claim atomique : si un autre run/worker a déjà pris ce destinataire, on passe.
    if (!(await deps.recipients.claim(r.id))) continue;

    if (deps.rateLimiter) await deps.rateLimiter.acquire();

    // Envoi isolé : SEULE une erreur du sender (Meta) marque le destinataire `failed`.
    let res: SendResult;
    try {
      if (campaign.workflowId && campaign.startNodeId) {
        // Campagne NODE (/v1/sends) : on démarre le workflow à un BLOC PRÉCIS. Les destinataires hors fenêtre
        // 24 h ont déjà été écartés (`out_of_window`) à la création, donc l'envoi de session est légitime ici.
        if (!deps.startWorkflowFromNode) throw new Error('startWorkflowFromNode non câblé');
        const waId = r.toE164.startsWith('+') ? r.toE164.replace(/[^0-9]/g, '') : r.toE164;
        await deps.startWorkflowFromNode(campaign.tenantId, campaign.workflowId, campaign.startNodeId, waId, r.contactId);
        res = { messageId: `wf-${campaign.workflowId}` };
      } else if (campaign.workflowId) {
        // Campagne WORKFLOW : on DÉMARRE le workflow pour ce destinataire (il applique les blocs sync +
        // envoie son 1er template). message_id synthétique (le wamid réel vit dans le run du workflow).
        // wa_id du run = numéro en chiffres nus (comme le webhook) OU BSUID tel quel (jamais dénaturé).
        if (!deps.startWorkflow) throw new Error('startWorkflow non câblé');
        const waId = r.toE164.startsWith('+') ? r.toE164.replace(/[^0-9]/g, '') : r.toE164;
        // r.resolvedParams = variables du 1er template résolues à la construction (paramMapping de la campagne).
        // On les passe telles quelles : l'envoi du 1er template n'a PAS à re-résoudre via les hints stockés.
        await deps.startWorkflow(campaign.tenantId, campaign.workflowId, waId, r.contactId, r.resolvedParams);
        res = { messageId: `wf-${campaign.workflowId}` };
      } else {
        const tpl: TemplateSpec = {
          name: campaign.templateName,
          language: campaign.templateLanguage,
          components: buildComponents(r.resolvedParams),
        };
        // Numéro E.164 -> `to`, BSUID -> `recipient` (source unique messagingTarget). sendTemplate route
        // de la même façon en interne, donc l'utility passe l'identité brute.
        res =
          campaign.category === 'marketing'
            ? await deps.sender.sendMarketing({ ...messagingTarget(r.toE164), template: tpl })
            : await deps.sender.sendTemplate(r.toE164, tpl);
      }
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

    // Journalise le template envoyé dans le fil de conversation (fil d'inbox complet + transcript d'analyse).
    // UNIQUEMENT pour un envoi template DIRECT : la branche workflow a un messageId synthétique `wf-...`, le vrai
    // template est loggé par le worker à l'envoi réel. Best-effort : un échec de log ne relabellise pas l'envoi.
    if (deps.recordOutbound && !campaign.workflowId) {
      const waId = r.toE164.startsWith('+') ? r.toE164.replace(/[^0-9]/g, '') : r.toE164;
      const body = `Template « ${campaign.templateName} »${r.resolvedParams.length > 0 ? ` (${r.resolvedParams.join(', ')})` : ''}`;
      try {
        await deps.recordOutbound(campaign.tenantId, waId, {
          body,
          messageId: res.messageId,
          type: 'template',
          templateCategory: campaign.category,
          templateName: campaign.templateName,
        });
      } catch {
        /* log best-effort : ne casse jamais l'envoi Meta réussi */
      }
    }
  }

  await deps.campaigns.setStatus(campaign.id, 'completed');
  return report;
}
