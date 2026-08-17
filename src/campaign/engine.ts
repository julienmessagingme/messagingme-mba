import type { Campaign, Recipient, RunReport, GuardrailThresholds, QualityRating } from './types';
import { frequencyAllows, qualityGate } from './guardrails';
import { buildTemplateComponents, carouselSendBlocker, headerMediaSendBlocker } from '../meta/template-components';
import type { OutboundCarouselCard } from '../meta/template-components';
import { refreshNowParams } from '../crm/template';
import { messagingTarget } from '../meta/types';
import type { SendResult, TemplateSpec, MarketingParams } from '../meta/types';
import { MetaApiError } from '../meta/errors';
import type { CampaignSender } from './sender';

/** Satisfait par MetaClient (Loop 2). */
/**
 * Texte journalisé dans le fil pour un envoi de campagne RCS. Le message est relu de la base (jsonb validé à
 * la création) : on ne suppose pas sa forme, une forme inattendue donne un libellé neutre plutôt qu'un crash
 * ou un « undefined » affiché à l'opérateur.
 */
function rcsCampaignBody(message: unknown): string {
  if (message && typeof message === 'object' && (message as { kind?: unknown }).kind === 'text') {
    const texte = (message as { text?: unknown }).text;
    if (typeof texte === 'string' && texte.trim() !== '') return texte;
  }
  return 'Message RCS';
}

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
   * Sender de CANAL (RCS). Présent : le moteur envoie par LUI, et les gardes propres à WhatsApp sont
   * neutralisées (quality rating Meta, lecture du carousel et de l'en-tête média du template) parce
   * qu'elles n'ont pas d'équivalent sur ce canal et qu'aucun numéro Meta n'existe pour l'interroger.
   * Absent : comportement historique INCHANGÉ, ce qui garantit la non-régression des campagnes WhatsApp.
   */
  channelSender?: CampaignSender;
  /**
   * Campagne WORKFLOW : démarre le workflow pour un destinataire (au lieu d'envoyer un template).
   * `firstTemplateParams` = variables du 1er template DÉJÀ résolues par contact (buildRecipients à partir du
   * paramMapping de la campagne) -> l'executor les passe telles quelles au 1er envoi (pas de re-résolution).
   *
   * Renvoie `false` quand le run n'a PAS démarré (scénario supprimé, fil détenu par un humain/MBA, ouverture
   * hors fenêtre) : le destinataire est alors marqué en ÉCHEC, jamais compté comme envoyé. `void` toléré pour
   * les câblages qui ne savent pas le dire (traité comme un démarrage réussi, comportement historique).
   */
  startWorkflow?: (tenantId: string, workflowId: string, waId: string, contactId: string, firstTemplateParams: string[]) => Promise<void | boolean | string>;
  /**
   * Campagne NODE (/v1/sends, D-1) : démarre le workflow à un bloc PRÉCIS. Pas de `firstTemplateParams` (la
   * cible node n'est pas une ouverture de template paramétrée) et pas de garde fenêtre 24 h dans l'executor :
   * la fenêtre a été vérifiée destinataire par destinataire à la création de l'envoi.
   */
  startWorkflowFromNode?: (tenantId: string, workflowId: string, startNodeId: string, waId: string, contactId: string) => Promise<void | boolean | string>;
  /**
   * Cartes du CAROUSEL du template de la campagne, relues chez Meta. Appelée UNE SEULE FOIS par run (la
   * structure est identique pour tous les destinataires : un appel par contact tuerait une campagne à
   * 5 000 destinataires). null = template sans carousel -> envoi inchangé. Absente = câblage sans lecture
   * de template (tests, e2e) -> envoi inchangé lui aussi.
   */
  getTemplateCarousel?: (tenantId: string, name: string, language: string) => Promise<{ cards: OutboundCarouselCard[] } | null>;
  /**
   * En-tête média du template, PRÉPARÉ pour l'envoi (`mediaId` obtenu en re-téléversant le visuel lu chez Meta).
   * Appelée UNE SEULE FOIS par run, même raison que le carousel. Meta exige ce média à CHAQUE envoi d'un
   * template à en-tête IMAGE/VIDEO/DOCUMENT : sans lui il refuse TOUS les destinataires en 132012, ce qui est
   * arrivé en production le 2026-08-17. null = template sans en-tête média -> envoi inchangé. Absente = câblage
   * sans lecture de template (tests, e2e, DRY_RUN) -> envoi inchangé lui aussi.
   */
  getTemplateHeaderMedia?: (
    tenantId: string,
    name: string,
    language: string,
  ) => Promise<{ headerFormat: 'IMAGE' | 'VIDEO' | 'DOCUMENT'; mediaId: string | null } | null>;
  /** Journalise l'envoi sortant dans le fil de conversation (best-effort). Absent -> pas de log (rétro-compatible). */
  recordOutbound?: (
    tenantId: string,
    waId: string,
    msg: { body: string; messageId: string | null; type?: string; templateCategory?: string | null; templateName?: string | null; channel?: 'whatsapp' | 'rcs' },
  ) => Promise<void>;
  now?: () => number;
  thresholds?: GuardrailThresholds;
}

/** wa_id d'un destinataire : numéro en chiffres nus, BSUID tel quel. Règle unique, partagée avec le webhook
 *  et le store d'inbox : la dériver deux fois différemment créerait deux conversations pour un contact. */
function waIdOf(toE164: string): string {
  return toE164.startsWith('+') ? toE164.replace(/[^0-9]/g, '') : toE164;
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

  // Carousel : les cartes (image, corps, boutons) sont IDENTIQUES pour tous les destinataires -> relues une
  // seule fois par run. Une lecture qui échoue (réseau, WABA absent) ne casse pas la campagne : on part comme
  // avant (un template sans carousel est inchangé ; un carousel échouera avec le message d'erreur de Meta).
  let carousel: { cards: OutboundCarouselCard[] } | null = null;
  let carouselBlocked: string | null = null;
  if (!campaign.workflowId && !deps.channelSender && deps.getTemplateCarousel) {
    try {
      const read = await deps.getTemplateCarousel(campaign.tenantId, campaign.templateName, campaign.templateLanguage);
      if (read) {
        carouselBlocked = carouselSendBlocker(read.cards);
        if (carouselBlocked === null) carousel = read;
      }
    } catch {
      /* lecture best-effort : jamais bloquante pour un template sans carousel */
    }
  }

  // En-tête média : même doctrine que le carousel, et même lecture UNE fois par run. Le visuel est identique
  // pour tous les destinataires, donc son `media id` aussi.
  let headerMedia: { headerFormat: 'IMAGE' | 'VIDEO' | 'DOCUMENT'; mediaId: string | null } | null = null;
  let headerBlocked: string | null = null;
  if (!campaign.workflowId && !deps.channelSender && !carousel && deps.getTemplateHeaderMedia) {
    try {
      headerMedia = await deps.getTemplateHeaderMedia(campaign.tenantId, campaign.templateName, campaign.templateLanguage);
      if (headerMedia) headerBlocked = headerMediaSendBlocker(headerMedia.headerFormat, headerMedia.mediaId ?? undefined);
    } catch {
      /* lecture best-effort : un template sans en-tête média ne doit jamais être bloqué par elle */
    }
  }

  // Rien d'envoyable : AUCUN destinataire ne peut partir, et on le sait avant d'avoir commencé. Traité
  // ICI et pas dans la boucle : y passer ferait compter 100 % d'échecs au quality gate, qui mettrait la
  // campagne en pause avec « taux d'échec 100 % » au bout de 20 destinataires. Ce serait exactement le
  // diagnostic trompeur que ce lot supprime, et ça laisserait le reste des destinataires en attente.
  if (carouselBlocked !== null || headerBlocked !== null) {
    const reason = carouselBlocked !== null ? `Carousel non envoyable : ${carouselBlocked}` : `Template non envoyable : ${headerBlocked}`;
    for (const r of pending) {
      if (r.status === 'sent') continue;
      if (!(await deps.recipients.claim(r.id))) continue;
      await deps.recipients.markResult(r.id, { status: 'failed', error: reason });
      report.failed += 1;
    }
    await deps.campaigns.setStatus(campaign.id, 'completed');
    return report;
  }

  for (const r of pending) {
    if (r.status === 'sent') continue; // idempotence défensive

    // Quality gate : notion META (rating du numéro WABA). Sur un canal sans numéro Meta, il n'y a rien à
    // interroger, et l'interroger quand même appellerait Graph avec un phoneNumberId vide.
    if (!deps.channelSender) {
      const rating = await deps.quality.getRating(campaign.phoneNumberId);
      const gate = qualityGate({ rating, sent: report.sent, failed: report.failed }, t);
      if (gate.pause) {
        report.paused = true;
        if (gate.reason !== undefined) report.reason = gate.reason;
        await deps.campaigns.setStatus(campaign.id, 'paused');
        return report;
      }
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

    // Variables du template : les positions de source NOW sont rafraîchies à l'instant de l'ENVOI (les autres
    // ont été résolues à la création). Sans ça, une campagne programmée/draft enverrait la date de sa CRÉATION.
    // Fuseau par défaut (Europe/Paris), cf. DEFAULT_NOW_TZ.
    const params = refreshNowParams(r.resolvedParams, campaign.paramMapping, { now: new Date(now()) });

    // Envoi isolé : une erreur du sender (Meta) marque le destinataire `failed`. Un run de workflow qui NE
    // DÉMARRE PAS aussi (`started === false`) : sans ça, la campagne affichait « envoyé » pour un destinataire
    // dont aucun message n'est parti (scénario supprimé, fil repris par un opérateur, ouverture hors fenêtre).
    let res: SendResult;
    let notStarted: string | null = null;
    // Destinataire écarté par le canal lui-même (non joignable en RCS, opt-out). Ce n'est PAS un échec :
    // rien n'est parti et rien n'a raté. Symétrique de `notStarted`, traité après le try comme lui.
    let skipped: string | null = null;
    try {
      if (deps.channelSender) {
        const out = await deps.channelSender.sendTo(r);
        if ('skipped' in out) {
          skipped = out.skipped;
          res = { messageId: '' };
        } else {
          res = out;
        }
      } else if (campaign.workflowId && campaign.startNodeId) {
        // Campagne NODE (/v1/sends) : on démarre le workflow à un BLOC PRÉCIS. Les destinataires hors fenêtre
        // 24 h ont déjà été écartés (`out_of_window`) à la création, donc l'envoi de session est légitime ici.
        if (!deps.startWorkflowFromNode) throw new Error('startWorkflowFromNode non câblé');
        const waId = waIdOf(r.toE164);
        const started = await deps.startWorkflowFromNode(campaign.tenantId, campaign.workflowId, campaign.startNodeId, waId, r.contactId);
        // Une CHAÎNE porte la raison exacte du refus : on l'affiche telle quelle plutôt que d'énumérer les
        // causes possibles et de laisser l'opérateur deviner laquelle s'applique.
        if (typeof started === 'string') notStarted = `Scénario non démarré : ${started}`;
        else if (started === false) notStarted = 'scénario non démarré (bloc de départ indisponible, ou fil repris par un opérateur / MBA)';
        res = { messageId: `wf-${campaign.workflowId}` };
      } else if (campaign.workflowId) {
        // Campagne WORKFLOW : on DÉMARRE le workflow pour ce destinataire (il applique les blocs sync +
        // envoie son 1er template). message_id synthétique (le wamid réel vit dans le run du workflow).
        // wa_id du run = numéro en chiffres nus (comme le webhook) OU BSUID tel quel (jamais dénaturé).
        if (!deps.startWorkflow) throw new Error('startWorkflow non câblé');
        const waId = waIdOf(r.toE164);
        // r.resolvedParams = variables du 1er template résolues à la construction (paramMapping de la campagne).
        // On les passe telles quelles : l'envoi du 1er template n'a PAS à re-résoudre via les hints stockés.
        const started = await deps.startWorkflow(campaign.tenantId, campaign.workflowId, waId, r.contactId, params);
        if (typeof started === 'string') notStarted = `Scénario non démarré : ${started}`;
        else if (started === false) notStarted = 'scénario non lançable (ouverture hors fenêtre 24 h, scénario supprimé, ou fil repris par un opérateur / MBA)';
        res = { messageId: `wf-${campaign.workflowId}` };
      } else {
        const tpl: TemplateSpec = {
          name: campaign.templateName,
          language: campaign.templateLanguage,
          components: buildTemplateComponents({
            bodyParams: params,
            ...(carousel ? { carousel } : {}),
            // `mediaId` non nul garanti par le refus pré-boucle : `headerMediaSendBlocker` a déjà arrêté le run.
            ...(headerMedia?.mediaId ? { headerMediaId: headerMedia.mediaId, headerFormat: headerMedia.headerFormat } : {}),
          }),
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

    // Le workflow n'a pas démarré : AUCUN message n'est parti pour ce destinataire. On le marque en échec (avec
    // la raison) au lieu de le compter en `sent` : une campagne « 500 envoyés, 0 échec » alors que rien n'est
    // parti est un mensonge affiché, et il masque la vraie cause (fil repris, scénario devenu non lançable).
    if (skipped !== null) {
      await deps.recipients.markResult(r.id, { status: 'skipped', error: skipped });
      report.skipped += 1;
      continue;
    }

    if (notStarted !== null) {
      await deps.recipients.markResult(r.id, { status: 'failed', error: notStarted });
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
    // Le fil est UNIQUE par contact : un envoi RCS s'y journalise comme un template WhatsApp, avec son canal.
    // Sans ça, l'opérateur ouvre le fil d'un client et ne voit AUCUNE trace de ce qui vient de lui être
    // envoyé. Le libellé diffère parce que le RCS n'a pas de template : on journalise le message lui-même.
    if (deps.recordOutbound && !campaign.workflowId) {
      const waId = waIdOf(r.toE164);
      const rcs = deps.channelSender !== undefined;
      const body = rcs
        ? rcsCampaignBody(campaign.rcsMessage)
        : `Template « ${campaign.templateName} »${params.length > 0 ? ` (${params.join(', ')})` : ''}`;
      try {
        await deps.recordOutbound(campaign.tenantId, waId, {
          body,
          messageId: res.messageId,
          type: rcs ? 'rcs' : 'template',
          ...(rcs
            ? { channel: 'rcs' as const }
            : { templateCategory: campaign.category, templateName: campaign.templateName }),
        });
      } catch {
        /* log best-effort : ne casse jamais l'envoi réussi */
      }
    }
  }

  await deps.campaigns.setStatus(campaign.id, 'completed');
  return report;
}
