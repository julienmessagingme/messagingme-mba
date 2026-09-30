import type { Campaign, CampaignStatus, Recipient, RunReport, GuardrailThresholds, QualityRating } from './types';
import { qualityGate, MOTIF_DESABONNE } from './guardrails';
import { buildTemplateComponents, carouselSendBlocker, headerMediaSendBlocker } from '../meta/template-components';
import type { OutboundCarouselCard } from '../meta/template-components';
import { refreshNowParams } from '../crm/template';
import { messagingTarget } from '../meta/types';
import type { OrigineMessage } from '../inbox/origine';
import type { SendResult, TemplateSpec, MarketingParams } from '../meta/types';
import { MetaApiError, raisonDePause } from '../meta/errors';
import { NumeroDelieError } from '../meta/numero-delie';
import { instantDeReprise, messageDePause } from './pause';
import type { MotifDePause } from './pause';
import { withinBusinessHours } from '../workflow/conditions';
import type { BusinessHours } from '../workflow/conditions';
import { prochaineOuverture } from '../lib/heures-ouvrees';
import type { CampaignSender } from './sender';
import { waIdOfTarget } from '../crm/identity';
import { RANG_INITIAL, etageAuRang, type CanalEtage } from './etages';
import { messageDe, texteDe } from '../lib/erreur';

/**
 * Une tentative d'envoi, telle qu'on la journalise. `saute` n'est pas un échec : le destinataire a été écarté
 * avant toute tentative (consentement absent, variable introuvable), le compter gonflerait le taux d'échec du
 * canal. Le contrat vit ici, l'implémentation dans `envois.pg.ts` : le moteur dit ce dont il a besoin.
 */
export interface TentativeEnvoi {
  campaignId: string;
  recipientId: string;
  contactId: string;
  rang: number;
  canal: CanalEtage;
  statut: 'sent' | 'failed' | 'saute';
  messageId?: string;
  errorCode?: number;
  error?: string;
}

/**
 * Texte journalisé dans le fil pour un envoi de campagne RCS. Le message est relu de la base : une forme
 * inattendue donne un libellé neutre plutôt qu'un crash ou un « undefined » affiché.
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

/** Ce que la réclamation d'un destinataire a lu sur sa fiche au moment d'envoyer, et qui interdit l'envoi. */
export type EcartALEnvoi = 'efface' | 'desabonne' | 'bloque';

/**
 * Le motif écrit sur un destinataire écarté à l'envoi. Le STOP reprend le texte du scénario (`MOTIF_DESABONNE`) :
 * l'opérateur lit le même refus d'où qu'il vienne.
 */
export const MOTIF_ECART_A_L_ENVOI: Readonly<Record<EcartALEnvoi, string>> = {
  efface: 'contact effacé (purge RGPD) : plus aucun message ne lui est envoyé',
  desabonne: MOTIF_DESABONNE,
  bloque: 'contact bloqué : plus aucun message ne lui est envoyé',
};

export interface RecipientStore {
  listPending(campaignId: string): Promise<Recipient[]>;
  /**
   * Claim atomique d'un destinataire (pending -> sending). true si ce run l'a réservé, false si un autre l'a
   * déjà pris : un destinataire n'est envoyé qu'une fois malgré les runs concurrents et les rejeux pg-boss.
   *
   * 🔴 `{ ecart }` : réservé, mais il ne doit pas partir. La liste est filtrée à sa construction, or un envoi
   * étalé peut partir bien après un STOP ou une purge : la réclamation relit donc la fiche au moment d'envoyer.
   * Réservé d'abord, pour que le marquer `skipped` ne se fasse qu'une fois.
   */
  claim(id: string): Promise<boolean | { ecart: EcartALEnvoi }>;
  /**
   * Rend un destinataire réservé à la file (`sending` -> `pending`), l'inverse de `claim`, quand le refus vise
   * le numéro et pas le contact (plafond de numéro de Meta, numéro délié).
   */
  relacher(id: string): Promise<void>;
  markResult(
    id: string,
    r: { status: 'sent' | 'failed' | 'skipped'; messageId?: string; error?: string; sentAt?: number; errorCode?: number },
  ): Promise<void>;
  /**
   * Combien de destinataires sont réservés mais pas encore résolus (`sending`) ? Sert à ne pas déclarer une
   * campagne terminée alors qu'un destinataire est en suspens. Absent (faux de test) -> non vérifié.
   */
  countSending?(campaignId: string): Promise<number>;
}

export interface CampaignStore {
  /**
   * `pause` n'est fourni que sur une mise en pause à expliquer, et décide si la campagne repartira seule :
   * `debit` ou `hors_horaires` avec un instant de reprise, `qualite` avec `reprise: null` (jamais
   * automatiquement). Sans lui, l'implémentation efface les deux colonnes : une campagne qui repart ne garde
   * pas l'échéance d'une pause d'avant.
   */
  setStatus(campaignId: string, status: Campaign['status'], pause?: { raison: MotifDePause; reprise: Date | null }): Promise<void>;
  /**
   * 🔴 Relit le statut courant en base, scopé tenant (le pooler est superuser, la RLS ne joue pas), pour que
   * le run s'arrête quand un opérateur met la campagne en pause. `null` = introuvable, le run continue.
   * Optionnel pour les tests ; la production l'injecte, sinon la pause serait sans effet.
   */
  getStatus?(campaignId: string, tenantId: string): Promise<CampaignStatus | null>;
}

export interface QualityProvider {
  getRating(phoneNumberId: string): Promise<QualityRating>;
}

export interface RateGate {
  acquire(): Promise<void>;
}

/** Ce qu'il faut pour servir un canal pendant un run : par qui on envoie, à quelle cadence, depuis quel numéro. */
export interface CanalServi {
  /**
   * Sender de canal (RCS). Absent = canal WhatsApp, servi par `deps.sender`. C'est sa présence, et non le nom
   * du canal, qui neutralise les gardes propres à WhatsApp (porte de qualité, pré-lectures de modèle,
   * joignabilité) : il n'y a alors aucun numéro Meta à interroger.
   */
  sender?: CampaignSender;
  /** Le frein de cadence de ce canal (`plafondDuCanal`). Absent = aucun frein. */
  rateLimiter?: RateGate;
  /**
   * Le numéro Meta qui sert ce canal, pour la porte de qualité (WhatsApp seulement). Pas toujours
   * `campaign.phoneNumberId` : une campagne RCS l'a vide, et `run-job` résout alors le numéro de l'espace
   * pour son repli WhatsApp.
   */
  phoneNumberId?: string;
}

export interface EngineDeps {
  sender: MessageSender;
  recipients: RecipientStore;
  campaigns: CampaignStore;
  quality: QualityProvider;
  /**
   * Ce que ce run sait servir, canal par canal : chaque canal de la chaîne apporte son sender et son frein, et
   * le moteur choisit selon l'étage du destinataire.
   *
   * Un canal absent n'est pas servable et son étage échoue avec sa raison (e-mail, RCS sans agent), plutôt que
   * de retomber sur le canal de la campagne, qui renverrait le message qui vient d'échouer.
   */
  canaux: Partial<Record<CanalEtage, CanalServi>>;
  /**
   * Les index de boutons de ce template qui portent un suffixe variable, donc pour lesquels l'envoi doit fournir
   * un composant `sub_type: 'url'`. Se tromper fait échouer l'envoi dans les deux sens (132000) : la réponse
   * vient d'une colonne écrite à la soumission, jamais d'une déduction.
   */
  boutonsTraces?: (tenantId: string, templateName: string, templateLanguage: string) => Promise<number[]>;
  /** Le jeton public de ces contacts, fabriqué pour ceux qui n'en ont pas, en un seul énoncé pour la campagne. */
  jetonsPourContacts?: (tenantId: string, contactIds: readonly string[]) => Promise<Map<string, string>>;
  /**
   * Campagne scénario : démarre le parcours pour un destinataire au lieu d'envoyer un template.
   * `firstTemplateParams` = variables du premier template déjà résolues par contact, passées telles quelles.
   * `false` (ou une raison en chaîne) = le parcours n'a pas démarré (scénario supprimé, fil détenu par un humain
   * ou MBA, ouverture hors fenêtre) : le destinataire est marqué en échec, jamais compté envoyé.
   */
  startWorkflow?: (tenantId: string, workflowId: string, waId: string, contactId: string, firstTemplateParams: string[]) => Promise<void | boolean | string>;
  /**
   * Campagne node (/v1/sends) : démarre le parcours à un bloc précis. Pas de `firstTemplateParams` (un template y
   * résout ses variables par ses sources, et `/v1/sends` refuse `params` sur un bloc) ni de garde de fenêtre
   * 24 h dans l'executor : quand le bloc ouvre par un message de session, la fenêtre a été vérifiée par
   * destinataire à la création de l'envoi.
   */
  startWorkflowFromNode?: (tenantId: string, workflowId: string, startNodeId: string, waId: string, contactId: string) => Promise<void | boolean | string>;
  /**
   * Cartes du carousel du template, relues chez Meta une seule fois par run (identiques pour tous les
   * destinataires). null ou absente = envoi inchangé.
   */
  getTemplateCarousel?: (tenantId: string, name: string, language: string) => Promise<{ cards: OutboundCarouselCard[] } | null>;
  /**
   * En-tête média du template, préparé pour l'envoi (`mediaId` obtenu en re-téléversant le visuel lu chez
   * Meta), une fois par run. Meta exige ce média à chaque envoi d'un template à en-tête IMAGE/VIDEO/DOCUMENT,
   * sinon il refuse tous les destinataires en 132012. null ou absente = envoi inchangé.
   */
  getTemplateHeaderMedia?: (
    tenantId: string,
    name: string,
    language: string,
  ) => Promise<{ headerFormat: 'IMAGE' | 'VIDEO' | 'DOCUMENT'; mediaId: string | null } | null>;
  /**
   * Écrit la joignabilité WhatsApp d'un contact, ici toujours `true` : sans elle, personne n'écrirait jamais
   * « oui » (le balayage de relance n'écrit que « non ») et la péremption ne se rafraîchirait pas.
   *
   * Un envoi accepté n'est pas une livraison : le 131026 peut arriver ensuite par le webhook. La mesure la plus
   * récente gagne, et c'est le second échec 131026 qui pose le « non ». Absent -> aucune écriture.
   */
  noterJoignabilite?: (tenantId: string, contactId: string, joignable: boolean) => Promise<void>;
  /**
   * Journalise une tentative d'envoi, en ajout seul, quel qu'en soit le résultat : c'est la seule trace de ce
   * que chaque canal a tenté (`campaign_recipients` ne garde que le dernier état).
   *
   * Best-effort comme `inbox.recordOutboundByWaId` : un échec d'écriture ne relabellise jamais un message livré ni
   * n'interrompt un run. Absent -> aucune écriture.
   */
  noterEnvoi?: (t: TentativeEnvoi) => Promise<void>;
  /** Journalise l'envoi sortant dans le fil de conversation (best-effort). Absent -> pas de journal. */
  inbox?: {
    recordOutboundByWaId(
      tenantId: string,
      waId: string,
      msg: { body: string; messageId: string | null; type?: string; templateCategory?: string | null; templateName?: string | null; channel?: 'whatsapp' | 'rcs'; origine: OrigineMessage },
    ): Promise<void>;
  };
  now?: () => number;
  thresholds?: GuardrailThresholds;
  /**
   * L'arrêt a-t-il été demandé (SIGTERM) ? Lu à chaque destinataire (lecture en mémoire). En sortant par là, le
   * statut n'est pas touché : la campagne reste `running` et le balayage de reprise la relance au redémarrage.
   * La marquer `paused` exigerait un geste humain alors que personne n'a rien décidé.
   */
  arretDemande?: () => boolean;
  /**
   * Durée maximale d'un run avant qu'il rende la main : il s'arrête entre deux destinataires, rend `reste:
   * true`, et l'appelant le réenfile (la campagne reste `running`). Une durée et non un nombre : c'est le temps
   * d'occupation de la file qu'on borne. Absente ou <= 0 -> aucun découpage.
   */
  dureeMaxMs?: number;
  /**
   * Repousse l'échéance du bail du verrou d'exécution, à la cadence de la relecture de statut. `false` = on ne
   * le tient plus, il faut s'arrêter.
   */
  renouvelerVerrou?: () => Promise<boolean>;
  /**
   * Écart minimal entre deux relectures du statut (ms). Cadencé par le temps et non par le nombre de
   * destinataires : à 1 message/minute, la pause mettrait sinon des heures à être vue.
   */
  statusPollMs?: number;
  /**
   * Les horaires d'ouverture de l'espace, pour une campagne « uniquement pendant les heures ouvrées ». Lus une
   * fois par run, et seulement si la campagne porte le drapeau. Absent -> aucune contrainte d'horaire.
   */
  horairesOuvres?: (tenantId: string) => Promise<{ timeZone: string; businessHours: BusinessHours } | null>;
  /**
   * Écrit la pause `numero_delie`, en une instruction, seulement si le numéro est encore délié en base et que
   * la campagne tourne encore. `true` = écrite. Cf. `arreterSurNumeroDelie`. Absente (faux de test) : la pause
   * est écrite par `setStatus`, sur la foi du refus.
   */
  numerosDelies?: { pauserCampagne(campaignId: string, tenantId: string, phoneNumberId: string): Promise<boolean> };
}

/**
 * La raison d'un run arrêté sur un refus « numéro délié » dont la pause n'a pas été écrite : le numéro a été
 * relié pendant que la garde en cache disait encore « délié », ou la campagne ne tournait plus.
 */
export const RAISON_NUMERO_RELIE_ENTRE_TEMPS =
  'numéro WhatsApp relié entre-temps, ou campagne qui ne tourne plus : run arrêté sans écrire de pause ; en cours, le balayage de reprise la relance dans la minute';

/** Défaut du pas de relecture du statut : au pire une requête indexée toutes les 5 s par run en cours. */
const DEFAULT_STATUS_POLL_MS = 5_000;


const DEFAULT_THRESHOLDS: GuardrailThresholds = {
  maxFailureRate: 0.3,
  minSendsForFailureCheck: 20,
};

/**
 * Les suffixes de boutons pour un destinataire, ou rien du tout.
 *
 * C'est le template qui décide, pas le jeton : Meta refuse un composant pour une URL sans variable comme une
 * URL à variable sans composant (131008, rien ne part). Sans jeton, on envoie donc un suffixe anonyme : le lien
 * fonctionne, le clic est compté sans être rattaché à personne.
 */
export const SUFFIXE_ANONYME = 'anon';

export function suffixesPourDestinataire(
  boutons: readonly number[],
  jeton: string | undefined,
): { suffixesBoutons?: Record<number, string> } {
  if (boutons.length === 0) return {};
  const suffixe = jeton && jeton !== '' ? jeton : SUFFIXE_ANONYME;
  return { suffixesBoutons: Object.fromEntries(boutons.map((i) => [i, suffixe])) };
}

/**
 * L'étage où est le destinataire, et ce que ce run sait en faire.
 *
 * Un run sert tout étage dont il sait servir le canal (`canauxServis`, calculé par `run-job`). Un étage non
 * servable (pas d'agent RCS, e-mail) est un refus avec sa raison, au vrai rang et au vrai canal, jamais un
 * repli silencieux sur le rang 1, qui renverrait le message qui vient d'échouer.
 *
 * `canauxServis` absent = le canal de la campagne seul. Chaîne absente ou vide = rang 1, canal de la campagne.
 */
export function etageServable(
  campaign: Pick<Campaign, 'channel' | 'chaine'>,
  rangCourant: number | undefined,
  canauxServis?: readonly CanalEtage[],
): { rang: number; canal: CanalEtage; refus: string | null } {
  const canalCampagne: CanalEtage = campaign.channel ?? 'whatsapp';
  const chaine = campaign.chaine ?? [];
  if (chaine.length === 0) return { rang: RANG_INITIAL, canal: canalCampagne, refus: null };

  const rang = rangCourant ?? RANG_INITIAL;
  const etage = etageAuRang(chaine, rang);
  // L'étage a été retiré de la chaîne pendant que ce destinataire y était : on ne devine pas un contenu de
  // remplacement, et le rang reste celui où il est pour que le journal dise où il s'est arrêté.
  if (etage === null) return { rang, canal: canalCampagne, refus: `étage ${rang} absent de la chaîne de cette campagne` };

  const servis = canauxServis ?? [canalCampagne];
  if (!servis.includes(etage.canal)) {
    return {
      rang,
      canal: etage.canal,
      refus: `étage ${rang} (${etage.canal}) : ce run ne sait pas envoyer sur ce canal`,
    };
  }
  return { rang, canal: etage.canal, refus: null };
}

/**
 * Ce qu'un étage envoie : son modèle, son message RCS, son scénario.
 *
 * Le rang 1 vient toujours des colonnes de `campaigns`, jamais de la ligne d'étage (`insertCampaignRow` la
 * recopie depuis ces colonnes) : une seule source pour son contenu. Les rangs suivants n'ont que leur ligne,
 * sans retomber sur la campagne, sinon un repli renverrait le message du rang 1.
 */
export function contenuDeLEtage(
  campaign: Pick<Campaign, 'templateName' | 'templateLanguage' | 'rcsMessage' | 'workflowId' | 'chaine'>,
  rang: number,
): { templateName: string; templateLanguage: string; rcsMessage: unknown; workflowId: string | null } {
  if (rang === RANG_INITIAL) {
    return {
      templateName: campaign.templateName,
      templateLanguage: campaign.templateLanguage,
      rcsMessage: campaign.rcsMessage,
      workflowId: campaign.workflowId,
    };
  }
  const etage = etageAuRang(campaign.chaine ?? [], rang);
  return {
    templateName: etage?.templateName ?? '',
    templateLanguage: etage?.templateLanguage ?? '',
    rcsMessage: etage?.rcsMessage,
    workflowId: etage?.workflowId ?? null,
  };
}

/**
 * L'étage WhatsApp de cette campagne, quand ce run sait le servir. Unique par construction (`problemeDeChaine`
 * refuse deux étages sur un même canal), ce qui permet les pré-lectures de modèle une seule fois par run. Pas
 * forcément le rang 1 : une campagne RCS à repli WhatsApp met son modèle au rang 2.
 */
function etageWhatsApp(
  campaign: Pick<Campaign, 'channel' | 'chaine' | 'templateName' | 'templateLanguage' | 'rcsMessage' | 'workflowId'>,
  canauxServis: readonly CanalEtage[],
): { rang: number; templateName: string; templateLanguage: string; workflowId: string | null } | null {
  if (!canauxServis.includes('whatsapp')) return null;
  const chaine = campaign.chaine ?? [];
  const rang = chaine.length === 0
    ? ((campaign.channel ?? 'whatsapp') === 'whatsapp' ? RANG_INITIAL : null)
    : (chaine.find((e) => e.canal === 'whatsapp')?.rang ?? null);
  if (rang === null) return null;
  const contenu = contenuDeLEtage(campaign, rang);
  return { rang, templateName: contenu.templateName, templateLanguage: contenu.templateLanguage, workflowId: contenu.workflowId };
}

/**
 * Exécute une campagne : parcourt les destinataires `pending` avec pacing et garde-fous (quality gate), réserve
 * chacun atomiquement (pending -> sending) avant l'appel Meta, puis envoie et enregistre le résultat. Un envoi
 * réussi dont la persistance échoue reste `sending`, jamais re-listé donc jamais ré-envoyé.
 *
 * La boucle relit périodiquement le statut et sort dès qu'il n'est plus `running` : c'est ce qui rend la pause
 * réelle. Les destinataires non traités restent `pending`, « Reprendre » repart là où on s'est arrêté.
 */
export async function runCampaign(campaign: Campaign, deps: EngineDeps): Promise<RunReport> {
  const now = deps.now ?? (() => Date.now());
  const t = deps.thresholds ?? DEFAULT_THRESHOLDS;
  const report: RunReport = { sent: 0, skipped: 0, failed: 0, paused: false };

  await deps.campaigns.setStatus(campaign.id, 'running');
  const pending = await deps.recipients.listPending(campaign.id);

  /** Les canaux que ce run sait servir (`EngineDeps.canaux`). */
  const canaux = deps.canaux;
  const canauxServis = Object.keys(canaux) as CanalEtage[];
  /** L'étage WhatsApp de la chaîne, s'il y en a un et que ce run sait le servir. Unique par construction. */
  const etageWa = etageWhatsApp(campaign, canauxServis);

  // Statut de sortie. Une campagne au fil de l'eau n'est pas finie quand sa file est vide : `completed` la
  // couperait de son webhook (seules les campagnes `running` sont nourries).
  const statutFinal: CampaignStatus = campaign.webhookId ? 'running' : 'completed';

  /**
   * Le statut de sortie réel, décidé au dernier moment. Un worker tué laisse le destinataire en vol en
   * `sending` : le run suivant ne le voit pas, et marquer `completed` ferait que `reclaimStale` le remette en
   * `pending` sur une campagne que la reprise ne relance plus. On reste donc `running` tant qu'un destinataire
   * est réservé.
   */
  const statutDeSortie = async (): Promise<CampaignStatus> => {
    if (statutFinal !== 'completed' || !deps.recipients.countSending) return statutFinal;
    return (await deps.recipients.countSending(campaign.id)) > 0 ? 'running' : 'completed';
  };

  // Carousel : identique pour tous les destinataires, relu une fois par run. Une lecture qui échoue ne casse
  // pas la campagne : un template sans carousel est inchangé, un carousel échouera avec l'erreur de Meta.
  let carousel: { cards: OutboundCarouselCard[] } | null = null;
  let carouselBlocked: string | null = null;
  if (etageWa && !etageWa.workflowId && deps.getTemplateCarousel) {
    try {
      const read = await deps.getTemplateCarousel(campaign.tenantId, etageWa.templateName, etageWa.templateLanguage);
      if (read) {
        carouselBlocked = carouselSendBlocker(read.cards);
        if (carouselBlocked === null) carousel = read;
      }
    } catch {
      /* lecture best-effort : jamais bloquante pour un template sans carousel */
    }
  }

  // En-tête média : même doctrine que le carousel, et même lecture une fois par run.
  let headerMedia: { headerFormat: 'IMAGE' | 'VIDEO' | 'DOCUMENT'; mediaId: string | null } | null = null;
  let headerBlocked: string | null = null;
  if (etageWa && !etageWa.workflowId && !carousel && deps.getTemplateHeaderMedia) {
    try {
      headerMedia = await deps.getTemplateHeaderMedia(campaign.tenantId, etageWa.templateName, etageWa.templateLanguage);
      if (headerMedia) headerBlocked = headerMediaSendBlocker(headerMedia.headerFormat, headerMedia.mediaId ?? undefined);
    } catch {
      /* lecture best-effort : un template sans en-tête média ne doit jamais être bloqué par elle */
    }
  }

  /**
   * Résoudre un destinataire : le marquer et journaliser la tentative, en un seul geste. Un seul point de
   * passage pour les cinq sites de résolution, sinon le journal devient une liste à tenir à la main.
   *
   * On marque d'abord : le journal ne doit jamais affirmer une tentative que la table des destinataires ne
   * connaît pas. Le rang et le canal viennent de l'étage du destinataire (`etageServable`, pure, rappelée
   * ici) : le journal est la seule source de l'analytique par canal.
   */
  const resoudre = async (
    r: Recipient,
    resultat: { status: 'sent' | 'failed' | 'skipped'; messageId?: string; error?: string; sentAt?: number; errorCode?: number },
  ): Promise<void> => {
    await deps.recipients.markResult(r.id, resultat);
    // `contactId` absent : rien à rattacher, et la colonne est `not null`. Les faux des tests en sont
    // dépourvus, la production ne l'est jamais (le destinataire naît d'un contact).
    if (!deps.noterEnvoi || !r.contactId) return;
    const etage = etageServable(campaign, r.etageCourant, canauxServis);
    try {
      await deps.noterEnvoi({
        campaignId: campaign.id,
        recipientId: r.id,
        contactId: r.contactId,
        rang: etage.rang,
        canal: etage.canal,
        statut: resultat.status === 'skipped' ? 'saute' : resultat.status,
        ...(resultat.messageId !== undefined ? { messageId: resultat.messageId } : {}),
        ...(resultat.errorCode !== undefined ? { errorCode: resultat.errorCode } : {}),
        ...(resultat.error !== undefined ? { error: resultat.error } : {}),
      });
    } catch {
      /* best-effort : une statistique manquante ne vaut jamais un run interrompu */
    }
  };

  /**
   * Le numéro WhatsApp de l'espace est délié : le run s'arrête et la campagne attend « Relier ».
   *
   * Comme le plafond de numéro de Meta, mais la pause n'a jamais d'échéance (seul « Relier » la lève, le
   * balayage de reprise ne la voit pas). Elle n'est écrite que si la base dit encore « délié », dans la même
   * instruction (`numerosDelies.pauserCampagne`) : la garde en cache 5 s peut le dire juste après « Relier », et une
   * pause écrite sur cette réponse serait éternelle. Sinon on sort, la campagne reste `running` et le balayage
   * des campagnes gelées la relance. L'instruction n'écrit que sur une campagne `running` ou `scheduled` : une
   * pause d'opérateur garde sa raison.
   *
   * L'appelant a déjà rendu à la file le destinataire en vol, rien ne lui étant parti par WhatsApp.
   */
  const arreterSurNumeroDelie = async (err: NumeroDelieError): Promise<RunReport> => {
    if (deps.numerosDelies) {
      if (!(await deps.numerosDelies.pauserCampagne(campaign.id, campaign.tenantId, err.phoneNumberId))) {
        report.reason = RAISON_NUMERO_RELIE_ENTRE_TEMPS;
        return report;
      }
    } else {
      await deps.campaigns.setStatus(campaign.id, 'paused', { raison: 'numero_delie', reprise: null });
    }
    report.paused = true;
    report.reason = messageDePause('numero_delie', null, undefined);
    return report;
  };

  /**
   * Le modèle WhatsApp n'est pas envoyable : on le sait avant d'avoir commencé. Le refus ne vise que les
   * destinataires de l'étage WhatsApp, les autres (repli RCS) repartent dans la boucle normale. Il est traité
   * ici et pas dans la boucle, sinon la porte de qualité verrait 100 % d'échecs et mettrait la campagne en
   * pause avec un diagnostic trompeur.
   */
  let aTraiter = pending;
  if (carouselBlocked !== null || headerBlocked !== null) {
    const reason = carouselBlocked !== null ? `Carousel non envoyable : ${carouselBlocked}` : `Template non envoyable : ${headerBlocked}`;
    const restants: Recipient[] = [];
    for (const r of pending) {
      if (r.status === 'sent') continue;
      if (etageServable(campaign, r.etageCourant, canauxServis).canal !== 'whatsapp') { restants.push(r); continue; }
      const reserve = await deps.recipients.claim(r.id);
      if (reserve === false) continue;
      // Un contact qui a dit STOP est écarté, pas mis en échec : le modèle n'y est pour rien.
      if (reserve !== true) {
        await resoudre(r, { status: 'skipped', error: MOTIF_ECART_A_L_ENVOI[reserve.ecart] });
        report.skipped += 1;
        continue;
      }
      await resoudre(r, { status: 'failed', error: reason });
      report.failed += 1;
    }
    if (restants.length === 0) {
      await deps.campaigns.setStatus(campaign.id, await statutDeSortie());
      return report;
    }
    aTraiter = restants;
  }

  /**
   * L'attribution des clics : quels boutons portent un suffixe variable, et quel jeton chaque destinataire y
   * met. Les deux lectures se font en amont de la boucle (pas deux requêtes par message) et sont best-effort :
   * une attribution qui échoue coûte la mesure, jamais l'envoi.
   */
  let boutonsAJeton: number[] = [];
  let jetons = new Map<string, string>();
  const idsDesContacts = (): string[] =>
    [...new Set(aTraiter.map((r) => r.contactId).filter((v): v is string => typeof v === 'string' && v !== ''))];
  if (etageWa && !etageWa.workflowId && deps.boutonsTraces) {
    try {
      boutonsAJeton = await deps.boutonsTraces(campaign.tenantId, etageWa.templateName, etageWa.templateLanguage);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('attribution des clics ignorée pour cette campagne:', messageDe(err));
      boutonsAJeton = [];
    }
  }
  /**
   * Les jetons, chargés en un énoncé si l'un des canaux en a besoin. Côté WhatsApp, c'est la liste des boutons
   * qui décide (l'URL soumise à Meta porte ou non un `{{1}}`) ; côté RCS, le message dit s'il porte un lien
   * traçable (`aBesoinDeJeton`). Une chaîne peut avoir besoin des deux, d'où un « ou ».
   */
  const besoinDeJeton = boutonsAJeton.length > 0 || canaux.rcs?.sender?.aBesoinDeJeton === true;
  if (besoinDeJeton && deps.jetonsPourContacts) {
    try {
      jetons = await deps.jetonsPourContacts(campaign.tenantId, idsDesContacts());
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('attribution des jetons de clic ignorée pour cette campagne:', messageDe(err));
    }
  }

  // Horloge du contrôle d'arrêt, partie à maintenant : on vient d'écrire `running`, relire tout de suite
  // n'apprendrait rien.
  const pasDeControle = deps.statusPollMs ?? DEFAULT_STATUS_POLL_MS;
  let dernierControle = now();
  // Horloge du lot : un run travaille au plus `dureeMaxMs`, puis rend la main et se fait réenfiler.
  const debutDuLot = now();

  // Horaires d'ouverture : lus une fois, et seulement si la campagne les demande. Une lecture en échec vaut
  // « pas de contrainte » : une panne de lecture ne doit pas retenir un envoi que le client a lancé.
  const horaires = campaign.businessHoursOnly === true && deps.horairesOuvres
    ? await deps.horairesOuvres(campaign.tenantId).catch(() => null)
    : null;

  for (const r of aTraiter) {
    if (r.status === 'sent') continue; // idempotence défensive

    // Durée maximale du lot : sans elle, une grosse campagne occuperait la file des heures pendant que les
    // autres clients attendent. On s'arrête entre deux destinataires, le suivant reste `pending`. La sortie n'est
    // prise que si du travail a déjà été fait, sinon une durée mal réglée ferait un run qui se réenfile à vide.
    const traites = report.sent + report.failed + report.skipped;
    if (deps.dureeMaxMs !== undefined && deps.dureeMaxMs > 0 && traites > 0 && now() - debutDuLot >= deps.dureeMaxMs) {
      report.reste = true;
      return report;
    }

    // Arrêt du process (SIGTERM), testé avant toute réservation : le suivant reste `pending` pour la reprise, et
    // le statut n'est pas réécrit.
    if (deps.arretDemande?.()) {
      report.paused = true;
      report.reason = 'arrêt du service pendant l’envoi ; la campagne reprendra au redémarrage';
      return report;
    }

    // Hors des heures d'ouverture : contrôlé avant toute réservation, à chaque destinataire (une campagne lancée
    // de nuit comme une campagne pas finie à la fermeture). On pose l'instant de reprise, donc le balayage de
    // reprise la relance à l'ouverture, sans clic.
    if (horaires !== null && !withinBusinessHours(new Date(now()), horaires.timeZone, horaires.businessHours)) {
      // `null` = aucun jour ouvert : pas d'échéance, comme une pause de qualité, et le message le dit.
      const reprise = prochaineOuverture(new Date(now()), horaires.timeZone, horaires.businessHours);
      report.paused = true;
      report.reason = messageDePause('hors_horaires', reprise, undefined);
      await deps.campaigns.setStatus(campaign.id, 'paused', { raison: 'hors_horaires', reprise });
      return report;
    }

    // Arrêt demandé ? Contrôlé avant le claim et avant toute attente de cadence. Le statut n'est pas réécrit en
    // sortant : c'est l'opérateur qui l'a mis, le réécrire écraserait sa décision.
    // Appel de méthode, jamais une référence déliée : `PgCampaignStore` lit `this.pool`.
    if (deps.campaigns.getStatus && now() - dernierControle >= pasDeControle) {
      dernierControle = now();
      // Le bail se renouvelle à la même cadence, et un refus arrête le run : un autre run peut avoir démarré, et
      // continuer doublerait le débit.
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

    /**
     * L'étage de ce destinataire, résolu en tête du tour : la porte de qualité, le frein de cadence, le contenu
     * et le journal en dépendent. Le refus, lui, reste après le claim : marquer suppose d'avoir réservé.
     */
    const etageDuTour = etageServable(campaign, r.etageCourant, canauxServis);
    const servi = canaux[etageDuTour.canal];

    // Quality gate : notion Meta (rating du numéro). C'est la présence d'un sender de canal qui la neutralise,
    // pas le nom du canal ; sinon on appellerait Graph avec un phoneNumberId vide.
    if (servi && !servi.sender) {
      const rating = await deps.quality.getRating(servi.phoneNumberId ?? campaign.phoneNumberId);
      const gate = qualityGate({ rating, sent: report.sent, failed: report.failed }, t);
      if (gate.pause) {
        report.paused = true;
        if (gate.reason !== undefined) report.reason = gate.reason;
        await deps.campaigns.setStatus(campaign.id, 'paused');
        return report;
      }
    }

    // Claim atomique : si un autre run/worker a déjà pris ce destinataire, on passe.
    const reserve = await deps.recipients.claim(r.id);
    if (reserve === false) continue;

    /**
     * 🔴 Le STOP et le blocage se relisent au moment d'envoyer, par la réclamation : une campagne étalée part
     * des heures après la construction de la liste. Écarté (`skipped`), jamais `failed`, pour que la porte de
     * qualité ne le compte pas. Avant le frein de cadence : rien ne part, aucun créneau n'est occupé.
     */
    if (reserve !== true) {
      await resoudre(r, { status: 'skipped', error: MOTIF_ECART_A_L_ENVOI[reserve.ecart] });
      report.skipped += 1;
      continue;
    }

    // Refus si l'étage n'est pas servable : après le claim (il faut avoir réservé pour marquer), avant le frein
    // (un refus n'occupe aucun créneau).
    if (etageDuTour.refus !== null || !servi) {
      const refus = etageDuTour.refus ?? `étage ${etageDuTour.rang} (${etageDuTour.canal}) : ce run ne sait pas envoyer sur ce canal`;
      await resoudre(r, { status: 'failed', error: refus });
      report.failed += 1;
      continue;
    }

    // Le frein est celui du canal de l'étage, pas celui de la campagne.
    if (servi.rateLimiter) await servi.rateLimiter.acquire();

    /** Ce que cet étage envoie. Le rang 1 vient des colonnes de la campagne. */
    const contenu = contenuDeLEtage(campaign, etageDuTour.rang);

    // Les variables de source NOW sont rafraîchies à l'instant de l'envoi, sinon une campagne programmée
    // enverrait la date de sa création. Fuseau par défaut : Europe/Paris (DEFAULT_NOW_TZ).
    const params = refreshNowParams(r.resolvedParams, campaign.paramMapping, { now: new Date(now()) });

    // Une erreur du sender marque le destinataire `failed`, comme un scénario qui ne démarre pas
    // (`started === false`) : sinon la campagne afficherait « envoyé » sans qu'aucun message soit parti.
    let res: SendResult;
    let notStarted: string | null = null;
    // Écarté par le canal lui-même (non joignable en RCS, opt-out) : ni envoyé ni échoué.
    let skipped: string | null = null;
    /**
     * Le scénario d'un étage servi par un canal n'a pas démarré, mais le message est parti : le destinataire
     * reste `sent` avec la raison à côté. Le marquer `failed` le ferait reprendre par une relance, et le message
     * RCS partirait deux fois. `RECIPIENT_FAILED_SQL` ne regarde que `status` et `delivery_status`.
     */
    let scenarioNonDemarre: string | null = null;
    /**
     * Ce scénario a buté sur le numéro délié. Le destinataire reste `sent`, mais le run s'arrête après lui : les
     * suivants recevraient leur message sans jamais leur suite.
     */
    let scenarioSurNumeroDelie: NumeroDelieError | null = null;
    try {
      if (servi.sender) {
        // Le jeton de ce destinataire, pour savoir qui a cliqué. Absent : lien tracé mais anonyme, jamais cassé.
        const out = await servi.sender.sendTo(r, r.contactId ? jetons.get(r.contactId) : undefined);
        if ('skipped' in out) {
          skipped = out.skipped;
          res = { messageId: '' };
        } else {
          res = out;
          /**
           * « Message et scénario » : le message part, puis le scénario, jamais avant (la suite ne doit pas
           * précéder le message) ni sur un destinataire écarté par le canal. Son propre `try` : une panne du
           * moteur de scénario ne doit pas marquer `failed` un message déjà livré.
           */
          if (contenu.workflowId) {
            try {
              if (!deps.startWorkflow) {
                scenarioNonDemarre = 'Scénario non démarré : moteur de scénario non câblé.';
              } else {
                /**
                 * Les variables du rang 1 ne partent pas avec le scénario d'un étage de repli : `params` décrit
                 * le modèle du rang 1, et le premier bloc « Modèle » du parcours n'a aucune raison d'avoir les
                 * mêmes (Meta refuserait, ou remplirait les trous avec les mauvaises valeurs).
                 */
                const heritees = etageDuTour.rang === RANG_INITIAL ? params : [];
                const suite = await deps.startWorkflow(
                  campaign.tenantId, contenu.workflowId, waIdOfTarget(r.toE164), r.contactId, heritees,
                );
                if (typeof suite === 'string') scenarioNonDemarre = `Scénario non démarré : ${suite}`;
                else if (suite === false) scenarioNonDemarre = 'Scénario non démarré (scénario supprimé).';
              }
            } catch (e) {
              scenarioNonDemarre = `Scénario non démarré : ${texteDe(e)}`;
              if (e instanceof NumeroDelieError) scenarioSurNumeroDelie = e;
            }
          }
        }
      } else if (contenu.workflowId && campaign.startNodeId) {
        // Campagne node (/v1/sends) : démarre le parcours à un bloc précis. Si ce bloc ouvre par un message de
        // session, les destinataires hors fenêtre de 24 h ont déjà été écartés à la création.
        if (!deps.startWorkflowFromNode) throw new Error('startWorkflowFromNode non câblé');
        const waId = waIdOfTarget(r.toE164);
        const started = await deps.startWorkflowFromNode(campaign.tenantId, contenu.workflowId, campaign.startNodeId, waId, r.contactId);
        // Une chaîne porte la raison exacte du refus : on l'affiche telle quelle.
        if (typeof started === 'string') notStarted = `Scénario non démarré : ${started}`;
        else if (started === false) notStarted = 'scénario non démarré (bloc de départ indisponible)';
        res = { messageId: `wf-${contenu.workflowId}` };
      } else if (contenu.workflowId) {
        // Campagne scénario : on démarre le parcours (blocs sync puis premier template). message_id synthétique,
        // le wamid réel vit dans le run. wa_id = numéro en chiffres nus (comme le webhook) ou BSUID tel quel.
        if (!deps.startWorkflow) throw new Error('startWorkflow non câblé');
        const waId = waIdOfTarget(r.toE164);
        // Variables du premier template, résolues à la construction : pas de re-résolution à l'envoi.
        const started = await deps.startWorkflow(campaign.tenantId, contenu.workflowId, waId, r.contactId, params);
        if (typeof started === 'string') notStarted = `Scénario non démarré : ${started}`;
        else if (started === false) notStarted = 'scénario non lançable (ouverture hors fenêtre 24 h, ou scénario supprimé)';
        res = { messageId: `wf-${contenu.workflowId}` };
      } else {
        const tpl: TemplateSpec = {
          name: contenu.templateName,
          language: contenu.templateLanguage,
          components: buildTemplateComponents({
            bodyParams: params,
            ...(carousel ? { carousel } : {}),
            // `mediaId` non nul garanti par le refus pré-boucle : `headerMediaSendBlocker` a déjà arrêté le run.
            ...(headerMedia?.mediaId ? { headerMediaId: headerMedia.mediaId, headerFormat: headerMedia.headerFormat } : {}),
            // Le suffixe de ce destinataire sur chaque bouton tracé (anonyme sans jeton).
            ...suffixesPourDestinataire(boutonsAJeton, r.contactId ? jetons.get(r.contactId) : undefined),
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
      // Numéro délié, levé par un scénario démarré pour ce destinataire : le refus vise le numéro, et un `failed`
      // ne serait pas repris par « Relier ». On le rend à la file et on s'arrête (`runFrom` vérifie le numéro
      // avant tout effet ; limite : la garde est en cache 5 s).
      if (err instanceof NumeroDelieError) {
        await deps.recipients.relacher(r.id);
        return arreterSurNumeroDelie(err);
      }

      const msg = err instanceof MetaApiError ? `${err.code ?? ''} ${err.message}`.trim() : String(err);
      const errorCode = err instanceof MetaApiError && typeof err.code === 'number' ? err.code : undefined;

      // Plafond du numéro : le refus vise le numéro émetteur, pas ce contact. Compté en échec, il brûlerait toute
      // l'audience restante ; on le rend à la file et on met en pause (le balayage ne relance pas trop tôt).
      const raison = raisonDePause(err);
      if (raison !== undefined) {
        await deps.recipients.relacher(r.id);
        report.paused = true;
        // Le délai vient du `Retry-After` de Meta quand il existe, borné. La qualité ne donne aucun instant de
        // reprise : un humain doit regarder avant de relancer.
        const reprise = instantDeReprise(raison, err instanceof MetaApiError ? err.retryAfterMs : undefined, (deps.now ?? Date.now)());
        report.reason = messageDePause(raison, reprise, errorCode);
        await deps.campaigns.setStatus(campaign.id, 'paused', { raison, reprise });
        return report;
      }

      await resoudre(r, { status: 'failed', error: msg, ...(errorCode !== undefined ? { errorCode } : {}) });
      report.failed += 1;
      continue;
    }

    // Écarté par le canal : ni envoyé ni échoué. Scénario non démarré : aucun message n'est parti, c'est un
    // échec avec sa raison, jamais un `sent` affiché à tort.
    if (skipped !== null) {
      await resoudre(r, { status: 'skipped', error: skipped });
      report.skipped += 1;
      continue;
    }

    if (notStarted !== null) {
      await resoudre(r, { status: 'failed', error: notStarted });
      report.failed += 1;
      continue;
    }

    // Message livré. Le succès se persiste hors du catch d'envoi : une erreur de persistance ne relabellise pas
    // un message livré en `failed`. Le destinataire est déjà `sending`, donc jamais ré-envoyé sur un rejeu.
    const at = now();
    report.sent += 1;
    await resoudre(r, {
      status: 'sent',
      messageId: res.messageId,
      sentAt: at,
      // Le message est livré ; si son scénario n'a pas démarré, la raison voyage avec le succès plutôt que
      // de disparaître. Un destinataire `sent` porteur d'une raison n'entre dans aucun compte d'échec.
      ...(scenarioNonDemarre !== null ? { error: scenarioNonDemarre } : {}),
    });

    // Ce contact est joignable en WhatsApp : Meta a accepté le message. Seulement quand un template WhatsApp
    // est vraiment parti d'ici (ni sender de canal, ni scénario au `messageId` synthétique). Best-effort : au
    // pire le verdict reste `inconnu`, ce qui n'exclut personne.
    if (deps.noterJoignabilite && !contenu.workflowId && !servi.sender && etageDuTour.canal === 'whatsapp' && r.contactId) {
      try {
        await deps.noterJoignabilite(campaign.tenantId, r.contactId, true);
      } catch {
        /* best-effort : ne casse jamais l'envoi réussi */
      }
    }

    // Journalise dans le fil ce qui est parti d'ici (template direct, ou sender de canal). Un scénario WhatsApp
    // est journalisé par le worker à l'envoi réel ; un RCS part d'ici même quand un scénario suit. Best-effort.
    if (deps.inbox && (servi.sender !== undefined || !contenu.workflowId)) {
      const waId = waIdOfTarget(r.toE164);
      const rcs = servi.sender !== undefined;
      const body = rcs
        ? rcsCampaignBody(contenu.rcsMessage)
        : `Template « ${contenu.templateName} »${params.length > 0 ? ` (${params.join(', ')})` : ''}`;
      try {
        await deps.inbox.recordOutboundByWaId(campaign.tenantId, waId, {
          body,
          messageId: res.messageId,
          origine: 'campagne',
          type: rcs ? 'rcs' : 'template',
          ...(rcs
            ? { channel: 'rcs' as const }
            : { templateCategory: campaign.category, templateName: contenu.templateName }),
        });
      } catch {
        /* log best-effort : ne casse jamais l'envoi réussi */
      }
    }

    /**
     * « Message et scénario » sur un numéro délié : le message est parti, le scénario a buté. Le destinataire
     * reste `sent` et n'est pas rendu à la file (il recevrait le message deux fois), mais on s'arrête après lui,
     * sauf s'il était le dernier : il ne reste alors personne à protéger, et la campagne sort par le chemin
     * normal au lieu de rester `running` à vie.
     */
    if (scenarioSurNumeroDelie !== null && aTraiter.slice(aTraiter.indexOf(r) + 1).some((x) => x.status !== 'sent')) {
      return arreterSurNumeroDelie(scenarioSurNumeroDelie);
    }
  }

  await deps.campaigns.setStatus(campaign.id, await statutDeSortie());
  return report;
}
