import type { Campaign, CampaignStatus, Recipient, RunReport, GuardrailThresholds, QualityRating } from './types';
import { frequencyAllows, qualityGate } from './guardrails';
import { buildTemplateComponents, carouselSendBlocker, headerMediaSendBlocker } from '../meta/template-components';
import type { OutboundCarouselCard } from '../meta/template-components';
import { refreshNowParams } from '../crm/template';
import { messagingTarget } from '../meta/types';
import type { OrigineMessage } from '../inbox/origine';
import type { SendResult, TemplateSpec, MarketingParams } from '../meta/types';
import { MetaApiError, raisonDePause } from '../meta/errors';
import { instantDeReprise, messageDePause } from './pause';
import type { MotifDePause } from './pause';
import { withinBusinessHours } from '../workflow/conditions';
import type { BusinessHours } from '../workflow/conditions';
import { prochaineOuverture } from '../lib/heures-ouvrees';
import type { CampaignSender } from './sender';
import { waIdOfTarget } from '../crm/identity';
import { RANG_INITIAL, etageAuRang, type CanalEtage } from './etages';

/**
 * UNE TENTATIVE D'ENVOI, telle qu'on la journalise (migration 0134).
 *
 * ⚠️ `saute` n'est PAS un échec : le destinataire a été ÉCARTÉ avant toute tentative (consentement absent
 * sur une campagne marketing, variable de template introuvable sur sa fiche). Les confondre gonflerait le
 * taux d'échec d'un canal avec des gens qu'il n'a jamais essayé de joindre.
 *
 * ⚠️ Le contrat vit ICI et son implémentation dans `envois.pg.ts`, comme `RecipientStore` et
 * `CampaignStore` : c'est le moteur qui dit ce dont il a besoin, pas la base qui dicte sa forme.
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
  /**
   * Combien de destinataires sont RÉSERVÉS mais pas encore résolus (`sending`) ?
   *
   * 🔴 Sert à ne PAS déclarer une campagne terminée alors qu'un destinataire est en suspens. Absent ->
   * comportement d'avant (rétro-compatible avec les faux des tests).
   */
  countSending?(campaignId: string): Promise<number>;
}

export interface CampaignStore {
  /**
   * `pause` n'est fourni QUE sur une mise en pause qui doit être expliquée, et il décide si la campagne
   * repartira toute seule : `raison: 'debit'` ou `'hors_horaires'` avec un instant de reprise, ou
   * `raison: 'qualite'` avec `reprise: null`, qui veut dire « jamais automatiquement ». Toute autre
   * transition l'omet, et l'implémentation efface alors les deux colonnes : une campagne qui repart ne doit
   * pas garder l'échéance d'une pause d'avant.
   */
  setStatus(campaignId: string, status: Campaign['status'], pause?: { raison: MotifDePause; reprise: Date | null }): Promise<void>;
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

/** Ce qu'il faut pour servir UN canal pendant un run : par qui on envoie, à quelle cadence, depuis quel numéro. */
export interface CanalServi {
  /**
   * Sender de CANAL (RCS). Absent = canal WhatsApp, servi par `deps.sender` et ses gardes Meta.
   *
   * ⚠️ C'est sa PRÉSENCE, et non le nom du canal, qui neutralise les gardes propres à WhatsApp (porte de
   * qualité, pré-lectures de modèle, mémoire de joignabilité) : elles n'ont pas d'équivalent ailleurs et
   * il n'y a aucun numéro Meta à interroger.
   */
  sender?: CampaignSender;
  /** Le frein de cadence de CE canal (`plafondDuCanal`). Absent = aucun frein sur ce canal. */
  rateLimiter?: RateGate;
  /**
   * Le numéro Meta qui sert ce canal, pour la porte de qualité. Utile au seul canal WhatsApp.
   *
   * 🔴 IL N'EST PAS TOUJOURS `campaign.phoneNumberId` : une campagne RCS l'a VIDE en base (migration
   * 0056, « une campagne RCS n'a pas de numéro Meta ») et son repli WhatsApp doit pourtant partir de
   * quelque part. `run-job` résout alors le numéro de l'espace.
   */
  phoneNumberId?: string;
}

export interface EngineDeps {
  sender: MessageSender;
  recipients: RecipientStore;
  campaigns: CampaignStore;
  frequency: FrequencyStore;
  quality: QualityProvider;
  rateLimiter?: RateGate;
  /**
   * Sender de CANAL (RCS) POUR LE CANAL DE LA CAMPAGNE, quand `canaux` n'est pas fourni.
   *
   * ⚠️ C'EST LA FORME COURTE DE `canaux`, GARDÉE POUR LES CÂBLAGES QUI N'EN ONT QU'UN. Le moteur en
   * fabrique alors une table à une entrée, celle du canal de la campagne. Présent : l'envoi passe par
   * LUI, et les gardes propres à WhatsApp sont neutralisées (quality rating Meta, lecture du carousel et
   * de l'en-tête média) parce qu'elles n'ont pas d'équivalent sur ce canal et qu'aucun numéro Meta
   * n'existe pour l'interroger. Absent : comportement historique INCHANGÉ.
   *
   * ⚠️ IGNORÉ DÈS QUE `canaux` EST FOURNI, et c'est le bon sens de priorité : `run-job` construit la
   * table complète, elle ne doit pas être complétée par une valeur qui ne dit qu'un canal.
   */
  channelSender?: CampaignSender;
  /**
   * CE QUE CE RUN SAIT SERVIR, CANAL PAR CANAL (lot 6).
   *
   * 🔴 C'EST LA PIÈCE QUI REND UNE CHAÎNE DE REPLI FONCTIONNELLE. Un run était construit sur les
   * colonnes de `campaigns`, donc sur UN canal : le sender, le frein de cadence et la porte de qualité en
   * dépendaient tous, et un destinataire posé au rang 2 par la bascule ne pouvait qu'être refusé. Ici,
   * chaque canal de la chaîne apporte son sender et son frein, et le moteur choisit selon l'ÉTAGE du
   * destinataire.
   *
   * 🔴 UN CANAL ABSENT DE CETTE TABLE N'EST PAS SERVABLE, et son étage échoue AVEC SA RAISON. C'est
   * le cas de l'e-mail (aucun sender de campagne n'existe) et d'un étage RCS sur un espace sans agent.
   * Le refus vaut mieux qu'un repli sur le canal de la campagne, qui renverrait le message qui vient
   * d'échouer.
   *
   * ⚠️ ABSENTE = LE COMPORTEMENT D'AVANT, MOT POUR MOT : le moteur fabrique alors la table à UNE entrée,
   * celle du canal de la campagne, avec `channelSender` et `rateLimiter`. C'est ce qui laisse intacts tous
   * les faux de test et l'e2e, qui ne la câblent pas.
   */
  canaux?: Partial<Record<CanalEtage, CanalServi>>;
  /**
   * Campagne WORKFLOW : démarre le workflow pour un destinataire (au lieu d'envoyer un template).
   * `firstTemplateParams` = variables du 1er template DÉJÀ résolues par contact (buildRecipients à partir du
   * paramMapping de la campagne) -> l'executor les passe telles quelles au 1er envoi (pas de re-résolution).
   *
   * Renvoie `false` quand le run n'a PAS démarré (scénario supprimé, fil détenu par un humain/MBA, ouverture
   * hors fenêtre) : le destinataire est alors marqué en ÉCHEC, jamais compté comme envoyé. `void` toléré pour
   * les câblages qui ne savent pas le dire (traité comme un démarrage réussi, comportement historique).
   */
  /**
   * Les index de boutons de ce template qui portent un SUFFIXE VARIABLE (migration 0106), donc pour lesquels
   * l'envoi doit fournir un composant `sub_type: 'url'`. Vide = aucun, donc comportement d'avant.
   *
   * ⚠️ Se tromper ici fait ECHOUER l'envoi dans les deux sens : un composant pour un template sans variable
   * comme une variable sans composant rendent un 132000. C'est pourquoi la réponse vient d'une colonne
   * ecrite a la soumission, jamais d'une deduction.
   */
  boutonsTraces?: (tenantId: string, templateName: string, templateLanguage: string) => Promise<number[]>;
  /** Le jeton public de ces contacts, fabriqué pour ceux qui n'en ont pas. Un seul énoncé pour toute la campagne. */
  jetonsPourContacts?: (tenantId: string, contactIds: readonly string[]) => Promise<Map<string, string>>;
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
  /**
   * Écrit la joignabilité WhatsApp d'un contact (migration 0133), ici toujours `true`.
   *
   * 🔴 SANS CE CÂBLAGE, LE CHAMP N'EST QU'UNE LISTE NOIRE. Le balayage de relance ne sait écrire que
   * « non » : personne n'écrirait jamais « oui », donc aucun écran ne pourrait annoncer une COUVERTURE,
   * seulement une exclusion, et la péremption de 90 jours ne se rafraîchirait jamais sur un numéro qui
   * répond tous les jours.
   *
   * ⚠️ UN ENVOI ACCEPTÉ N'EST PAS UNE LIVRAISON, et c'est la limite assumée de ce signal : Meta rend un
   * wamid tout de suite, et le 131026 arrive ENSUITE par le webhook de livraison. Un « oui » peut donc
   * être démenti quelques minutes plus tard. Ce n'est pas un défaut : la mesure la plus RÉCENTE gagne
   * (la date est réécrite à chaque note), et c'est le second échec 131026 qui pose le « non ».
   *
   * Absent -> aucune écriture, comportement d'avant (fixtures de test, e2e).
   */
  noterJoignabilite?: (tenantId: string, contactId: string, joignable: boolean) => Promise<void>;
  /**
   * Journalise UNE tentative d'envoi (migration 0134), quel qu'en soit le résultat.
   *
   * 🔴 EN AJOUT SEUL, ET AU GRAIN TENTATIVE. `campaign_recipients` garde une ligne par CONTACT, donc un
   * seul état : le jour où un destinataire échouera en WhatsApp puis réussira en RCS, elle n'en gardera
   * que le dernier, et l'échec du premier canal serait invisible. C'est ce journal, et lui seul, qui
   * saura dire ce que chaque canal a coûté et rapporté.
   *
   * ⚠️ BEST-EFFORT, exactement comme `recordOutbound` et `noterJoignabilite` : une écriture de journal
   * qui échoue ne doit JAMAIS relabelliser un message livré ni interrompre un run. Ce qu'elle coûte
   * alors est une ligne manquante dans une statistique, jamais un message.
   *
   * Absent -> aucune écriture, comportement d'avant (fixtures de test, e2e).
   */
  noterEnvoi?: (t: TentativeEnvoi) => Promise<void>;
  /** Journalise l'envoi sortant dans le fil de conversation (best-effort). Absent -> pas de log (rétro-compatible). */
  recordOutbound?: (
    tenantId: string,
    waId: string,
    msg: { body: string; messageId: string | null; type?: string; templateCategory?: string | null; templateName?: string | null; channel?: 'whatsapp' | 'rcs'; origine: OrigineMessage },
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
  /**
   * Les horaires d'ouverture de l'espace, pour une campagne cochée « uniquement pendant les heures ouvrées ».
   *
   * Lus UNE FOIS par run, avant la boucle, et seulement si la campagne porte le drapeau : c'est un réglage
   * d'espace, il ne bouge pas pendant un envoi, et le relire par destinataire ferait une requête par message.
   *
   * Absent -> aucune contrainte d'horaire, comportement historique. C'est aussi ce qui rend les fixtures de
   * test et l'e2e muettes sur le sujet tant qu'elles n'en parlent pas.
   */
  horairesOuvres?: (tenantId: string) => Promise<{ timeZone: string; businessHours: BusinessHours } | null>;
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
/**
 * Les suffixes de boutons pour UN destinataire, ou rien du tout.
 *
 * 🔴 CE QUI DÉCIDE, C'EST LE TEMPLATE, PAS LE JETON. Meta refuse l'appel dans les DEUX sens : un composant
 * fourni pour une URL sans variable, et une URL à variable dont le composant manque. Or la liste des boutons
 * tracés décrit le TEMPLATE (colonne écrite à sa soumission) : elle seule dit s'il faut des composants.
 *
 * ⚠️ CORRIGÉ LE 2026-09-02, APRÈS UN ÉCHEC EN PRODUCTION. La version d'avant ne produisait aucun composant
 * quand le jeton manquait, en annonçant « on perd la mesure, on ne perd pas le message ». C'est l'inverse qui
 * arrive : le template est déjà approuvé chez Meta avec `/r/<code>/{{1}}`, donc sans composant l'appel est
 * refusé en **131008 Required parameter is missing** et RIEN ne part. Mesuré sur trois campagnes ce jour-là.
 * Sans jeton, on envoie donc un suffixe ANONYME : le lien fonctionne, le clic est compté, il n'est rattaché à
 * personne. C'est là, et seulement là, qu'on dégrade la mesure plutôt que l'envoi.
 *
 * Fonction pure et exportée pour être éprouvée seule : c'est une décision à deux issues sur le chemin le plus
 * chaud du produit, et la tester à travers un run de campagne entier ne dirait pas grand-chose.
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
 * L'ÉTAGE OÙ EST LE DESTINATAIRE, ET CE QUE CE RUN SAIT EN FAIRE (migration 0134).
 *
 * 🔴 CE N'EST PLUS « LE RANG 1 ET LUI SEUL » DEPUIS LE 2026-09-12. Un run sert désormais tout étage
 * dont il sait servir le CANAL, et `canauxServis` est la liste de ces canaux, calculée par `run-job` sur
 * la chaîne de la campagne (un sender par canal, un frein par canal). Le refus a donc changé de nature :
 * il ne porte plus sur le RANG, il porte sur le CANAL. C'est ce qui rend une chaîne de repli réellement
 * fonctionnelle au lieu de décorative.
 *
 * 🔴 ET IL RESTE UN REFUS, JAMAIS UN REPLI SILENCIEUX. Un étage dont le canal n'est pas servable (pas
 * d'agent RCS, canal e-mail qui n'a aucun sender de campagne) échoue AVEC SA RAISON, au vrai rang et au
 * vrai canal. Lui renvoyer le contenu du rang 1 lui enverrait EXACTEMENT le message qui vient d'échouer.
 *
 * ⚠️ `canauxServis` ABSENT = LE CANAL DE LA CAMPAGNE, ET RIEN D'AUTRE. C'est le comportement d'avant mot
 * pour mot, et c'est ce qui laisse intacts tous les faux de test qui n'en fournissent pas : une chaîne
 * dont deux étages ne partagent jamais le même canal (`problemeDeChaine` l'interdit) n'a alors qu'un seul
 * étage servable, le rang 1.
 *
 * ⚠️ CHAÎNE ABSENTE OU VIDE = le comportement d'avant, mot pour mot : rang 1, canal de la campagne. C'est
 * le cas de tout le parc (campagnes d'avant 0134 non reprises, faux des tests qui ne câblent pas `chaine`).
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
  // L'étage a été retiré de la chaîne pendant que ce destinataire y était. On ne devine PAS un contenu de
  // remplacement : on ne sait plus ce qu'on devait lui envoyer, et le rang reste celui où il est, pour que
  // le journal dise où il s'est arrêté.
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
 * CE QU'UN ÉTAGE ENVOIE : son modèle, son message RCS, son scénario.
 *
 * 🔴 LE RANG 1 VIENT TOUJOURS DES COLONNES DE `campaigns`, JAMAIS DE LA LIGNE D'ÉTAGE. C'est
 * l'invariant que la migration 0134 pose en toutes lettres (« une seule source pour le contenu d'un
 * étage ») et que `insertCampaignRow` applique : la ligne du rang 1 est RECOPIÉE depuis ces colonnes, et
 * ce que le client aurait mis sur son premier étage est ignoré. Lire la ligne ici rouvrirait la seconde
 * vérité que cet invariant ferme, et casserait au passage tout faux de test qui déclare une chaîne sans
 * recopier le contenu de sa campagne.
 *
 * ⚠️ LES RANGS SUIVANTS, EUX, N'ONT QUE LEUR LIGNE. Retomber sur les colonnes de la campagne quand un
 * champ y manque serait le défaut que tout ce lot ferme : un repli qui renvoie le message du rang 1.
 * Un étage de rang 2 sans contenu part donc vide, et c'est le sender ou Meta qui le dira.
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
 * L'ÉTAGE WHATSAPP DE CETTE CAMPAGNE, quand ce run sait le servir.
 *
 * 🔴 IL EST UNIQUE PAR CONSTRUCTION : `problemeDeChaine` refuse deux étages sur le même canal. C'est
 * ce qui permet de garder les pré-lectures de modèle (carousel, en-tête média, boutons tracés) EN AMONT
 * de la boucle, une seule fois par run, comme avant ce lot : il n'y a jamais deux modèles WhatsApp à
 * relire dans une même campagne.
 *
 * ⚠️ IL N'EST PAS FORCÉMENT LE RANG 1. Une campagne RCS avec repli WhatsApp met son modèle au rang 2, et
 * c'est SON corps qu'il faut relire, pas `campaign.templateName`, qui vaut alors la chaîne vide.
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

export async function runCampaign(campaign: Campaign, deps: EngineDeps): Promise<RunReport> {
  const now = deps.now ?? (() => Date.now());
  const t = deps.thresholds ?? DEFAULT_THRESHOLDS;
  const report: RunReport = { sent: 0, skipped: 0, failed: 0, paused: false };

  await deps.campaigns.setStatus(campaign.id, 'running');
  const pending = await deps.recipients.listPending(campaign.id);

  /**
   * LES CANAUX QUE CE RUN SAIT SERVIR.
   *
   * ⚠️ LE REPLI SUR `channelSender` / `rateLimiter` REPRODUIT EXACTEMENT L'ÉTAT D'AVANT CE LOT : une seule
   * entrée, celle du canal de la campagne. Un faux de test qui pose `channelSender` sur une campagne
   * WhatsApp obtient donc le même comportement qu'avant (envoi par le sender de canal, gardes Meta
   * neutralisées), et ce n'est pas un accident : c'est ce qui garde ces tests représentatifs.
   */
  const canaux: Partial<Record<CanalEtage, CanalServi>> = deps.canaux ?? {};
  if (!deps.canaux) {
    canaux[campaign.channel ?? 'whatsapp'] = {
      ...(deps.channelSender ? { sender: deps.channelSender } : {}),
      ...(deps.rateLimiter ? { rateLimiter: deps.rateLimiter } : {}),
      phoneNumberId: campaign.phoneNumberId,
    };
  }
  const canauxServis = Object.keys(canaux) as CanalEtage[];
  /** L'étage WhatsApp de la chaîne, s'il y en a un et que ce run sait le servir. Unique par construction. */
  const etageWa = etageWhatsApp(campaign, canauxServis);

  // Statut de SORTIE du run. Une campagne AU FIL DE L'EAU (alimentée par un webhook) n'est pas finie quand sa
  // file est vide : elle attend son prochain arrivant. La marquer `completed` la couperait définitivement de
  // son webhook (seules les campagnes `running` sont nourries), et personne ne le verrait avant de constater
  // que plus aucun lead n'est contacté. Elle repart donc en `running`.
  const statutFinal: CampaignStatus = campaign.webhookId ? 'running' : 'completed';

  /**
   * Le statut de sortie RÉEL, décidé au dernier moment.
   *
   * 🔴 MESURÉ AU BANC DE CHARGE le 2026-09-01, et c'était une perte SILENCIEUSE et DÉFINITIVE. Un `kill -9`
   * du worker en plein envoi laisse le destinataire en vol à l'état `sending`. Le run suivant ne le voit pas
   * (`listPending` ne rend que les `pending`), vide la file, et marque la campagne `completed`. Dix minutes
   * plus tard, `reclaimStale` remet ce destinataire en `pending`... sur une campagne TERMINÉE, que la reprise
   * ne relance plus (elle ne regarde que les `running`). Ce contact ne recevait jamais son message, et rien
   * ne le disait : les compteurs affichaient 399 envoyés sur 400 et la campagne se disait finie.
   *
   * On reste donc `running` tant qu'un destinataire est réservé. La reprise repassera après le reclaim.
   */
  const statutDeSortie = async (): Promise<CampaignStatus> => {
    if (statutFinal !== 'completed' || !deps.recipients.countSending) return statutFinal;
    return (await deps.recipients.countSending(campaign.id)) > 0 ? 'running' : 'completed';
  };

  // Carousel : les cartes (image, corps, boutons) sont IDENTIQUES pour tous les destinataires -> relues une
  // seule fois par run. Une lecture qui échoue (réseau, WABA absent) ne casse pas la campagne : on part comme
  // avant (un template sans carousel est inchangé ; un carousel échouera avec le message d'erreur de Meta).
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

  // En-tête média : même doctrine que le carousel, et même lecture UNE fois par run. Le visuel est identique
  // pour tous les destinataires, donc son `media id` aussi.
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
   * RÉSOUDRE UN DESTINATAIRE : le marquer ET journaliser la tentative, en UN seul geste.
   *
   * 🔴 UN SEUL POINT DE PASSAGE, PARCE QUE DEUX ÉCRITURES QUI DOIVENT S'ACCORDER NE DOIVENT PAS ÊTRE
   * APPELÉES SÉPARÉMENT. Un destinataire se résout à CINQ endroits de ce fichier (refus pré-boucle,
   * erreur d'envoi, écarté, scénario non démarré, succès) ; poser le journal à côté de chacun aurait fait
   * du journal une liste à tenir à la main, dont un site oublié ne produit aucune erreur, juste un canal
   * qui semble n'avoir jamais rien tenté. Depuis ce lot, `markResult` n'a plus qu'UN appelant, ici :
   * marquer sans journaliser est devenu impossible, et le prochain site l'héritera sans y penser.
   *
   * ⚠️ L'ORDRE COMPTE : on marque D'ABORD. Le journal ne doit jamais affirmer une tentative que la table
   * des destinataires ne connaît pas ; l'inverse (une marque sans sa ligne de journal) ne coûte qu'une
   * statistique, et c'est le sens de perte qu'on accepte.
   *
   * 🔴 LE RANG ET LE CANAL VIENNENT DE L'ÉTAGE DU DESTINATAIRE, plus d'un `RANG_INITIAL` en dur ni de
   * `campaign.channel`. Ce commentaire a affirmé le contraire, et c'était exact tant que rien n'écrivait
   * `etage_courant` ; depuis que la bascule l'écrit, une tentative refusée au rang 2 se serait journalisée
   * « rang 1, canal de la campagne », c'est-à-dire au crédit du canal qui n'a rien tenté. Le journal est la
   * SEULE source de l'analytique par canal : une ligne fausse ici est un chiffre faux à l'écran.
   *
   * ⚠️ `etageServable` est rappelée ici plutôt que passée en paramètre : elle est PURE et parcourt au plus
   * trois étages. Un paramètre de plus sur les cinq sites de résolution serait une liste à tenir à la main,
   * et c'est exactement ce que ce point de passage unique existe pour éviter.
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
   * LE MODÈLE WHATSAPP N'EST PAS ENVOYABLE : on le sait avant d'avoir commencé.
   *
   * ⚠️ LE REFUS NE VISE QUE LES DESTINATAIRES DE L'ÉTAGE WHATSAPP, PAS TOUTE LA CAMPAGNE. Un modèle dont
   * le carousel ou l'en-tête média est inenvoyable ne dit rien du repli RCS, et couper le run entier
   * priverait de leur message des destinataires qu'une bascule a précisément amenés là parce que le
   * premier canal avait échoué. Ils repartent donc dans la boucle normale.
   *
   * ⚠️ Le reste est INCHANGÉ, et sa raison aussi : le refus est traité ICI et pas dans la boucle, sinon la
   * porte de qualité verrait 100 % d'échecs et mettrait la campagne en pause au bout de 20 destinataires,
   * avec un diagnostic trompeur.
   */
  let aTraiter = pending;
  if (carouselBlocked !== null || headerBlocked !== null) {
    const reason = carouselBlocked !== null ? `Carousel non envoyable : ${carouselBlocked}` : `Template non envoyable : ${headerBlocked}`;
    const restants: Recipient[] = [];
    for (const r of pending) {
      if (r.status === 'sent') continue;
      if (etageServable(campaign, r.etageCourant, canauxServis).canal !== 'whatsapp') { restants.push(r); continue; }
      if (!(await deps.recipients.claim(r.id))) continue;
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
   * L'ATTRIBUTION DES CLICS (migration 0106) : quels boutons portent un suffixe variable, et quel jeton
   * chaque destinataire doit y mettre.
   *
   * 🔴 DEUX LECTURES, LES DEUX EN AMONT DE LA BOUCLE. Les boutons tracés sont les mêmes pour toute la
   * campagne ; les jetons se chargent en UN énoncé pour tous les destinataires. Les lire par destinataire
   * ferait deux requêtes par message, sur le chemin le plus chaud du produit.
   *
   * ⚠️ Et les deux sont BEST-EFFORT. Une attribution qui échoue doit coûter la connaissance de « qui a
   * cliqué », jamais l'envoi lui-même : un client préfère mille fois un message parti sans mesure qu'une
   * campagne bloquée par une statistique.
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
      console.error('attribution des clics ignorée pour cette campagne:', err instanceof Error ? err.message : err);
      boutonsAJeton = [];
    }
  }
  /**
   * Les jetons, chargés en UN énoncé pour tous les destinataires, si l'un des deux canaux en a besoin.
   *
   * 🔴 Côté WhatsApp, la lecture des boutons est OBLIGATOIRE et décide de l'envoi : l'URL soumise à Meta
   * porte (ou non) un `{{1}}`, et fournir un composant à contretemps fait échouer l'appel avec un 132000.
   * Côté RCS, l'URL est écrite à l'envoi : il n'y a rien à accorder, donc rien à relire. C'est le message
   * lui-même qui dit s'il porte un lien traçable, et le sender de canal l'a calculé une fois pour toutes
   * (`aBesoinDeJeton`) plutôt que de le recalculer par destinataire.
   *
   * ⚠️ UNE CHAÎNE PEUT AVOIR BESOIN DES DEUX, et c'était le piège de la version d'avant : ses deux branches
   * étaient EXCLUSIVES (`else if`), donc une campagne WhatsApp à repli RCS aurait chargé les jetons pour le
   * premier canal et pas pour le second, ou l'inverse. Un seul `ou` suffit, la table est la même.
   */
  const besoinDeJeton = boutonsAJeton.length > 0 || canaux.rcs?.sender?.aBesoinDeJeton === true;
  if (besoinDeJeton && deps.jetonsPourContacts) {
    try {
      jetons = await deps.jetonsPourContacts(campaign.tenantId, idsDesContacts());
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('attribution des jetons de clic ignorée pour cette campagne:', err instanceof Error ? err.message : err);
    }
  }

  // Horloge du contrôle d'arrêt. Partie à MAINTENANT, donc la première relecture n'a lieu qu'un pas plus tard :
  // on vient d'écrire `running` deux lignes plus haut, relire tout de suite ne pourrait rien apprendre.
  const pasDeControle = deps.statusPollMs ?? DEFAULT_STATUS_POLL_MS;
  let dernierControle = now();
  // Horloge du LOT : un run travaille au plus `dureeMaxMs`, puis rend la main et se fait réenfiler.
  const debutDuLot = now();

  // Horaires d'ouverture : lus UNE FOIS, et seulement si la campagne les demande. Une lecture en échec vaut
  // « pas de contrainte » plutôt que « campagne bloquée » : le réglage sert à choisir un moment, pas à
  // garder une porte, et une panne de sa lecture ne doit pas retenir un envoi que le client a lancé.
  const horaires = campaign.businessHoursOnly === true && deps.horairesOuvres
    ? await deps.horairesOuvres(campaign.tenantId).catch(() => null)
    : null;

  for (const r of aTraiter) {
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

    // HORS DES HEURES D'OUVERTURE (migration 0122). Même forme que l'arrêt du service juste au-dessus :
    // contrôlé AVANT toute réservation, donc le destinataire suivant n'est ni claimé ni envoyé et reste
    // `pending`. La différence tient en une chose, et c'est tout l'intérêt : on POSE l'instant de reprise,
    // donc le balayage de la migration 0103 relancera la campagne à l'ouverture, sans clic.
    //
    // 🔴 Contrôlé à CHAQUE destinataire, pas seulement au démarrage. Les deux cas que Julien a décrits sont
    // le même code : « lancée à 23 h » (le tout premier tour ferme) et « pas finie à la fermeture » (un tour
    // du milieu ferme). Un contrôle placé avant la boucle n'aurait couvert que le premier.
    if (horaires !== null && !withinBusinessHours(new Date(now()), horaires.timeZone, horaires.businessHours)) {
      // `null` = aucun jour ouvert de la semaine. Pas de reprise automatique possible, donc pas d'échéance :
      // exactement la sémantique d'une pause de qualité, et le message le dit à l'opérateur.
      const reprise = prochaineOuverture(new Date(now()), horaires.timeZone, horaires.businessHours);
      report.paused = true;
      report.reason = messageDePause('hors_horaires', reprise, undefined);
      await deps.campaigns.setStatus(campaign.id, 'paused', { raison: 'hors_horaires', reprise });
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

    /**
     * L'ÉTAGE DE CE DESTINATAIRE, ET CE QU'IL FAUT POUR LE SERVIR.
     *
     * 🔴 RÉSOLU EN TÊTE DU TOUR, PARCE QUE QUATRE DÉCISIONS EN DÉPENDENT AVANT MÊME L'ENVOI : la porte
     * de qualité (une notion Meta, qui n'a pas de sens sur un étage RCS), le frein de cadence (le plafond
     * du canal de l'étage, pas celui de la campagne), le contenu, et le journal. Le calcul est PUR et
     * parcourt au plus trois étages.
     *
     * ⚠️ LE REFUS, LUI, RESTE APRÈS LE CLAIM : marquer un destinataire suppose de l'avoir réservé.
     */
    const etageDuTour = etageServable(campaign, r.etageCourant, canauxServis);
    const servi = canaux[etageDuTour.canal];

    // Quality gate : notion META (rating du numéro WABA). Sur un canal sans numéro Meta, il n'y a rien à
    // interroger, et l'interroger quand même appellerait Graph avec un phoneNumberId vide.
    // ⚠️ C'est la présence d'un SENDER DE CANAL qui la neutralise, pas le nom du canal : c'est ce qui garde
    // le comportement d'avant pour un faux de test qui pose `channelSender` sur une campagne WhatsApp.
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

    // 🔴 LE REFUS S'IL N'EST PAS SERVABLE (cf. `etageServable`). Placé APRÈS le claim parce qu'il faut
    // avoir réservé le destinataire pour le marquer, et AVANT le frein de cadence parce qu'un refus
    // n'occupe aucun créneau d'envoi : il ne part rien.
    if (etageDuTour.refus !== null || !servi) {
      const refus = etageDuTour.refus ?? `étage ${etageDuTour.rang} (${etageDuTour.canal}) : ce run ne sait pas envoyer sur ce canal`;
      await resoudre(r, { status: 'failed', error: refus });
      report.failed += 1;
      continue;
    }

    // 🔴 LE FREIN EST CELUI DU CANAL DE L'ÉTAGE, PAS CELUI DE LA CAMPAGNE. Un étage RCS sous le plafond
    // qu'impose Meta à un NUMÉRO WhatsApp est exactement le défaut que le lot 4 a fermé : ne pas le rouvrir
    // par le bas en faisant tenir la cadence d'un canal par la contrainte d'un autre.
    if (servi.rateLimiter) await servi.rateLimiter.acquire();

    /** Ce que CET étage envoie. Le rang 1 vient des colonnes de la campagne (invariant 0134). */
    const contenu = contenuDeLEtage(campaign, etageDuTour.rang);

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
      if (servi.sender) {
        // Le jeton de CE destinataire, pour que le clic sur un lien du message dise QUI a réagi. Absent
        // (contact inconnu, chargement en échec) : le lien part tracé mais anonyme, jamais cassé.
        const out = await servi.sender.sendTo(r, r.contactId ? jetons.get(r.contactId) : undefined);
        if ('skipped' in out) {
          skipped = out.skipped;
          res = { messageId: '' };
        } else {
          res = out;
        }
      } else if (contenu.workflowId && campaign.startNodeId) {
        // Campagne NODE (/v1/sends) : on démarre le workflow à un BLOC PRÉCIS. Les destinataires hors fenêtre
        // 24 h ont déjà été écartés (`out_of_window`) à la création, donc l'envoi de session est légitime ici.
        if (!deps.startWorkflowFromNode) throw new Error('startWorkflowFromNode non câblé');
        const waId = waIdOfTarget(r.toE164);
        const started = await deps.startWorkflowFromNode(campaign.tenantId, contenu.workflowId, campaign.startNodeId, waId, r.contactId);
        // Une CHAÎNE porte la raison exacte du refus : on l'affiche telle quelle plutôt que d'énumérer les
        // causes possibles et de laisser l'opérateur deviner laquelle s'applique.
        if (typeof started === 'string') notStarted = `Scénario non démarré : ${started}`;
        else if (started === false) notStarted = 'scénario non démarré (bloc de départ indisponible, ou fil repris par un opérateur / MBA)';
        res = { messageId: `wf-${contenu.workflowId}` };
      } else if (contenu.workflowId) {
        // Campagne WORKFLOW : on DÉMARRE le workflow pour ce destinataire (il applique les blocs sync +
        // envoie son 1er template). message_id synthétique (le wamid réel vit dans le run du workflow).
        // wa_id du run = numéro en chiffres nus (comme le webhook) OU BSUID tel quel (jamais dénaturé).
        if (!deps.startWorkflow) throw new Error('startWorkflow non câblé');
        const waId = waIdOfTarget(r.toE164);
        // r.resolvedParams = variables du 1er template résolues à la construction (paramMapping de la campagne).
        // On les passe telles quelles : l'envoi du 1er template n'a PAS à re-résoudre via les hints stockés.
        const started = await deps.startWorkflow(campaign.tenantId, contenu.workflowId, waId, r.contactId, params);
        if (typeof started === 'string') notStarted = `Scénario non démarré : ${started}`;
        else if (started === false) notStarted = 'scénario non lançable (ouverture hors fenêtre 24 h, scénario supprimé, ou fil repris par un opérateur / MBA)';
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
            // 🔴 Le suffixe de CE destinataire sur chaque bouton tracé. Sans jeton (contact inconnu, lecture
            // en échec), AUCUN composant n'est produit : envoyer un composant vide ferait échouer l'appel
            // avec un 132000, alors que ne rien envoyer ne coûte que la mesure de ce message-là.
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
      const raison = raisonDePause(err);
      if (raison !== undefined) {
        await deps.recipients.relacher(r.id);
        report.paused = true;
        // Le délai vient du `Retry-After` de Meta quand il existe (c'est lui qui sait), borné. La qualité,
        // elle, ne donne AUCUN instant de reprise : un humain doit regarder avant de relancer.
        const reprise = instantDeReprise(raison, err instanceof MetaApiError ? err.retryAfterMs : undefined, (deps.now ?? Date.now)());
        report.reason = messageDePause(raison, reprise, errorCode);
        await deps.campaigns.setStatus(campaign.id, 'paused', { raison, reprise });
        return report;
      }

      await resoudre(r, { status: 'failed', error: msg, ...(errorCode !== undefined ? { errorCode } : {}) });
      report.failed += 1;
      continue;
    }

    // Le workflow n'a pas démarré : AUCUN message n'est parti pour ce destinataire. On le marque en échec (avec
    // la raison) au lieu de le compter en `sent` : une campagne « 500 envoyés, 0 échec » alors que rien n'est
    // parti est un mensonge affiché, et il masque la vraie cause (fil repris, scénario devenu non lançable).
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

    // Message livré. On persiste le succès HORS du catch d'envoi : une erreur de
    // persistance ne relabellise pas un message livré en `failed` (ça fausserait le
    // dénominateur du quality gate). Le destinataire est déjà en `sending` (claimé), donc
    // même si markResult échoue et que le job est rejoué, il ne sera pas ré-envoyé.
    const at = now();
    report.sent += 1;
    await resoudre(r, { status: 'sent', messageId: res.messageId, sentAt: at });
    await deps.frequency.record(campaign.tenantId, r.toE164, at);

    // Ce contact est joignable en WhatsApp : Meta a accepté le message et rendu un wamid.
    //
    // 🔴 LA CONDITION EST CELLE DE `recordOutbound` JUSTE EN DESSOUS, ET POUR LA MÊME RAISON : c'est la
    // seule branche où un template WhatsApp est VRAIMENT parti d'ici. `channelSender` présent veut dire
    // RCS, qui ne dit rien de WhatsApp ; une campagne de scénario rend un `messageId` synthétique `wf-...`
    // et délègue l'envoi réel ailleurs. Écrire « oui » sur l'une ou l'autre serait inventer une mesure.
    //
    // ⚠️ Best-effort, exactement comme le journal du fil : un échec d'écriture ne relabellise JAMAIS un
    // message livré, et le pire qu'il coûte est un verdict qui reste `inconnu`, ce qui n'exclut personne.
    if (deps.noterJoignabilite && !contenu.workflowId && !servi.sender && etageDuTour.canal === 'whatsapp' && r.contactId) {
      try {
        await deps.noterJoignabilite(campaign.tenantId, r.contactId, true);
      } catch {
        /* best-effort : ne casse jamais l'envoi réussi */
      }
    }

    // Journalise le template envoyé dans le fil de conversation (fil d'inbox complet + transcript d'analyse).
    // UNIQUEMENT pour un envoi template DIRECT : la branche workflow a un messageId synthétique `wf-...`, le vrai
    // template est loggé par le worker à l'envoi réel. Best-effort : un échec de log ne relabellise pas l'envoi.
    // Le fil est UNIQUE par contact : un envoi RCS s'y journalise comme un template WhatsApp, avec son canal.
    // Sans ça, l'opérateur ouvre le fil d'un client et ne voit AUCUNE trace de ce qui vient de lui être
    // envoyé. Le libellé diffère parce que le RCS n'a pas de template : on journalise le message lui-même.
    if (deps.recordOutbound && !contenu.workflowId) {
      const waId = waIdOfTarget(r.toE164);
      const rcs = servi.sender !== undefined;
      const body = rcs
        ? rcsCampaignBody(contenu.rcsMessage)
        : `Template « ${contenu.templateName} »${params.length > 0 ? ` (${params.join(', ')})` : ''}`;
      try {
        await deps.recordOutbound(campaign.tenantId, waId, {
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
  }

  await deps.campaigns.setStatus(campaign.id, await statutDeSortie());
  return report;
}
