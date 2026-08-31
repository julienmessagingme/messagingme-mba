import type { Campaign, CampaignStatus, Recipient, RunReport, GuardrailThresholds, QualityRating } from './types';
import { frequencyAllows, qualityGate } from './guardrails';
import { buildTemplateComponents, carouselSendBlocker, headerMediaSendBlocker } from '../meta/template-components';
import type { OutboundCarouselCard } from '../meta/template-components';
import { refreshNowParams } from '../crm/template';
import { messagingTarget } from '../meta/types';
import type { SendResult, TemplateSpec, MarketingParams } from '../meta/types';
import { MetaApiError, estPlafondNumero } from '../meta/errors';
import type { CampaignSender } from './sender';
import { waIdOfTarget } from '../crm/identity';

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
  /**
   * Rend un destinataire réservé à la file (`sending` -> `pending`), l'inverse exact de `claim`. Un seul
   * appelant : le plafond de numéro, où le contact n'a rien fait de mal et où aucun message n'est parti.
   */
  relacher(id: string): Promise<void>;
  markResult(
    id: string,
    r: { status: 'sent' | 'failed' | 'skipped'; messageId?: string; error?: string; sentAt?: number; errorCode?: number },
  ): Promise<void>;
}

export interface CampaignStore {
  setStatus(campaignId: string, status: Campaign['status']): Promise<void>;
  /**
   * Relit le statut COURANT de la campagne en base, pour que le run puisse s'arrêter quand un opérateur la met
   * en pause pendant l'envoi. Scopé tenant comme toute lecture (le pooler est superuser, la RLS ne joue pas).
   * `null` = campagne introuvable, traité comme « rien à décider », le run continue.
   *
   * OPTIONNEL : absent, le run va jusqu'au bout comme avant. Les fixtures de test et l'e2e n'ont donc rien à
   * câbler ; la production l'injecte, sans quoi la pause serait un bouton sans effet.
   */
  getStatus?(campaignId: string, tenantId: string): Promise<CampaignStatus | null>;
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
  /**
   * L'arrêt a-t-il été demandé (SIGTERM) ? Lu à CHAQUE destinataire : c'est une lecture en mémoire, elle ne
   * coûte rien, et un run qui s'arrête vite est un déploiement qui ne gèle rien.
   *
   * 🔴 En sortant par là, on NE TOUCHE PAS au statut : la campagne reste `running` avec ses destinataires en
   * attente, et le balayage de reprise la relance au redémarrage. La marquer `paused` demanderait un geste
   * humain pour repartir, alors que personne n'a rien décidé : c'est un déploiement, pas une décision.
   */
  arretDemande?: () => boolean;
  /**
   * Durée maximale d'un run avant qu'il rende la main (lot 5). Au-delà, le run s'arrête ENTRE deux
   * destinataires, rend `reste: true`, et l'appelant le réenfile. La campagne reste `running` : personne n'a
   * rien décidé, c'est un découpage du travail, pas une pause.
   *
   * Une DURÉE et non un nombre de destinataires : à 1/min un lot de 100 durerait plus d'une heure, à 80/min
   * il durerait une minute. C'est le temps d'occupation de la file qu'on veut borner, pas le compte.
   *
   * Absente OU <= 0 -> aucun découpage, comportement d'avant (fixtures de test, e2e). Les deux formes
   * disent la même chose, et `0` est celle qu'on écrit dans l'environnement pour retirer le découpage.
   */
  dureeMaxMs?: number;
  /**
   * Repousse l'échéance du bail du verrou d'exécution. `false` = on ne le tient plus, il faut s'arrêter.
   *
   * Appelé à la même cadence que la relecture de statut. Sans ce renouvellement, le bail devrait couvrir la
   * durée entière du run (des heures), et un worker tué bloquerait la reprise pendant tout ce temps.
   */
  renouvelerVerrou?: () => Promise<boolean>;
  /**
   * Écart minimal entre deux relectures du statut de la campagne (ms). Le contrôle est cadencé par le TEMPS et
   * non par le nombre de destinataires traités : une campagne à 1 message/minute mettrait sinon des heures à
   * voir la pause, alors qu'un opérateur qui coupe un mauvais ciblage veut que ça s'arrête tout de suite. Ainsi
   * le délai de réaction est le même pour toutes (quelques secondes) et le coût est borné, quel que soit le débit.
   */
  statusPollMs?: number;
}

/** Défaut du pas de relecture du statut : au pire une requête indexée toutes les 5 s par run en cours. */
const DEFAULT_STATUS_POLL_MS = 5_000;


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
 *
 * ARRÊT DEMANDÉ PENDANT L'ENVOI : la boucle relit périodiquement le statut de la campagne et sort dès qu'il
 * n'est plus `running`. C'est ce qui rend la pause réelle : sans cette relecture, écrire `paused` en base
 * n'arrêtait rien et une erreur de ciblage sur 5 000 destinataires partait jusqu'au bout. Les destinataires
 * non traités restent `pending`, donc « Reprendre » repart exactement là où on s'est arrêté.
 */
export async function runCampaign(campaign: Campaign, deps: EngineDeps): Promise<RunReport> {
  const now = deps.now ?? (() => Date.now());
  const t = deps.thresholds ?? DEFAULT_THRESHOLDS;
  const report: RunReport = { sent: 0, skipped: 0, failed: 0, paused: false };

  await deps.campaigns.setStatus(campaign.id, 'running');
  const pending = await deps.recipients.listPending(campaign.id);

  // Statut de SORTIE du run. Une campagne AU FIL DE L'EAU (alimentée par un webhook) n'est pas finie quand sa
  // file est vide : elle attend son prochain arrivant. La marquer `completed` la couperait définitivement de
  // son webhook (seules les campagnes `running` sont nourries), et personne ne le verrait avant de constater
  // que plus aucun lead n'est contacté. Elle repart donc en `running`.
  const statutFinal: CampaignStatus = campaign.webhookId ? 'running' : 'completed';

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
    await deps.campaigns.setStatus(campaign.id, statutFinal);
    return report;
  }

  // Horloge du contrôle d'arrêt. Partie à MAINTENANT, donc la première relecture n'a lieu qu'un pas plus tard :
  // on vient d'écrire `running` deux lignes plus haut, relire tout de suite ne pourrait rien apprendre.
  const pasDeControle = deps.statusPollMs ?? DEFAULT_STATUS_POLL_MS;
  let dernierControle = now();
  // Horloge du LOT : un run travaille au plus `dureeMaxMs`, puis rend la main et se fait réenfiler.
  const debutDuLot = now();

  for (const r of pending) {
    if (r.status === 'sent') continue; // idempotence défensive

    // 🔴 DURÉE MAXIMALE DU LOT (lot 5). Sans elle, un job traitait sa campagne jusqu'à épuisement : 5 000
    // destinataires à 30/min, c'est 2 h 47 pendant lesquelles la file `campaign-run` ne sert PERSONNE
    // d'autre. On s'arrête donc entre deux destinataires, exactement comme pour l'arrêt du service : rien
    // n'est réservé, rien n'est envoyé, le suivant reste `pending`.
    //
    // ⚠️ Le test est placé APRÈS le premier tour de boucle par construction (il compare à `debutDuLot`), et
    // surtout la sortie n'est prise QUE si du travail a déjà été fait (`report.sent + report.failed +
    // report.skipped > 0`). Sans cette condition, une durée mal réglée ferait un run qui n'envoie rien et se
    // réenfile en boucle, c'est-à-dire une file qui tourne à vide pour l'éternité.
    const traites = report.sent + report.failed + report.skipped;
    if (deps.dureeMaxMs !== undefined && deps.dureeMaxMs > 0 && traites > 0 && now() - debutDuLot >= deps.dureeMaxMs) {
      report.reste = true;
      return report;
    }

    // ARRÊT DU PROCESS (SIGTERM). Testé à chaque tour, avant toute réservation : le destinataire suivant
    // n'est ni claimé ni envoyé, et il reste `pending` pour la reprise. Le statut n'est PAS réécrit.
    if (deps.arretDemande?.()) {
      report.paused = true;
      report.reason = 'arrêt du service pendant l’envoi ; la campagne reprendra au redémarrage';
      return report;
    }

    // ARRÊT DEMANDÉ ? Contrôlé AVANT le claim et avant toute attente de cadence : un destinataire vu après la
    // pause ne doit être ni réservé ni envoyé. On NE réécrit PAS le statut en sortant : l'état voulu est déjà
    // en base, c'est l'opérateur qui l'y a mis, et le réécrire écraserait sa décision.
    // Appel de MÉTHODE, jamais une référence déliée (`const f = deps.campaigns.getStatus`) : `PgCampaignStore`
    // lit `this.pool`, et une fonction détachée de son objet perdrait son `this`.
    if (deps.campaigns.getStatus && now() - dernierControle >= pasDeControle) {
      dernierControle = now();
      // Le bail se renouvelle à la MÊME cadence, et un renouvellement refusé arrête le run : on ne tient plus
      // le verrou, donc un autre run peut déjà avoir démarré, et continuer doublerait le débit.
      if (deps.renouvelerVerrou && !(await deps.renouvelerVerrou())) {
        report.paused = true;
        report.reason = 'verrou d’exécution perdu (bail écoulé) ; un autre run a repris la campagne';
        return report;
      }
      const courant = await deps.campaigns.getStatus(campaign.id, campaign.tenantId);
      if (courant !== null && courant !== 'running') {
        report.paused = true;
        report.reason = courant === 'paused' ? 'campagne mise en pause pendant l\'envoi' : `campagne passée en « ${courant} » pendant l'envoi`;
        return report;
      }
    }

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
        const waId = waIdOfTarget(r.toE164);
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
        const waId = waIdOfTarget(r.toE164);
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

      // 🔴 PLAFOND DU NUMÉRO : le refus de Meta ne vise pas CE contact, il vise le numéro émetteur. Le compter
      // en échec serait deux fois faux : il n'a rien fait, et il deviendrait injoignable sans intervention
      // (un destinataire `failed` n'est pas repris par un relancement). Surtout, le suivant échouerait pour
      // exactement la même raison, et le suivant encore : sans cette branche, une limite TEMPORAIRE brûlait
      // toute l'audience restante de la campagne. On rend donc le destinataire à la file et on s'arrête.
      //
      // La pause est le bon geste, et pas seulement l'arrêt du run : elle empêche le balayage de reprise de
      // relancer la campagne dans la minute, contre un plafond qui n'est pas encore retombé.
      if (estPlafondNumero(err)) {
        await deps.recipients.relacher(r.id);
        report.paused = true;
        report.reason = `plafond Meta atteint sur le numéro (${errorCode}) : campagne mise en pause, aucun destinataire perdu`;
        await deps.campaigns.setStatus(campaign.id, 'paused');
        return report;
      }

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
      const waId = waIdOfTarget(r.toE164);
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

  await deps.campaigns.setStatus(campaign.id, statutFinal);
  return report;
}
