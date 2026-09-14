import type { Pool } from 'pg';
import { config } from '../config';
import { PgWorkflowRunStore } from './run-store.pg';
import { creerAppelHttpScenario } from './appel-http';
import { executerFonctionJs } from './fonction-js';
import { PgSourceStore } from '../agent/sources.pg';
import { PgRequeteStore } from '../agent/requetes.pg';
import { PgJournalAppels } from '../agent/catalog.pg';
import { PgWorkflowStore } from './store.pg';
import { PgWorkflowNodeEventStore } from './node-events.pg';
import { PgTagStore } from '../crm/tag-store.pg';
import { PgTemplateHintStore } from '../crm/template-hints.pg';
import { PgContactStore } from '../crm/contact-store.pg';
import { PgInboxStore } from '../inbox/store.pg';
import { PgTenantSettingsStore } from '../settings/store.pg';
import { PgCampaignRepo } from '../campaign/store.pg';
import { countTemplateVariables } from '../crm/template';
import { logTemplateSent } from '../inbox/outbound-log';
import { MetaMediaClient } from '../meta/media';
import { MetaClientFactory } from '../meta/factory';
import { MetaCredentialsResolver } from '../meta/credentials';
import { TemplateMediaPreparer } from '../meta/template-media';
import { carouselSendBlocker, headerMediaSendBlocker } from '../meta/template-components';
import type { OutboundCarouselCard } from '../meta/template-components';
import { buildWorkflowTemplateComponents } from './template-send';
import { WorkflowExecutor } from './executor';
import { problemeLienBouton } from './engine';
import { buildRcsStack } from '../rcs/factory';
import { urlRappelRcs } from '../rcs/callback';
import { waIdOfTarget } from '../crm/identity';
import { PgRcsAgentStore } from '../rcs/store.pg';
import { PgTrackedLinkStore } from '../links/tracked-links.pg';
import { TraceurLiensRcs } from '../links/traceur-rcs';
import { fabriquerJeton } from '../links/jeton-contact';
import { newTrackingCode } from '../ids/code';
import { decryptSecret } from '../crypto/secretbox';
import { enfilerEvenementAutomation, type AutomationEventJob } from '../automation/event-job';
import { AGENT_TURN_QUEUE, type AgentTurnJob } from '../agent/turn-job';
import { PgAgentSessionStore } from '../agent/session-store.pg';
import { creerPoserTagAgent } from '../agent/poser-tag';
import type { PgEmailTemplateStore } from '../email/template-store.pg';
import type { EmailAccountResolver } from '../email/resolver';
import { sendSmtpEmail } from '../email/smtp';
import { renderText, contactVars } from '../crm/render';
import { adressesDestinataires, type SendEmailAction } from './engine';
// La MÊME décision que sur le chemin des campagnes : un template tracé exige ses composants de bouton, quel
// que soit le chemin d'envoi. On importe la règle plutôt que d'en écrire une seconde qui divergera.
import { suffixesPourDestinataire } from '../campaign/engine';
import { creerRendreLeFil, creerPrendreLeFil } from '../inbox/controle-du-fil';

/**
 * Câblage de l'exécuteur de scénarios : la vingtaine de dépendances IO qu'il réclame (contacts, tags, envois
 * Meta, caches de templates, visuels de carousel, publication d'événements d'automation).
 *
 * Pourquoi ce module existe : DEUX processus doivent exécuter un scénario. Le worker (réponse d'un contact,
 * campagne, réveil d'une attente) et l'API (un opérateur lance un scénario depuis l'Inbox et doit savoir TOUT
 * DE SUITE si c'est parti, sinon pourquoi). Un second câblage recopié serait le troisième doublon de cette
 * famille : le constructeur de composants Meta puis la préparation des visuels de carousel ont chacun causé
 * un bug de production le 2026-08-15, précisément parce qu'ils existaient en deux exemplaires.
 *
 * ⚠️ Les caches restent PAR PROCESS (templates, WABA, media ids, token) : chaque appelant a les siens. C'est
 * assumé, borné par des TTL courts, et Meta reste la source de vérité. Ce module ne prétend pas les partager.
 */
export interface WorkflowRuntimeDeps {
  pool: Pool;
  /** File pg-boss : publie « tag ajouté » pour les automations, et les TOURS d'agent. Aucun `work` ici : ce
   *  module ne fait qu'émettre, la consommation appartient au worker. */
  /**
   * La file, réduite à ce que le câblage en fait. ⚠️ Les OPTIONS sont déclarées, et ce n'est pas décoratif :
   * sans elles, un appelant qui passe une clé de groupe la voit disparaître en silence, donc son job échappe
   * au plafond par espace. C'est la même famille d'erreur que le passe-plat du 131008.
   */
  queue: { enqueue(name: string, data: unknown, opts?: { groupId?: string; expireInSeconds?: number }): Promise<void> };
  /** DRY_RUN : aucun appel Meta. ⚠️ À passer explicitement : l'oublier ferait envoyer pour de vrai. */
  dryRun: boolean;
  repo: PgCampaignRepo;
  contactStore: PgContactStore;
  inboxStore: PgInboxStore;
  settingsStore: PgTenantSettingsStore;
  workflowStore: PgWorkflowStore;
  /** Résolveur de token PAR TENANT. On le REÇOIT (au lieu de le reconstruire) pour ne pas dupliquer son cache. */
  metaCredentials: MetaCredentialsResolver;
  metaFactory: MetaClientFactory;
  /** Provider du canal RCS (`config.RCS_PROVIDER`). Passé explicitement, comme `dryRun` : ce module ne lit pas
   *  la config, ses appelants la lui donnent. */
  rcsProvider: 'fake' | 'smsmode' | 'google';
  /** Modèles d'email (Contenu, Task 3) : chargés par id à l'envoi du bloc « Envoi de mail » (sujet + corps à
   *  rendre avec les variables du contact). */
  emailTemplates: PgEmailTemplateStore;
  /** Résolveur de transport SMTP par boîte (Task 5), cache le transport tant que la boîte n'est pas modifiée.
   *  On le REÇOIT (comme `metaCredentials`) pour ne pas dupliquer son cache : les routes email (Task 6)
   *  l'invalident à chaque écriture d'un compte, l'exécuteur doit voir la MÊME instance. */
  emailResolver: EmailAccountResolver;
}

/** Construit l'exécuteur et ce qui l'accompagne. Une seule fois par process (les caches vivent dedans). */
export function buildWorkflowRuntime(deps: WorkflowRuntimeDeps) {
  const { pool, queue, dryRun, repo, contactStore, inboxStore, settingsStore, workflowStore, metaCredentials, metaFactory, rcsProvider, emailTemplates, emailResolver } = deps;
  const nodeEvents = new PgWorkflowNodeEventStore(pool);
  const runStore = new PgWorkflowRunStore(pool);
  // Pile RCS montée ICI, et une seule fois : l'exécuteur (bloc de scénario) et le worker (campagnes) doivent
  // partager le MÊME sender, donc le même cache de joignabilité et le même provider.
  const agentsRcs = new PgRcsAgentStore(pool);
  const trackedLinks = new PgTrackedLinkStore(pool);
  const rcsStack = buildRcsStack(pool, rcsProvider, dryRun, {
    apiKey: config.SMSMODE_RCS_API_KEY,
    // Clé PROPRE au workspace, déchiffrée à la volée. C'est elle qui prime : la clé d'environnement n'est
    // plus qu'un repli pour le workspace historique qui n'a pas encore fait son activation.
    apiKeyFor: (tenant) => agentsRcs.apiKeyFor(tenant, (enc) => decryptSecret(enc, config.ENCRYPTION_KEY)),
    ...(config.SMSMODE_CALLBACK_STATUS_URL ? { callbackUrlStatus: config.SMSMODE_CALLBACK_STATUS_URL } : {}),
    ...(config.SMSMODE_CALLBACK_MO_URL ? { callbackUrlMo: config.SMSMODE_CALLBACK_MO_URL } : {}),
    // Adresse de rappel PROPRE au workspace, posée sur chaque envoi. C'est elle qui fait exister les rapports
    // de livraison (donc la sortie « non joignable » du bloc) et les réponses aux boutons : sans elle, un
    // message part et l'on n'apprend plus jamais rien de son sort.
    callbackUrlFor: async (tenant) => {
      const code = await agentsRcs.webhookCodePour(tenant);
      return code ? urlRappelRcs(config.APP_URL, code) : null;
    },
  },
  // Variables `{{champ}}` d'une CAMPAGNE RCS. `waIdOfTarget` et pas le E.164 brut : un contact se résout sur
  // son wa_id (chiffres nus), et un « + » en tête ne trouverait jamais personne.
  async (tenant, e164) => contactVars(await contactStore.getResolvableByPhone(tenant, waIdOfTarget(e164)) ?? {}),
  // Traçage des liens des messages RCS (migration 0107), monté ICI et une seule fois : son cache
  // adresse -> code doit être partagé par les campagnes et les scénarios, sinon chaque chemin refait les
  // mêmes allocations. Branché au point d'envoi unique, il couvre les quatre chemins d'un coup.
  new TraceurLiensRcs(trackedLinks, config.APP_URL, newTrackingCode),
  );
  const tagStore = new PgTagStore(pool);
  const hintStore = new PgTemplateHintStore(pool);

  // Cache court du corps live d'un template (nb de variables N + exemples) par WABA|nom|langue : évite un appel
  // Meta list() par destinataire d'une campagne workflow. TTL court -> tolère un template édité en cours de route.
  // Porte AUSSI les cartes du carousel : Meta exige l'image de chaque carte À CHAQUE ENVOI (elle n'est pas dans
  // le template), et les URL renvoyées portent une expiration -> TTL court, relues régulièrement, jamais figées.
  // Porte AUSSI l'en-tête média, pour la même raison que les cartes : Meta l'exige à chaque envoi et l'URL expire.
  type TplInfo = {
    count: number;
    carousel?: { cards: OutboundCarouselCard[] };
    headerFormat?: 'IMAGE' | 'VIDEO' | 'DOCUMENT';
    headerMediaUrl?: string;
    /**
     * 🔴 La catégorie Meta, EN MINUSCULES, et elle n'a jamais coûté un appel : `tplClient.list` demande
     * déjà `category` dans ses `fields` (`src/meta/templates.ts`) et la rend. Ce type la JETAIT, donc un
     * template envoyé par un scénario partait sans catégorie, donc sans coût calculable, et l'écran
     * affichait zéro sans le dire. Meta rend 'MARKETING'/'UTILITY' en majuscules, la base stocke en
     * minuscules côté campagne : on aligne ICI plutôt que dans chaque lecteur.
     */
    category?: string;
  };
  const tplVarCache = new Map<string, { at: number } & TplInfo>();
  const TPL_CACHE_MS = 5 * 60_000;
  // `count` = MAX des positions {{n}} (cf. countTemplateVariables) : « {{1}} ... {{3}} » attend 3 params pour Meta,
  // pas 2. null = indéterminable (WABA absent / template introuvable / réseau) -> l'appelant NE PAS envoyer.
  // WABA du tenant, mémoïsé au même TTL : `templateVarInfo` est appelé PAR DESTINATAIRE sur une campagne
  // scénario, et sans ça chaque envoi payait un SELECT avant même de regarder le cache de templates.
  const wabaCache = new Map<string, { at: number; waba: string | null }>();
  const tenantWabaId = async (tenant: string): Promise<string | null> => {
    const hit = wabaCache.get(tenant);
    if (hit && Date.now() - hit.at < TPL_CACHE_MS) return hit.waba;
    const waba = await repo.getTenantWabaId(tenant);
    wabaCache.set(tenant, { at: Date.now(), waba });
    return waba;
  };
  /**
   * Préparation des visuels d'un template (re-téléversement -> `media id`), pour les cartes d'un carousel comme
   * pour l'en-tête média. UNE seule implémentation dans le projet (`meta/template-media.ts`), partagée avec
   * l'API qui en a besoin pour l'envoi depuis l'inbox. L'instance porte son cache : créée UNE fois, et un même
   * visuel servant aux deux usages ne se téléverse qu'une fois.
   */
  const templateMedia = new TemplateMediaPreparer({
    getPhoneNumberId: (tenant) => repo.getTenantPhoneNumberId(tenant),
    mediaClientFor: async (tenant) => {
      const { token } = await metaCredentials.resolveForTenant(tenant);
      return new MetaMediaClient(token, config.META_APP_ID, config.META_GRAPH_VERSION);
    },
  });
  const prepareCarouselMedia = (tenant: string, cards: OutboundCarouselCard[]): Promise<OutboundCarouselCard[]> =>
    templateMedia.prepare(tenant, cards);
  const prepareHeaderMedia = (tenant: string, mediaUrl: string): Promise<string | null> =>
    templateMedia.prepareOne(tenant, mediaUrl);

  /**
   * Visuels d'un template PRÊTS pour l'envoi (cartes de carousel ET en-tête média), ou la RAISON du refus.
   *
   * Factorisé, et ça n'est pas cosmétique : les deux branches de `sendTemplate` (variables déjà résolues d'une
   * campagne, ou résolution par hints après une réponse) doivent se comporter à l'identique. C'est leur
   * divergence qui a laissé le carousel non branché côté campagne (2026-08-15), puis l'en-tête média non
   * branché côté campagne scénario (relevé en revue le 2026-08-17). Une seule source, plus d'écart possible.
   *
   * `info` null (lecture du template en échec) -> aucun visuel et aucun refus : on part comme avant, un
   * template sans visuel n'est jamais bloqué par une panne de lecture.
   */
  type VisuelsEnvoi = { carousel?: { cards: OutboundCarouselCard[] }; headerMediaId?: string; headerFormat?: 'IMAGE' | 'VIDEO' | 'DOCUMENT' };
  const visuelsPourEnvoi = async (tenant: string, info: TplInfo | null): Promise<{ refus: string } | VisuelsEnvoi> => {
    const carousel = info?.carousel ? { cards: await prepareCarouselMedia(tenant, info.carousel.cards) } : undefined;
    const refusCarousel = carousel ? carouselSendBlocker(carousel.cards) : null;
    if (refusCarousel !== null) return { refus: refusCarousel };
    // Un carousel porte ses visuels PAR CARTE : pas d'en-tête top-level à préparer ni à exiger.
    if (carousel) return { carousel };
    const headerMediaId = info?.headerMediaUrl ? await prepareHeaderMedia(tenant, info.headerMediaUrl) : null;
    const refusHeader = headerMediaSendBlocker(info?.headerFormat, headerMediaId ?? undefined);
    if (refusHeader !== null) return { refus: refusHeader };
    return headerMediaId ? { headerMediaId, ...(info?.headerFormat ? { headerFormat: info.headerFormat } : {}) } : {};
  };

  const templateVarInfo = async (tenant: string, name: string, language: string): Promise<TplInfo | null> => {
    const waba = await tenantWabaId(tenant);
    if (!waba) return null;
    const key = `${waba}|${name}|${language}`;
    const cached = tplVarCache.get(key);
    if (cached && Date.now() - cached.at < TPL_CACHE_MS) {
      const { at: _at, ...info } = cached;
      return info;
    }
    const tplClient = await metaFactory.templateClientForTenant(tenant); // token PAR TENANT (B1), repli global en sommeil
    const list = await tplClient.list(waba);
    // Exact (nom + langue), sinon repli sur le nom seul (langue par défaut d'un template mono-langue).
    const tpl = list.find((t) => t.name === name && t.language === language) ?? list.find((t) => t.name === name);
    if (!tpl) return null;
    const media = tpl.headerFormat === 'IMAGE' || tpl.headerFormat === 'VIDEO' || tpl.headerFormat === 'DOCUMENT'
      ? tpl.headerFormat
      : undefined;
    const info: TplInfo = {
      count: countTemplateVariables(tpl.body),
      ...(tpl.category ? { category: tpl.category.toLowerCase() } : {}),
      ...(tpl.carousel ? { carousel: tpl.carousel } : {}),
      ...(media ? { headerFormat: media } : {}),
      ...(tpl.headerMediaUrl ? { headerMediaUrl: tpl.headerMediaUrl } : {}),
    };
    tplVarCache.set(key, { at: Date.now(), ...info });
    return info;
  };

  // Contexte d'évaluation du contact (état CRM + fuseau/horaires du tenant). Partagé par les blocs `condition`
  // d'un scénario ET par le filtre `conditionGroup` d'une automation : une seule définition, même sémantique.
  const buildEvalContext = async (tenant: string, waId: string, besoins?: { derniereSaisie: boolean }) => {
    const state = await contactStore.getContactStateByWaId(tenant, waId);
    if (!state) return null;
    const settings = await settingsStore.get(tenant);
    // ⚠️ Lue SEULEMENT si un bloc la réclame (l'exécuteur le dit depuis le graphe) : c'est une requête de
    // plus, et l'immense majorité des scénarios n'en a que faire. Un échec ici ne doit pas couler le
    // contexte entier : le bloc posera alors une valeur vide, ce qui est le comportement d'une donnée
    // absente, et non celui d'une valeur inventée.
    const derniereSaisie = besoins?.derniereSaisie
      ? await inboxStore.derniereSaisieDuContact(tenant, waId).catch(() => null)
      : null;
    return { ...state, now: new Date(), timeZone: settings.timezone, businessHours: settings.businessHours, derniereSaisie };
  };

  /**
   * L'APPEL META, sans la bascule locale.
   *
   * ⚠️ Les deux sont séparés délibérément : chaque appelant connaît l'état qu'il attendait avant de basculer
   * (`only: ['app_workflow']` pour le scénario, `only: ['app_human']` pour le balayage de reprise). Une fonction
   * qui ferait les deux avec un `only` figé échouerait EN SILENCE chez le second appelant, qui a déjà basculé.
   */
  // ⚠️ EXTRAIT dans `src/inbox/controle-du-fil.ts` le 2026-09-10 : ce geste vivait ici, dans une fermeture,
  // donc atteignable du WORKER seulement. Le bouton « rendre la main » de l'Inbox est servi par l'API et ne
  // pouvait pas l'appeler, ce qui a laissé Meta croire que NOUS tenions le fil pendant que l'écran annonçait
  // le contraire. Le module est le point de passage des deux processus.
  const releaseThreadChezMeta = creerRendreLeFil({
    numeroDuTenant: (t) => repo.getTenantPhoneNumberId(t),
    clientMba: (t) => metaFactory.mbaClientForTenant(t),
  });

  /**
   * PRENDRE le fil chez Meta, le jumeau de `releaseThreadChezMeta`, ajouté le 2026-09-14.
   *
   * 🔴 IL MANQUAIT, ET SON ABSENCE A FAIT RÉPONDRE L'AGENT DE META À LA PLACE D'UN SCÉNARIO. Le correctif
   * du 2026-09-11 a posé ce geste sur le BOUTON « Reprendre la main » de l'Inbox, et seulement sur lui.
   * `reclaimControl`, juste en dessous, continuait de n'écrire que NOTRE colonne, alors que son commentaire
   * annonçait qu'on reprenait le fil « même tenu par MBA ». Meta n'en savait rien et continuait de router
   * les entrants vers son agent. C'est le motif « une capacité câblée sur un consommateur sur deux », déjà
   * payé plusieurs fois dans ce dépôt.
   */
  const takeThreadChezMeta = creerPrendreLeFil({
    numeroDuTenant: (t) => repo.getTenantPhoneNumberId(t),
    clientMba: (t) => metaFactory.mbaClientForTenant(t),
  });

  /**
   * Envoi réel du bloc « Envoi de mail » (Task 8). Résout le modèle et la boîte SMTP, calcule le destinataire,
   * rend les variables `{{champ}}` (sujet toujours en texte, corps en HTML seulement si le modèle est 'html'),
   * envoie via SMTP. `apply` (executor.ts) est la SEULE garante du best-effort (try/catch autour de cet appel) :
   * ici on se contente de journaliser et sortir SANS LEVER sur un cas attendu (modèle ou boîte supprimé depuis
   * la sauvegarde du scénario, tables en suppression douce ; destinataire vide).
   */
  const sendEmail = async (tenant: string, waId: string, action: SendEmailAction): Promise<string | void> => {
    const template = await emailTemplates.getById(tenant, action.templateId);
    if (!template) {
      // eslint-disable-next-line no-console
      console.error(`workflow sendEmail: modèle ${action.templateId} introuvable pour ${tenant}, envoi ignoré`);
      return 'le modèle de mail de ce bloc n’existe plus';
    }
    const resolved = await emailResolver.getTransport(tenant, action.emailAccountId);
    if (!resolved) {
      // eslint-disable-next-line no-console
      console.error(`workflow sendEmail: boîte ${action.emailAccountId} introuvable pour ${tenant}, envoi ignoré`);
      return 'la boîte d’envoi de ce bloc n’existe plus, ou n’est pas choisie';
    }
    // Contact résolu ICI, comme `sendTemplate` le fait pour ses propres variables (contactVars a besoin des
    // champs du contact pour {{prenom}} etc., que le destinataire soit littéral ou une variable). `apply` ne
    // porte qu'un waId, jamais un contact déjà résolu. Hors base -> objet vide (variables système à null).
    const contact = await contactStore.getResolvableByPhone(tenant, waId);
    const vars = contactVars(contact ?? {});
    const adresses = adressesDestinataires(action.to, vars);
    if (adresses.length === 0) {
      // eslint-disable-next-line no-console
      console.error(`workflow sendEmail: aucun destinataire résolu pour ${waId} (${tenant}), envoi ignoré`);
      // Cas vécu le 2026-08-25 : le bloc visait le champ « mail », vide, alors que le contact avait « email ».
      return 'aucune adresse : le champ choisi est vide sur cette fiche contact';
    }
    const html = template.format === 'html';
    // Le 1er en « À », les suivants en COPIE CACHÉE : les destinataires peuvent être des clients et ne doivent
    // pas voir les adresses les uns des autres (décision produit du 2026-08-25). Les mettre tous en « À » les
    // exposerait mutuellement, ce qui est une fuite de données personnelles, pas un détail de présentation.
    const [premier, ...caches] = adresses;
    await sendSmtpEmail(resolved.transport, resolved.account, {
      to: premier as string,
      ...(caches.length > 0 ? { bcc: caches } : {}),
      subject: renderText(template.subject, vars, { html: false }),
      ...(html
        ? { html: renderText(template.body, vars, { html: true }) }
        : { text: renderText(template.body, vars, { html: false }) }),
    });
  };

  // Les sessions d'agent : partagées avec le worker, qui les REÇOIT de ce module plutôt que d'en construire
  // un second exemplaire. Deux instances ne se contrediraient pas (elles sont sans état), mais deux points de
  // construction finissent toujours par diverger sur une option.
  const agentSessions = new PgAgentSessionStore(pool);

  const workflowExecutor = new WorkflowExecutor({
    runs: runStore,
    // Canal RCS du bloc `rcs_message`. `agentIdFor` est scopé tenant : c'est lui qui empêche un scénario
    // d'envoyer sous la marque d'un autre client. Aucun agent -> le bloc part sur sa sortie « non joignable ».
    rcs: {
      sender: rcsStack.sender,
      agentIdFor: (tenant) => rcsStack.agents.agentIdForTenant(tenant),
      // Variables `{{champ}}` d'un message RCS : MÊME table que les modèles d'email, donc mêmes noms de
      // champs et mêmes règles. Hors base -> table vide, les variables rendent du vide au lieu de bloquer.
      varsFor: async (tenant, waId) => contactVars(await contactStore.getResolvableByPhone(tenant, waId) ?? {}),
      // Le message RCS d'un scénario apparaît dans le FIL, comme un template ou un message rapide. La bulle
      // porte son canal (`channel: 'rcs'`), c'est ce que l'Inbox dessine en vert RCS.
      recordOutbound: (tenant, waId, msg) =>
        inboxStore.recordOutboundByWaId(tenant, waId, { ...msg, type: 'rcs', channel: 'rcs', origine: 'scenario' }),
      // QUI a cliqué : le jeton public du contact, écrit dans les liens tracés du message. Lecture UNITAIRE
      // parce qu'un scénario écrit à une personne à la fois, et déclenchée seulement si le message porte un
      // lien (c'est l'exécuteur qui tranche, cf. `jetonRcs`).
      jetonPour: (tenant, waId) => trackedLinks.jetonPourE164(tenant, waId, fabriquerJeton),
    },
    // Un scénario n'écrit jamais dans un fil détenu par un opérateur ou par MBA. Vaut pour l'avance
    // (réponse du contact) comme pour le démarrage (campagne workflow, cible node).
    mayAct: async (tenant, waId) => (await inboxStore.getControlOwner(tenant, waId)) === 'app_workflow',
    // Un run qui atteint un bloc `inbox` remonte la conversation à un humain : on pose control_owner=app_human,
    // mais SEULEMENT si le fil était encore à nous (`only: ['app_workflow']`) pour ne pas écraser une prise de
    // main concurrente. Rend le badge honnête (fin du trou où le scénario semblait « répondre » sans plus avancer).
    //
    // 🔴 ET L AFFECTATAIRE QUE LE BLOC DESIGNE. Ce cablage est le JUMEAU de celui de `src/worker.ts` : ne
    // poser l affectation que sur l un des deux la ferait marcher sur un chemin (le worker) et pas sur
    // l autre, sans que rien ne le signale. C est le motif « capacite cablee sur un lecteur sur deux » que
    // le depot paie deja deux fois.
    escalateToHuman: async (tenant, waId, assigneA) => {
      await inboxStore.setControlOwner(tenant, waId, 'app_human', { only: ['app_workflow'] });
      if (assigneA) await inboxStore.setAssigneeByWaId(tenant, waId, assigneA);
    },
    // 🔴 LE BLOC AGENT. Sans ces deux dépendances, il est traversé comme un PASSE-PLAT : le scénario continue
    // sans que l'agent parle, et personne ne voit rien puisque le moteur ne suit alors qu'une arête libre.
    // Elles vont par paire : ouvrir une session sans enfiler le tour laisserait une session vivante et muette,
    // enfiler sans session ferait échouer chaque tour sur un verrou qui n'existe pas.
    agentSessions,
    // Le groupe est l'ESPACE (lot 6 du plan post-audit) : sans lui, un client bavard occupe toutes les places
    // de la file et les conversations des autres attendent derrière les siennes.
    enqueueAgentTurn: (job: AgentTurnJob) => queue.enqueue(AGENT_TURN_QUEUE, job, { groupId: job.tenantId }),
    /**
     * Reprise de main par l'app au lancement d'une CAMPAGNE (sans `only` : on reprend même un fil tenu par un
     * humain ou par MBA, puisque c'est l'opérateur lui-même qui déclenche l'envoi).
     *
     * 🔴 ELLE N'ÉCRIVAIT QUE NOTRE COLONNE, ET C'EST CE QUI A FAIT RÉPONDRE L'AGENT DE META À LA PLACE D'UN
     * SCÉNARIO (campagne « test4 », 2026-09-14). Chez Meta, le Meta Business Agent est le répondeur PRIMAIRE
     * du numéro : tant qu'on ne lui a pas pris le fil par `thread_control`, il reçoit la réponse du contact
     * et répond, quoi que dise notre base. Mesuré : template parti à 16:47:47, contact qui répond à 16:48:14,
     * agent de Meta qui répond à 16:48:24, puis qui rend la main à 16:48:25 avec le motif
     * `business_missing_info`. Le scénario, lui, n'a jamais avancé.
     *
     * 🔴 L'ORDRE EST META D'ABORD, NOUS ENSUITE, ET IL NE S'INVERSE PAS. Écrire notre colonne sans que Meta
     * ait confirmé produirait le pire des deux mondes : le scénario se croirait maître et répondrait
     * PAR-DESSUS l'agent de Meta, donc deux messages au contact. C'est la doctrine de
     * `src/inbox/controle-du-fil.ts` (« un état local qui annonce ce que Meta n'a pas fait »), appliquée ici.
     *
     * ⚠️ UN REFUS DE META EST UN CAS NORMAL, pas une anomalie : `take` est réservé au « configured escalation
     * partner ». On journalise et on LAISSE le fil à son détenteur, ce qui fait échouer proprement le
     * démarrage du scénario plus haut au lieu d'en démarrer un qui serait gelé sans trace.
     *
     * ⚠️ ET ON NE TENTE RIEN SI L'AGENT DE META EST ÉTEINT CHEZ CE CLIENT : sans lui, il n'y a personne à qui
     * prendre le fil, et un appel Meta par destinataire de campagne serait payé pour rien.
     */
    reclaimControl: async (tenant, waId): Promise<boolean> => {
      if ((await settingsStore.get(tenant)).mbaEnabled) {
        try {
          await takeThreadChezMeta(tenant, waId);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(`reclaimControl: Meta a REFUSÉ de nous rendre le fil pour ${waId} (${tenant}), le détenteur ne change pas :`, err instanceof Error ? err.message : err);
          return false;
        }
      }
      await inboxStore.setControlOwner(tenant, waId, 'app_workflow');
      return true;
    },
    // L'agent de Meta est-il allumé chez ce client ? Décide de deux choses : qu'une étape sans choix cesse de
    // bloquer le parcours, et qu'on rende le fil à Meta en fin de chaîne. Faux partout aujourd'hui, donc rien
    // ne change tant qu'aucun client n'a MBA.
    mbaActifPour: async (tenant) => (await settingsStore.get(tenant)).mbaEnabled,
    // Rend le fil à l'agent de Meta. La bascule LOCALE d'abord, et seulement si le fil était encore au
    // scénario : Meta exige de détenir le fil pour le relâcher, et cette condition le prouve.
    releaseToMba: async (tenant, waId) => {
      if (!(await inboxStore.setControlOwner(tenant, waId, 'mba', { only: ['app_workflow'] }))) return;
      await releaseThreadChezMeta(tenant, waId);
    },
    // Contexte d'évaluation des blocs `condition` (et du bloc `field` en mode NOW) : état du contact + fuseau et
    // horaires d'ouverture du tenant + `now`. Contact introuvable -> null -> le moteur prend la branche 'false'.
    evalContext: buildEvalContext,
    // Fenêtre de service 24 h, relue à la REPRISE d'un parcours endormi (bloc Attente). Elle court depuis le
    // dernier message DU CONTACT : même une attente courte peut la voir se fermer, donc on la LIT, on ne la
    // déduit pas de la durée d'attente. Même calcul que l'inbox (source unique).
    isWindowOpen: async (tenant, waId) => (await inboxStore.getWindowOpenByWaIds(tenant, [waId])).get(waId) === true,
    getGraph: async (id, tenant) => (await workflowStore.getById(id, tenant))?.graph ?? null,
    // Applique le tag au contact ET le déclare dans le référentiel (défense : un tag posé au runtime, y compris par
    // un ancien workflow non re-sauvegardé, atterrit dans Contenus > Tags). Best-effort, n'échoue jamais l'action.
    applyTag: async (tenant, waId, tag) => {
      // Même valeur normalisée (trim + slice 64) posée SUR le contact ET déclarée dans le référentiel -> pas de
      // doublon 'vip ' vs 'vip' ni tag>64 tronqué d'un côté seulement (Contenus > Tags = union des deux sources).
      const clean = tag.trim().slice(0, 64);
      if (clean === '') return false;
      const { added } = await contactStore.addTagsByPhoneReturningNew(tenant, waId, [clean]);
      try { await tagStore.create(tenant, clean); } catch { /* déclaration best-effort */ }
      // Dit à l'exécuteur si le tag était RÉELLEMENT nouveau : sinon un scénario qui repasse sur le même bloc
      // annoncerait « tag ajouté » à chaque passage, et relancerait une automation pour un non-événement.
      return added.length > 0;
    },
    // Publication « tag ajouté » pour les automations. Portée par une dep SÉPARÉE de `applyTag`, et appelée
    // par l'exécuteur uniquement sur un démarrage UNITAIRE : le même exécuteur sert les campagnes, où poser un
    // tag sur 5 000 destinataires enfilerait 5 000 événements. Passe par la file (et non un appel direct) pour
    // qu'un scénario qui pose son propre tag déclencheur ne s'enchaîne pas en récursion synchrone.
    emitTagAdded: async (tenant, waId, tag) => {
      const clean = tag.trim().slice(0, 64);
      if (clean === '') return;
      await enfilerEvenementAutomation(queue, { tenantId: tenant, event: { kind: 'tag_added', waId, tag: clean } } satisfies AutomationEventJob);
    },
    setField: async (tenant, waId, key, value) => { await contactStore.mergeFieldsByPhone(tenant, waId, { [key]: value }); },
    /**
     * LE BLOC « APPEL HTTP » : il joue un appel de la bibliotheque et rend ce qu il faut ranger dans un champ.
     *
     * 🔴 LES MEMES GARDES QUE L AGENT IA, parce que c est LE MEME CODE (`creerAppelConnecteur`) : source
     * active, filtre de sortie non vide, variables requises, adresse interne refusee, redirection refusee,
     * echeance, corps borne. Une seconde implementation aurait eu ses propres trous.
     *
     * ⚠️ Les deux valeurs systeme sont cablees comme pour l agent : sans elles, une requete qui demande la
     * derniere saisie du contact ou l heure locale partirait avec `null` et `UTC`, donc avec une valeur
     * fausse mais plausible, ce qui est pire qu un refus.
     */
    /**
     * LE BLOC « FONCTION JS ». Le module porte les plafonds et les mesures ; il n'y a rien a decider ici.
     *
     * ⚠️ ELLE NE LEVE JAMAIS : une faute du client ressort en `{ok: false}`, que l executeur traduit en champ
     * vide. Un parcours ne s arrete pas parce qu une transformation a rate.
     */
    executerJs: (code, valeur) => executerFonctionJs(code, valeur),
    /**
     * LES VARIABLES `{{champ}}` d un message rapide ou d une question.
     *
     * 🔴 LA MEME TABLE QUE LE RCS ET LES MODELES D E-MAIL (`contactVars`), cablee sur la meme lecture : un
     * client qui ecrit `{{prenom}}` attend la meme chose dans les trois, et trois tables differentes
     * finiraient par ne pas connaitre les memes champs.
     */
    varsFor: async (tenant, waId) => contactVars(await contactStore.getResolvableByPhone(tenant, waId) ?? {}),
    appelHttp: creerAppelHttpScenario({
      sources: new PgSourceStore(pool),
      requetes: new PgRequeteStore(pool),
      /**
       * 🔴 LE JOURNAL, QUI MANQUAIT (migration 0142). Un connecteur qui refusait l appel d un bloc de
       * scenario ne laissait qu un `console.warn` sur nos serveurs : le champ restait vide, le parcours
       * continuait, et le client ne pouvait pas savoir que SON systeme avait dit non.
       */
      journalAppels: new PgJournalAppels(pool),
      libelleRequete: async (t, id) => (await new PgRequeteStore(pool).parId(t, id))?.label ?? null,
      derniereSaisie: (t, waId) => inboxStore.derniereSaisieDuContact(t, waId),
      fuseau: async (t) => (await settingsStore.get(t)).timezone,
      // 🔴 RELUE A CHAQUE APPEL, pas portee par le contexte du parcours : le bloc peut suivre un bloc qui
      // vient d ecrire un champ, et servir une photo d avant ferait envoyer l ancienne valeur.
      projectionContact: async (t, waId) => {
        const etat = await contactStore.getContactStateByWaId(t, waId);
        return etat ? { nom: etat.name ?? '', tags: etat.tags, champs: etat.fields } : null;
      },
    }),
    // Retrait : même normalisation (trim + slice 64) que l'ajout, pour matcher le tag stocké. Le référentiel Tags
    // n'est PAS touché (retirer un tag d'un contact ne « dé-déclare » pas le tag du référentiel du tenant).
    removeTag: async (tenant, waId, tag) => {
      const clean = tag.trim().slice(0, 64);
      if (clean === '') return;
      await contactStore.removeTagsByPhone(tenant, waId, [clean]);
    },
    clearField: async (tenant, waId, key) => { await contactStore.clearFieldsByPhone(tenant, waId, [key]); },
    // Source `scenario` : elle distingue un consentement pose par un parcours de celui saisi a la main
    // (`crm`) ou coche par la personne dans un Flow (`flow`). Utile quand il faut savoir d'ou vient un opt-out.
    setOptIn: async (tenant, waId, value) => { await contactStore.setOptInByWaId(tenant, waId, value, 'scenario'); },
    /**
     * 🔴 LA GARDE D'OPT-OUT DES ENVOIS D'UN PARCOURS. Sans elle, un contact qui a écrit STOP continuait de
     * recevoir les messages d'un scénario ou d'une automation, et c'est exactement le manquement que le
     * centre de sécurité existe pour empêcher.
     *
     * 🔴 CE COMMENTAIRE A DIT « scénario, automation ET AGENT IA passent par cet exécuteur : ce branchement
     * les couvre les trois », ET C'ÉTAIT FAUX. Mesuré en revue du chantier complet, le 2026-09-14 : la
     * réponse d'un agent IA ne passe PAS par `apply`, elle part par `envoyerTexteAgent` (plus bas dans ce
     * fichier), qui appelle `client.sendText` directement. Seuls ses OUTILS y passent (`mba_envoyer_bloc`
     * fait `walk` + `apply`). L'agent a donc sa propre garde, au rang de ses plafonds, dans
     * `src/agent/run-turn.ts`, et elle est branchée sur le MÊME dépôt depuis `src/worker.ts`.
     *
     * ⚠️ La leçon vaut plus que la ligne : **une justification fausse est pire qu'aucune**, parce qu'elle
     * fait croire qu'un inventaire a été fait. Celle-ci a survécu à une revue, à un test de câblage et à un
     * déploiement, et c'est elle qui a fait écrire dans `features.md` et sur l'écran Consentement que
     * l'agent IA était bloqué.
     */
    estDesabonne: (tenant, waId) => contactStore.estDesabonneParWaId(tenant, waId),
    // Mesure par bloc (Analytics > Mes tableaux). L'executeur l'appelle en best-effort : une panne ici ne doit
    // jamais arreter un parcours.
    recordNodeEvent: (e) => nodeEvents.record(e),
    sendTemplate: async (tenant, waId, name, language, buttons, explicitParams) => {
      if (dryRun) return; // DRY_RUN : aucun appel Meta
      const pn = await repo.getTenantPhoneNumberId(tenant);
      if (!pn) {
        // eslint-disable-next-line no-console
        console.error(`workflow sendTemplate: aucun numéro pour le tenant ${tenant}, template « ${name} » non envoyé`);
        return 'aucun numéro WhatsApp rattaché à ce workspace';
      }
      const client = await metaFactory.clientForTenant(tenant, pn); // token PAR TENANT (B1), repli global en sommeil

      /**
       * ATTRIBUTION DES CLICS, sur le chemin des SCÉNARIOS (corrigé le 2026-09-02).
       *
       * 🔴 Un scénario envoie exactement les mêmes templates qu'une campagne directe. Quand un bouton a été
       * soumis à Meta sous la forme `/r/<code>/{{1}}`, ce `{{1}}` doit être rempli à CHAQUE envoi, par quelque
       * chemin que ce soit : sans son composant, Meta refuse tout le message en 131008. Ce chemin-ci ne le
       * faisait pas, donc tout scénario démarrant par un template tracé échouait. Mesuré en production.
       */
      const suffixes = await (async (): Promise<{ suffixesBoutons?: Record<number, string> }> => {
        try {
          const liens = await trackedLinks.listByTemplates(tenant, [name]);
          const boutons = liens.filter((l) => l.avecJeton && l.cardIndex === null).map((l) => l.buttonIndex);
          if (boutons.length === 0) return {};
          const jeton = await trackedLinks.jetonPourE164(tenant, waId, fabriquerJeton).catch(() => null);
          return suffixesPourDestinataire(boutons, jeton ?? undefined);
        } catch (err) {
          // Illisible : on ne sait pas si ce template porte des variables de bouton. On part comme avant, et on
          // le DIT, parce que c'est le seul cas où un 131008 resterait inexpliqué.
          // eslint-disable-next-line no-console
          console.error(`workflow sendTemplate: liens tracés de « ${name} » illisibles:`, err instanceof Error ? err.message : err);
          return {};
        }
      })();

      // Campagne workflow : les variables du 1er template sont DÉJÀ résolues par contact (paramMapping de la campagne,
      // via buildRecipients). On les utilise directement, sans relire le corps live du template ni les hints (chemin
      // identique aux campagnes template DIRECTES). `explicitParams` DÉFINI (même `[]` = template sans variable) ->
      // ce chemin ; `undefined` = envoi via `advance` (réponse webhook) -> chemin hints stockés ci-dessous.
      // Garde-fou : une valeur vide fait sauter l'envoi (jamais `text:''`).
      if (explicitParams !== undefined) {
        // Visuels (cartes de carousel ET en-tête média) : Meta les exige à CHAQUE envoi. Lecture best-effort
        // (ce chemin n'appelait pas Meta jusqu'ici) : illisible -> on part comme avant, un template SANS visuel
        // n'est pas affecté. MÊME traitement que la branche hints ci-dessous, par construction.
        let luCampagne: TplInfo | null = null;
        try {
          luCampagne = await templateVarInfo(tenant, name, language);
        } catch { /* best-effort */ }
        const visuels = await visuelsPourEnvoi(tenant, luCampagne);
        if ('refus' in visuels) {
          // eslint-disable-next-line no-console
          console.error(`workflow sendTemplate: « ${name} » non envoyé à ${waId} : ${visuels.refus}`);
          return `template « ${name} » : ${visuels.refus}`;
        }
        const { components, missing } = buildWorkflowTemplateComponents({ hints: [], varCount: explicitParams.length, contact: {}, buttons, explicitParams, flowToken: `${waId}-${Date.now()}`, ...visuels, ...suffixes });
        if (missing.length > 0) {
          // eslint-disable-next-line no-console
          console.error(`workflow sendTemplate: « ${name} » non envoyé à ${waId} : variable(s) manquante(s) position(s) ${missing.join(',')}`);
          return `template « ${name} » : valeur manquante pour la ou les variables ${missing.map((p) => `{{${p}}}`).join(', ')}`;
        }
        const res = await client.sendTemplate(waId, { name, language, ...(components.length > 0 ? { components } : {}) });
        // ⚠️ La catégorie vient de `luCampagne`, la lecture de CETTE branche, pas de `info` (qui n'existe
        // que dans la branche hints plus bas). Les deux branches doivent journaliser la MÊME chose : c'est
        // leur divergence qui a déjà laissé le carousel puis l'en-tête média non branchés côté campagne.
        // Lecture best-effort : `luCampagne` null (template illisible) -> pas de catégorie, jamais une
        // catégorie inventée, qui se facturerait au mauvais tarif.
        await logTemplateSent(inboxStore, tenant, waId, name, res.messageId, { templateCategory: luCampagne?.category ?? null });
        // Remonté pour la mesure par bloc : c'est cet identifiant qui permettra à un accusé de lecture de
        // retrouver le bloc qui a envoyé ce message.
        return { messageId: res.messageId };
      }

      // Variables du corps : on résout les {{n}} avec les attributs du contact (indices template_param_hints ->
      // champ, ex. {{1}}=prenom). On NE devine PAS : si les variables sont indéterminables (info null) ou si une
      // valeur manque, on NE PAS envoyer (évite 132000 « nb de variables » et 132012 « text:'' »).
      let info: TplInfo | null = null;
      try {
        info = await templateVarInfo(tenant, name, language);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`workflow sendTemplate: variables de « ${name} » indéterminables:`, err instanceof Error ? err.message : err);
      }
      if (info === null) {
        // eslint-disable-next-line no-console
        console.error(`workflow sendTemplate: variables de « ${name} » indéterminables (WABA/template/réseau) -> non envoyé à ${waId}`);
        return `template « ${name} » introuvable chez Meta (nom, langue, ou WhatsApp momentanément injoignable)`;
      }
      let hints: Awaited<ReturnType<typeof hintStore.get>> = [];
      let contact = null as Awaited<ReturnType<typeof contactStore.getResolvableByPhone>>;
      if (info.count > 0) {
        [hints, contact] = await Promise.all([
          hintStore.get(tenant, name, language),
          contactStore.getResolvableByPhone(tenant, waId),
        ]);
      }
      // Payload CONTRÔLÉ sur chaque bouton quick-reply -> au tap, le webhook renvoie `btn:<index>`, qui sélectionne
      // la branche (sourceHandle) de façon déterministe. Body avant boutons (ordre attendu par l'API Cloud).
      // Carousel non envoyable (carte sans image récupérable, variable de carte) : on NE devine PAS, on ne
      // laisse pas non plus partir un payload que Meta rejettera. Même doctrine que `missing`.
      const visuels = await visuelsPourEnvoi(tenant, info);
      if ('refus' in visuels) {
        // eslint-disable-next-line no-console
        console.error(`workflow sendTemplate: « ${name} » non envoyé à ${waId} : ${visuels.refus}`);
        return `template « ${name} » : ${visuels.refus}`;
      }
      const { components, missing } = buildWorkflowTemplateComponents({
        hints, varCount: info.count, contact: contact ?? {}, buttons, flowToken: `${waId}-${Date.now()}`, now: new Date(),
        ...visuels,
        ...suffixes,
      });
      if (missing.length > 0) {
        // eslint-disable-next-line no-console
        console.error(`workflow sendTemplate: « ${name} » non envoyé à ${waId} : variable(s) manquante(s) position(s) ${missing.join(',')}`);
        return `template « ${name} » : ce contact n'a pas de valeur pour la ou les variables ${missing.map((p) => `{{${p}}}`).join(', ')}`;
      }
      const res = await client.sendTemplate(waId, { name, language, ...(components.length > 0 ? { components } : {}) });
      // Journalise le template dans le fil de conversation (fil d'inbox complet + transcript d'analyse). Best-effort.
      // Même contexte que la branche campagne ci-dessus, lu ici dans `info` : sans la catégorie, l'envoi
      // remonte en volume mais reste à zéro dans le coût, sans que rien ne le signale.
      await logTemplateSent(inboxStore, tenant, waId, name, res.messageId, { templateCategory: info.category ?? null });
      return { messageId: res.messageId };
    },
    // Message rapide (node quick_message) : texte + 2-3 réponses rapides, hors template. Deux chemins d'accès,
    // tous deux EN fenêtre 24 h : `advance` (le contact vient de répondre) et `startFromNode` (cible node de
    // /v1/sends, qui a écarté les hors-fenêtre en amont). Texte littéral en V1 (pas de variables).
    sendQuickMessage: async (tenant, waId, body, buttons, mediaUrl, lien) => {
      if (dryRun) return; // DRY_RUN : aucun appel Meta
      if (body.trim() === '') return 'le bloc « message rapide » n\'a pas de texte';
      // 🔴 BOUTON DE LIEN INCOMPLET -> REFUS, jamais un message nu. Le client a coché la case ; lui envoyer
      // le texte seul parce que l'adresse manque, c'est le silence que ce bloc passe son temps à fermer (le
      // visuel non préparable refuse déjà, quelques lignes plus bas, pour exactement cette raison). La règle
      // vit dans le moteur (`problemeLienBouton`), une seule fois, et l'écran la répète au client au moment
      // de la saisie plutôt qu'après coup.
      const problemeLien = lien ? problemeLienBouton(lien) : null;
      if (problemeLien) return problemeLien;
      const pn = await repo.getTenantPhoneNumberId(tenant);
      if (!pn) {
        // eslint-disable-next-line no-console
        console.error(`workflow sendQuickMessage: aucun numéro pour le tenant ${tenant}, message rapide non envoyé à ${waId}`);
        return 'aucun numéro WhatsApp rattaché à ce workspace';
      }
      const client = await metaFactory.clientForTenant(tenant, pn); // token PAR TENANT (B1), repli global en sommeil
      // Aucune réponse rapide utilisable -> message TEXTE simple. Meta refuse un interactif sans bouton, et
      // c'est ce que l'opérateur attend quand il n'a rempli que le texte.
      //
      // ⚠️ On passe `buttons` ENTIER à l'envoi, jamais la liste filtrée : c'est `sendInteractive` qui écarte
      // les titres vides EN PRÉSERVANT l'index d'origine dans `btn:<i>`. Filtrer ici renumérotait les boutons
      // restants à partir de 0, donc une réponse rapide placée après une case vide renvoyait un payload qui
      // ne correspondait à aucune branche du scénario, et le contact partait sur la sortie par défaut.
      // Visuel : téléversé chez Meta et posé en EN-TÊTE. On réutilise le préparateur des visuels de template,
      // qui tourne en production et met l'identifiant en cache par (numéro, URL).
      //
      // 🔴 Préparation ratée -> REFUS EXPLICITE, jamais un envoi sans l'image. Laisser partir le texte seul
      // ferait croire à un message correct alors que l'opérateur a demandé un visuel, et personne ne le
      // saurait : c'est exactement le silence qu'on a passé la journée à fermer.
      let mediaId: string | undefined;
      if (mediaUrl && mediaUrl.trim() !== '') {
        const prepare = await prepareHeaderMedia(tenant, mediaUrl.trim());
        if (!prepare) return 'le visuel du bloc « message rapide » n’a pas pu être préparé pour l’envoi';
        mediaId = prepare;
      }
      const utilisables = buttons.some((b) => b.text.trim() !== '');
      // 🔴 LE BOUTON DE LIEN PASSE EN PREMIER, et il ne peut pas cohabiter avec des réponses rapides : chez
      // Meta, `button` et `cta_url` sont deux TYPES de messages interactifs différents. Le moteur vide déjà
      // `buttons` quand le bloc porte un lien, donc cet ordre n'arbitre rien en pratique ; il est écrit dans
      // ce sens pour que la contrainte tienne même si un graphe portait les deux.
      //
      // Un message interactif EXIGE au moins un bouton : avec un visuel et aucun bouton, c'est une image
      // légendée. Sans visuel ni bouton, un texte simple, comme avant.
      const res = lien
        ? await client.sendCtaUrl(waId, body, lien, mediaId)
        : utilisables
          ? await client.sendInteractive(waId, body, buttons, mediaId)
          : mediaId
            ? await client.sendImage(waId, mediaId, body)
            : await client.sendText(waId, body);
      // Journalise le message rapide dans le fil de conversation (best-effort, ne casse jamais l'envoi Meta réussi).
      try { await inboxStore.recordOutboundByWaId(tenant, waId, { body, messageId: res.messageId, type: 'text', origine: 'scenario' }); } catch { /* best-effort */ }
      return { messageId: res.messageId };
    },
    /**
     * Bloc QUESTION : une LISTE interactive (menu déroulant) dès qu'une ligne porte un libellé, un simple
     * texte sinon. Le contact répond en choisissant une ligne, ou en écrivant.
     *
     * ⚠️ `rows` part ENTIER, lignes vides comprises. C'est `sendList` qui les écarte APRÈS numérotation, donc
     * `row:<i>` reste aligné sur la ligne affichée dans l'éditeur. Filtrer ici renumérotrait, et une ligne
     * placée après une case vide renverrait un payload qui ne correspond à aucune branche du scénario.
     *
     * Sans aucune ligne, c'est un TEXTE : Meta refuse une liste vide, et c'est exactement ce qu'attend
     * l'opérateur qui a posé une question ouverte. Le bloc attend la réponse dans les deux cas.
     */
    sendQuestion: async (tenant, waId, body, buttonLabel, rows) => {
      if (dryRun) return; // DRY_RUN : aucun appel Meta
      if (body.trim() === '') return 'le bloc « question » n\'a pas de texte'; // défense, actionOf filtre déjà
      const pn = await repo.getTenantPhoneNumberId(tenant);
      if (!pn) {
        // eslint-disable-next-line no-console
        console.error(`workflow sendQuestion: aucun numéro pour le tenant ${tenant}, question non envoyée à ${waId}`);
        return 'aucun numéro WhatsApp rattaché à ce workspace';
      }
      const client = await metaFactory.clientForTenant(tenant, pn); // token PAR TENANT (B1), repli global en sommeil
      /**
       * 🔴 Variables `{{prenom}}` du contact, RÉSOLUES ICI.
       *
       * Le panneau de ce bloc offre le bouton « + Variable » (le même composant que partout ailleurs). Sans
       * cette résolution, l'éditeur promettrait une substitution que personne ne fait, et le contact lirait
       * `{{prenom}}` en toutes lettres. C'est exactement le genre d'option qui promet ce que le code ne tient pas.
       *
       * La fiche n'est lue QUE si le texte porte une variable : une question sans variable, qui est le cas
       * courant, ne déclenche aucune requête de plus. Même patron que le bloc RCS.
       */
      const aVariable = /\{\{\s*[\w.-]+\s*\}\}/.test(body) || rows.some((r) => /\{\{\s*[\w.-]+\s*\}\}/.test(r.title) || /\{\{\s*[\w.-]+\s*\}\}/.test(r.description ?? ''));
      let corps = body;
      let lignes = rows;
      if (aVariable) {
        const vars = contactVars((await contactStore.getResolvableByPhone(tenant, waId)) ?? {});
        corps = renderText(body, vars, { html: false });
        lignes = rows.map((r) => ({
          title: renderText(r.title, vars, { html: false }),
          ...(r.description ? { description: renderText(r.description, vars, { html: false }) } : {}),
        }));
      }
      const avecMenu = lignes.some((r) => r.title.trim() !== '');
      const res = avecMenu
        ? await client.sendList(waId, corps, buttonLabel, lignes)
        : await client.sendText(waId, corps);
      // Journalise la question dans le fil (best-effort, ne casse jamais un envoi Meta réussi). Le corps
      // journalisé est celui REÇU par le contact, variables résolues : c'est ce qu'un opérateur doit relire.
      try { await inboxStore.recordOutboundByWaId(tenant, waId, { body: corps, messageId: res.messageId, type: 'text', origine: 'scenario' }); } catch { /* best-effort */ }
      return { messageId: res.messageId };
    },
    // Formulaire (node flow) : message interactif type flow, hors template. Atteint via `advance` (le save du
    // graphe + la garde de `start` refusent un flow en OUVERTURE) ou via `startFromNode` (cible node, fenêtre
    // déjà vérifiée) -> fenêtre 24 h ouverte dans les deux cas. La complétion revient en nfm_reply : mapping
    // des champs par _ref, indépendant du canal d'envoi.
    sendFlow: async (tenant, waId, flowId, body, cta) => {
      if (dryRun) return; // DRY_RUN : aucun appel Meta
      if (flowId.trim() === '') return 'le bloc « formulaire » ne désigne aucun formulaire'; // défense, actionOf filtre déjà
      const pn = await repo.getTenantPhoneNumberId(tenant);
      if (!pn) {
        // eslint-disable-next-line no-console
        console.error(`workflow sendFlow: aucun numéro pour le tenant ${tenant}, formulaire non envoyé à ${waId}`);
        return 'aucun numéro WhatsApp rattaché à ce workspace';
      }
      const client = await metaFactory.clientForTenant(tenant, pn); // token PAR TENANT (B1), repli global en sommeil
      // flow_token jamais vide (exigence Meta #131009) mais jetable : la corrélation passe par le _ref du flow_json.
      const res = await client.sendFlowMessage(waId, { body, flowId, cta, flowToken: `${waId}-${Date.now()}` });
      // Journalise l'envoi dans le fil (best-effort). Le corps = l'accroche visible par le contact.
      try { await inboxStore.recordOutboundByWaId(tenant, waId, { body, messageId: res.messageId, type: 'text', origine: 'scenario' }); } catch { /* best-effort */ }
      return { messageId: res.messageId };
    },
    // Node « Envoi de mail » (SMTP, Task 8). `apply` (executor.ts) enveloppe cet appel d'un try/catch best-effort
    // strict : rien ici ne doit faire échouer le parcours, cette dep ne fait donc que journaliser et sortir.
    sendEmail,
  });

  /**
   * L'envoi d'un message d'AGENT : un texte, rien de plus.
   *
   * 🔴 IL VIT ICI, avec les autres envois, et pas dans le worker. Trois choses le commandent, et chacune a
   * déjà coûté un incident quand elle a été recopiée ailleurs : `dryRun` (l'oublier enverrait pour de vrai
   * depuis une machine de test), le token PAR TENANT (un envoi sous la marque d'un autre client), et la
   * journalisation dans le fil (un message que le contact reçoit sans que l'inbox le montre, donc un
   * opérateur qui reprend la main sans savoir ce que l'agent a dit).
   *
   * Rend une chaîne NON VIDE en cas de refus, comme les autres envois du moteur (`SendRefusal`) : le tour
   * sort alors par la branche d'échec plutôt que de laisser la conversation muette.
   */
  const envoyerTexteAgent = async (tenant: string, waId: string, texte: string): Promise<string | void> => {
    if (dryRun) return; // DRY_RUN : aucun appel Meta
    const pn = await repo.getTenantPhoneNumberId(tenant);
    if (!pn) {
      // eslint-disable-next-line no-console
      console.error(`agent: aucun numéro pour le tenant ${tenant}, réponse non envoyée à ${waId}`);
      return 'aucun numéro WhatsApp rattaché à ce workspace';
    }
    const client = await metaFactory.clientForTenant(tenant, pn);
    const res = await client.sendText(waId, texte);
    try { await inboxStore.recordOutboundByWaId(tenant, waId, { body: texte, messageId: res.messageId, type: 'text', origine: 'ia' }); } catch { /* best-effort */ }
  };

  /** Poser un tag depuis un agent : les trois effets, et la règle qui les lie, vivent dans `agent/poser-tag`.
   *  Ici on ne fait que brancher les stores. */
  const poserTagDepuisAgent = creerPoserTagAgent({
    ajouterAuContact: (tenant, waId, tag) => contactStore.addTagsByPhoneReturningNew(tenant, waId, [tag]),
    declarer: async (tenant, tag) => { await tagStore.create(tenant, tag); },
    emettre: async (tenant, waId, tag) => {
      await enfilerEvenementAutomation(queue, { tenantId: tenant, event: { kind: 'tag_added', waId, tag } } satisfies AutomationEventJob);
    },
  });

  return { executor: workflowExecutor, runStore, templateVarInfo, prepareCarouselMedia, prepareHeaderMedia, buildEvalContext, rcsStack, releaseThreadChezMeta, agentSessions, envoyerTexteAgent, poserTagDepuisAgent };
}
