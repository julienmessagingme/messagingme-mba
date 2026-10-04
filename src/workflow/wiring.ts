import type { Pool } from 'pg';
import { config } from '../config';
import type { PgWorkflowRunStore } from './run-store.pg';
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
import { automatique } from '../inbox/evenements';
import { PgTenantSettingsStore } from '../settings/store.pg';
import { PgCampaignRepo } from '../campaign/store.pg';
import { modeleLuDe } from '../api/modele-envoi';
import { MetaMediaClient } from '../meta/media';
import { MetaClientFactory } from '../meta/factory';
import { MetaCredentialsResolver } from '../meta/credentials';
import { TemplateMediaPreparer } from '../meta/template-media';
import type { OutboundCarouselCard } from '../meta/template-components';
import { WorkflowExecutor } from './executor';
import { creerEnvoisDeBloc, type TplInfo } from './envois-bloc';
import { buildRcsStack } from '../rcs/factory';
import { urlRappelRcs } from '../rcs/callback';
import { adressesPubliques } from '../lib/adresses-publiques';
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
import type { ControleDuFil } from '../inbox/fil';
import { creerTransmettreHorsParcours } from '../mba/transmettre-hors-parcours';
import { cacheCourt } from '../lib/cache-court';
import type { MetaClient } from '../meta/client';

/**
 * Câblage de l'exécuteur de scénarios : ses dépendances IO (contacts, tags, envois Meta, caches de
 * templates, visuels de carousel, publication d'événements d'automation).
 *
 * Deux processus exécutent un scénario : le worker (réponse d'un contact, campagne, réveil) et l'API (un
 * opérateur lance un scénario depuis l'Inbox et doit savoir tout de suite si c'est parti). Un seul câblage
 * pour les deux : un second exemplaire divergerait.
 *
 * Les caches restent par process (templates, WABA, media ids, token), bornés par des TTL courts ; Meta
 * reste la source de vérité.
 */
export interface WorkflowRuntimeDeps {
  pool: Pool;
  /**
   * File pg-boss : publie « tag ajouté » pour les automations, et les tours d'agent (aucun `work` ici). Les
   * options sont déclarées : sans elles, une clé de groupe passée par un appelant disparaîtrait en silence, et
   * son job échapperait au plafond par espace.
   */
  queue: { enqueue(name: string, data: unknown, opts?: { groupId?: string; expireInSeconds?: number }): Promise<void> };
  /** DRY_RUN : aucun appel Meta. À passer explicitement : l'oublier ferait envoyer pour de vrai. */
  dryRun: boolean;
  repo: PgCampaignRepo;
  contactStore: PgContactStore;
  inboxStore: PgInboxStore;
  settingsStore: PgTenantSettingsStore;
  workflowStore: PgWorkflowStore;
  /** Résolveur de token par tenant, reçu plutôt que reconstruit pour ne pas dupliquer son cache. */
  metaCredentials: MetaCredentialsResolver;
  metaFactory: MetaClientFactory;
  /** Provider du canal RCS (`config.RCS_PROVIDER`). Passé explicitement, comme `dryRun` : ce module ne lit pas
   *  la config, ses appelants la lui donnent. */
  rcsProvider: 'fake' | 'smsmode';
  /** Modèles d'email, chargés par id à l'envoi du bloc « Envoi de mail » (sujet + corps rendus avec les
   *  variables du contact). */
  emailTemplates: PgEmailTemplateStore;
  /** Résolveur de transport SMTP par boîte. Reçu (comme `metaCredentials`) : les routes email l'invalident à
   *  chaque écriture d'un compte, l'exécuteur doit voir la même instance. */
  emailResolver: EmailAccountResolver;
  /**
   * Le numéro de l'espace, mis en cache pour le processus par le socle, qui le partage avec le contrôle du fil :
   * sinon une campagne de 5 000 destinataires ferait 5 000 requêtes sur le pool partagé. Pourquoi ce cache est
   * sûr : `src/meta/numero-espace.ts`.
   */
  numeroDeLEspace(tenantId: string): Promise<string | null>;
  /** Les parcours, construits par le socle : le contrôle du fil lit aussi « un parcours attend-il ce contact ? ». */
  runStore: PgWorkflowRunStore;
  /**
   * Le contrôle du fil (`src/inbox/fil.ts`) : l'exécuteur y prend le fil, le rend, le passe à l'équipe et lit s'il
   * a le droit d'écrire. Aucune de ces transitions ne s'écrit ici.
   */
  fil: ControleDuFil;
}

/** `buildWorkflowRuntime` construit l'exécuteur et ce qui l'accompagne, une fois par process (les caches vivent dedans). */
export function buildWorkflowRuntime(deps: WorkflowRuntimeDeps) {
  const { pool, queue, dryRun, repo, contactStore, inboxStore, settingsStore, workflowStore, metaCredentials, metaFactory, rcsProvider, emailTemplates, emailResolver, numeroDeLEspace, runStore, fil } = deps;
  /**
   * Le client Meta de l'espace pour un envoi WhatsApp, ou le refus (une chaîne, comme tout `SendRefusal`)
   * quand aucun numéro n'est rattaché. `dryRun` reste chez l'appelant : certains envois refusent un bloc vide
   * avant de chercher le numéro.
   */
  const clientWhatsApp = async (tenant: string, qui: string, quoiNonEnvoye: string): Promise<MetaClient | string> => {
    const pn = await numeroDeLEspace(tenant);
    if (!pn) {
      // eslint-disable-next-line no-console
      console.error(`${qui}: aucun numéro pour le tenant ${tenant}, ${quoiNonEnvoye}`);
      return 'aucun numéro WhatsApp rattaché à ce workspace';
    }
    return metaFactory.clientForTenant(tenant, pn); // token par tenant, repli global en sommeil
  };
  /** Les variables `{{champ}}` d'un contact désigné par son wa_id (RCS d'un scénario, message rapide, question). */
  const varsDuContact = async (tenant: string, waId: string) => contactVars((await contactStore.getResolvableByPhone(tenant, waId)) ?? {});

  const nodeEvents = new PgWorkflowNodeEventStore(pool);
  // Pile RCS montée ici, une seule fois : l'exécuteur et le worker (campagnes) partagent le même sender, donc
  // le même cache de joignabilité et le même provider.
  const agentsRcs = new PgRcsAgentStore(pool);
  const trackedLinks = new PgTrackedLinkStore(pool);
  /**
   * Les adresses que le RCS distribue (rappel smsmode, liens tracés des boutons) sont des adresses de l'API :
   * le front (Vercel) ne relaie pas ces chemins. Même point de passage que les liens WhatsApp et les visuels
   * RCS de `src/index.ts`, gardé par `tests/rcs-adresses-cablage.test.ts`.
   */
  const adressesApi = adressesPubliques(config.APP_URL, config.PUBLIC_API_URL);
  const rcsStack = buildRcsStack(pool, rcsProvider, dryRun, {
    apiKey: config.SMSMODE_RCS_API_KEY,
    // Clé propre au workspace, déchiffrée à la volée ; la clé d'environnement n'est qu'un repli pour le
    // workspace historique.
    apiKeyFor: (tenant) => agentsRcs.apiKeyFor(tenant, (enc) => decryptSecret(enc, config.ENCRYPTION_KEY)),
    ...(config.SMSMODE_CALLBACK_STATUS_URL ? { callbackUrlStatus: config.SMSMODE_CALLBACK_STATUS_URL } : {}),
    ...(config.SMSMODE_CALLBACK_MO_URL ? { callbackUrlMo: config.SMSMODE_CALLBACK_MO_URL } : {}),
    // Adresse de rappel propre au workspace, posée sur chaque envoi : sans elle, pas de rapports de livraison
    // (donc pas de sortie « non joignable ») ni de réponses aux boutons.
    callbackUrlFor: async (tenant) => {
      const code = await agentsRcs.webhookCodePour(tenant);
      return code ? urlRappelRcs(adressesApi.avecPrefixe, code) : null;
    },
  },
  // Variables `{{champ}}` d'une campagne RCS. `waIdOfTarget` et pas le E.164 brut : un contact se résout sur
  // son wa_id (chiffres nus), et un « + » en tête ne trouverait personne.
  async (tenant, e164) => contactVars(await contactStore.getResolvableByPhone(tenant, waIdOfTarget(e164)) ?? {}),
  // Traçage des liens RCS, monté ici une seule fois : son cache adresse -> code est partagé par campagnes et
  // scénarios. Branché au point d'envoi unique, il couvre tous les chemins.
  new TraceurLiensRcs(trackedLinks, adressesApi.racine, newTrackingCode),
  );
  const tagStore = new PgTagStore(pool);
  const hintStore = new PgTemplateHintStore(pool);

  // Cache court du corps live d'un template (nb de variables + exemples) par WABA|nom|langue : évite un appel
  // Meta list() par destinataire d'une campagne workflow. Il porte aussi les cartes du carousel et l'en-tête
  // média, que Meta exige à chaque envoi et dont les URL expirent : TTL court, jamais figées. Ce qu'il porte :
  // `TplInfo` (`src/workflow/envois-bloc.ts`).
  const tplVarCache = new Map<string, { at: number } & TplInfo>();
  const TPL_CACHE_MS = 5 * 60_000;
  // `count` = max des positions {{n}} (« {{1}} ... {{3}} » attend 3 params pour Meta, pas 2) ; null =
  // indéterminable -> l'appelant n'envoie pas. WABA du tenant mémoïsé au même TTL : `templateVarInfo` est
  // appelé par destinataire sur une campagne scénario.
  const wabaCache = cacheCourt<string | null>(TPL_CACHE_MS);
  const tenantWabaId = (tenant: string): Promise<string | null> => wabaCache.lire(tenant, () => repo.getTenantWabaId(tenant));
  /**
   * Préparation des visuels d'un template (re-téléversement -> `media id`), cartes de carousel et en-tête
   * média. Une seule implémentation (`meta/template-media.ts`), partagée avec l'API ; l'instance porte son
   * cache, créée une fois.
   */
  const templateMedia = new TemplateMediaPreparer({
    getPhoneNumberId: (tenant) => numeroDeLEspace(tenant),
    mediaClientFor: async (tenant) => {
      const { token } = await metaCredentials.resolveForTenant(tenant);
      return new MetaMediaClient(token, config.META_APP_ID, config.META_GRAPH_VERSION);
    },
  });
  const prepareCarouselMedia = (tenant: string, cards: OutboundCarouselCard[]): Promise<OutboundCarouselCard[]> =>
    templateMedia.prepare(tenant, cards);
  const prepareHeaderMedia = (tenant: string, mediaUrl: string): Promise<string | null> =>
    templateMedia.prepareOne(tenant, mediaUrl);

  const templateVarInfo = async (tenant: string, name: string, language: string): Promise<TplInfo | null> => {
    const waba = await tenantWabaId(tenant);
    if (!waba) return null;
    const key = `${waba}|${name}|${language}`;
    const cached = tplVarCache.get(key);
    if (cached && Date.now() - cached.at < TPL_CACHE_MS) {
      const { at: _at, ...info } = cached;
      return info;
    }
    const tplClient = await metaFactory.templateClientForTenant(tenant); // token par tenant, repli global en sommeil
    const list = await tplClient.list(waba);
    // Exact (nom + langue), sinon repli sur le nom seul (langue par défaut d'un template mono-langue).
    const tpl = list.find((t) => t.name === name && t.language === language) ?? list.find((t) => t.name === name);
    if (!tpl) return null;
    const media = tpl.headerFormat === 'IMAGE' || tpl.headerFormat === 'VIDEO' || tpl.headerFormat === 'DOCUMENT'
      ? tpl.headerFormat
      : undefined;
    // Nombre de variables, statut, langue, catégorie, et ce qui empêcherait tout envoi : même construction que
    // le catalogue de l'API (`modeleLuDe`), sinon l'un annoncerait ce que l'autre refuse.
    const info: TplInfo = {
      ...modeleLuDe(tpl),
      ...(tpl.carousel ? { carousel: tpl.carousel } : {}),
      ...(media ? { headerFormat: media } : {}),
      ...(tpl.headerMediaUrl ? { headerMediaUrl: tpl.headerMediaUrl } : {}),
    };
    tplVarCache.set(key, { at: Date.now(), ...info });
    return info;
  };

  // Les quatre envois WhatsApp d'un bloc (modèle, message rapide, question, formulaire) vivent dans leur module,
  // exécuté par ses tests. Il reçoit d'ici ce qui est partagé : le client de l'espace (la réponse d'un agent IA
  // l'emprunte) et le cache des templates (les campagnes et l'API le lisent).
  const envois = creerEnvoisDeBloc({
    dryRun, clientWhatsApp, templateVarInfo, prepareCarouselMedia, prepareHeaderMedia,
    trackedLinks, hintStore, contactStore, varsDuContact, inboxStore,
  });

  // Contexte d'évaluation du contact (état CRM + fuseau/horaires du tenant). Partagé par les blocs `condition`
  // d'un scénario et le filtre `conditionGroup` d'une automation : une seule définition, même sémantique.
  const buildEvalContext = async (tenant: string, waId: string, besoins?: { derniereSaisie: boolean }) => {
    const state = await contactStore.getContactStateByWaId(tenant, waId);
    if (!state) return null;
    const settings = await settingsStore.get(tenant);
    // Lue seulement si un bloc la réclame. Un échec ne coule pas le contexte : le bloc pose une valeur vide,
    // jamais une valeur inventée.
    const derniereSaisie = besoins?.derniereSaisie
      ? await inboxStore.derniereSaisieDuContact(tenant, waId).catch(() => null)
      : null;
    return { ...state, now: new Date(), timeZone: settings.timezone, businessHours: settings.businessHours, derniereSaisie };
  };

  /**
   * Envoi réel du bloc « Envoi de mail » : modèle, boîte SMTP, destinataires, variables `{{champ}}` (sujet en
   * texte, corps en HTML seulement si le modèle est 'html'). `apply` garantit le best-effort : ici on rend la
   * raison sans lever sur un cas attendu (modèle ou boîte supprimé depuis, destinataire vide).
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
    // Contact résolu ici, comme `sendTemplate` le fait pour ses variables : `apply` ne porte qu'un waId. Hors
    // base -> objet vide (variables système à null).
    const contact = await contactStore.getResolvableByPhone(tenant, waId);
    const vars = contactVars(contact ?? {});
    const adresses = adressesDestinataires(action.to, vars);
    if (adresses.length === 0) {
      // eslint-disable-next-line no-console
      console.error(`workflow sendEmail: aucun destinataire résolu pour ${waId} (${tenant}), envoi ignoré`);
      // Typiquement : le bloc vise le champ « mail », vide, alors que le contact a « email ».
      return 'aucune adresse : le champ choisi est vide sur cette fiche contact';
    }
    const html = template.format === 'html';
    // 🔴 Le 1er en « À », les suivants en copie cachée : les destinataires peuvent être des clients, et les
    // mettre tous en « À » exposerait leurs adresses les uns aux autres (fuite de données personnelles).
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

  // Les sessions d'agent : partagées avec le worker, qui les reçoit d'ici plutôt que d'en construire un
  // second exemplaire (deux points de construction finissent par diverger sur une option).
  const agentSessions = new PgAgentSessionStore(pool);

  // La réponse « à côté » : les gardes vivent dans le module, testé.
  const transmettreHorsParcours = creerTransmettreHorsParcours({
    detenteur: (t, w) => inboxStore.getControlOwner(t, w),
    numero: (t) => numeroDeLEspace(t),
    corpsDuMessage: (t, id) => inboxStore.corpsDuMessage(t, id),
    envoyer: async (t, pn, to, event) => (await metaFactory.mbaClientForTenant(t)).agentEvent(pn, to, event, AbortSignal.timeout(10_000)),
    // eslint-disable-next-line no-console
    journal: (ligne) => console.log(ligne),
  });

  const workflowExecutor = new WorkflowExecutor({
    runs: runStore,
    // Canal RCS du bloc `rcs_message`. 🔴 `agentIdFor` est scopé tenant : c'est lui qui empêche un scénario
    // d'envoyer sous la marque d'un autre client. Aucun agent -> le bloc part sur sa sortie « non joignable ».
    rcs: {
      sender: rcsStack.sender,
      agentIdFor: (tenant) => rcsStack.agents.agentIdForTenant(tenant),
      // Variables `{{champ}}` d'un message RCS : même table que les modèles d'email. Hors base -> table vide,
      // les variables rendent du vide au lieu de bloquer.
      varsFor: varsDuContact,
      // Le message RCS d'un scénario apparaît dans le fil, comme un template ou un message rapide ; sa bulle
      // porte son canal (`channel: 'rcs'`).
      recordOutbound: (tenant, waId, msg) =>
        inboxStore.recordOutboundByWaId(tenant, waId, { ...msg, type: 'rcs', channel: 'rcs', origine: 'scenario' }),
      // Qui a cliqué : le jeton public du contact, écrit dans les liens tracés. Lecture unitaire (un scénario
      // écrit à une personne à la fois), seulement si le message porte un lien (cf. `jetonRcs`).
      jetonPour: (tenant, waId) => trackedLinks.jetonPourE164(tenant, waId, fabriquerJeton),
    },
    // Un scénario n'écrit jamais dans un fil détenu par un opérateur ou par MBA. Vaut pour l'avance
    // (réponse du contact) comme pour le démarrage (campagne workflow, cible node).
    mayAct: fil.peutAgir,
    // Un run qui atteint un bloc `inbox` remonte la conversation à un humain, seulement si le fil était encore aux
    // robots, puis pose l'affectataire désigné par le bloc. `escalade` est relayé, jamais décidé ici : c'est
    // l'exécuteur qui sait si quelqu'un attend une réponse.
    escalateToHuman: async (tenant, waId, assigneA, escalade, workflowId) => {
      // La cause que la frise du panneau Détail affiche à la place d'un auteur : le NOM du scénario, pour le passage
      // à l'équipe (l'événement `escaladee`, migration 0194, qui ouvre une demande du Quantitatif > Performance) et
      // pour l'affectation. Lu à CHAQUE passage : depuis le 2026-09-29, tout passage d'un robot à l'équipe écrit
      // l'événement, drapeau d'escalade ou non (`ouvreUneDemande`, `src/inbox/fil.ts`). Un scénario introuvable ne
      // bloque rien, il est dit par son identifiant. Tenu par un test qui monte ce câblage
      // (`tests/controle-du-fil-cablage.test.ts`).
      const nom = (await workflowStore.getById(workflowId, tenant).catch(() => null))?.name;
      const cause = automatique(`scénario ${nom ?? workflowId}`);
      await fil.passerAUnHumain(tenant, waId, { escalade, cause });
      if (assigneA) await inboxStore.setAssigneeByWaId(tenant, waId, assigneA, cause);
    },
    // Le bloc agent : sans ces deux dépendances, il est traversé comme un passe-plat, sans que l'agent parle.
    // Elles vont par paire : une session sans tour resterait vivante et muette, un tour sans session
    // échouerait sur un verrou inexistant.
    agentSessions,
    // Le groupe est l'espace : sans lui, un client bavard occupe toutes les places de la file et les
    // conversations des autres attendent derrière les siennes.
    enqueueAgentTurn: (job: AgentTurnJob) => queue.enqueue(AGENT_TURN_QUEUE, job, { groupId: job.tenantId }),
    /**
     * Reprise de main par l'app quand un parcours est lancé délibérément, empruntée par tous les chemins qui posent
     * `ignoreHumanControl` (campagne, Inbox, automation qui reprend la main, `/v1/sends`). Meta d'abord, notre
     * colonne ensuite, un rejeu : le geste est `ControleDuFil.reprendrePourLApp`.
     */
    reclaimControl: fil.reprendrePourLApp,
    // L'agent de Meta est-il allumé chez ce client ? Décide qu'une étape sans choix cesse de bloquer le
    // parcours, et qu'on rende le fil à Meta en fin de chaîne.
    mbaActifPour: async (tenant) => (await settingsStore.get(tenant)).mbaEnabled,
    /**
     * Fin de parcours : le fil est rendu à l'agent de Meta à l'accusé de notre dernier envoi (envoyer prend le fil
     * chez Meta, un release émis juste après serait annulé), ou tout de suite si rien n'est en vol.
     */
    releaseToMba: fil.rendreApresParcours,
    transmettreHorsParcours,
    // Contexte d'évaluation des conditions et des valeurs dynamiques. Contact introuvable -> null -> le
    // moteur prend la branche 'false'.
    evalContext: buildEvalContext,
    // Fenêtre de service 24 h, relue à la reprise d'un parcours endormi : elle court depuis le dernier message
    // du contact, on la lit au lieu de la déduire de la durée d'attente. Même calcul que l'inbox.
    isWindowOpen: async (tenant, waId) => (await inboxStore.getWindowOpenByWaIds(tenant, [waId])).get(waId) === true,
    getGraph: async (id, tenant) => (await workflowStore.getById(id, tenant))?.graph ?? null,
    // Applique le tag au contact et le déclare dans le référentiel (un tag posé au runtime atterrit dans
    // Contenus > Tags). La déclaration est best-effort.
    applyTag: async (tenant, waId, tag) => {
      // Même valeur normalisée (trim + slice 64) sur le contact et dans le référentiel : pas de doublon
      // 'vip ' vs 'vip'.
      const clean = tag.trim().slice(0, 64);
      if (clean === '') return false;
      const { added } = await contactStore.addTagsByPhoneReturningNew(tenant, waId, [clean]);
      try { await tagStore.create(tenant, clean); } catch { /* déclaration best-effort */ }
      // Dit à l'exécuteur si le tag était réellement nouveau : sinon un scénario qui repasse sur le même bloc
      // relancerait une automation pour un non-événement.
      return added.length > 0;
    },
    // 🔴 Publication « tag ajouté », séparée de `applyTag` et appelée seulement sur un démarrage unitaire : sur
    // une campagne, 5 000 destinataires enfileraient 5 000 événements (et autant d'envois facturés). Passe par
    // la file pour qu'un scénario qui pose son propre tag déclencheur ne boucle pas en synchrone.
    emitTagAdded: async (tenant, waId, tag) => {
      const clean = tag.trim().slice(0, 64);
      if (clean === '') return;
      await enfilerEvenementAutomation(queue, { tenantId: tenant, event: { kind: 'tag_added', waId, tag: clean } } satisfies AutomationEventJob);
    },
    setField: async (tenant, waId, key, value) => { await contactStore.mergeFieldsByPhone(tenant, waId, { [key]: value }); },
    /**
     * `appelHttp` (plus bas) : joue un appel de la bibliothèque et rend ce qu'il faut ranger dans un champ.
     * Mêmes gardes que l'agent IA, parce que c'est le même code (`creerAppelConnecteur`). Les deux valeurs
     * système (dernière saisie, fuseau) sont câblées comme pour l'agent : sans elles, une requête partirait
     * avec `null` et `UTC`, des valeurs fausses mais plausibles.
     */
    // Fonction JS : le module porte les plafonds et ne lève jamais (une faute du client ressort en
    // `{ok: false}`, champ vidé). Le champ source donne son nom au paramètre, en plus de `valeur`, qui reste
    // valide pour les blocs existants.
    executerJs: (code, valeur, champSource) => executerFonctionJs(code, valeur, champSource ? { nomParametre: champSource } : {}),
    /** Les variables `{{champ}}` d'un message rapide ou d'une question : même table que le RCS et les modèles
     *  d'e-mail (`contactVars`). */
    varsFor: varsDuContact,
    appelHttp: creerAppelHttpScenario({
      sources: new PgSourceStore(pool),
      requetes: new PgRequeteStore(pool),
      /** Le journal, où le client voit qu'un connecteur a refusé l'appel d'un bloc de scénario. */
      journalAppels: new PgJournalAppels(pool),
      libelleRequete: async (t, id) => (await new PgRequeteStore(pool).parId(t, id))?.label ?? null,
      inbox: inboxStore,
      // Les champs fixes de la fiche (origine `fiche` : dernière analyse, identifiant externe...).
      fiche: contactStore,
      fuseau: async (t) => (await settingsStore.get(t)).timezone,
      // Relue à chaque appel, pas portée par le contexte du parcours : le bloc peut suivre un bloc qui vient
      // d'écrire un champ.
      projectionContact: (t, waId) => contactStore.projectionPourTiers(t, waId),
    }),
    // Retrait : même normalisation (trim + slice 64) que l'ajout. Le référentiel Tags n'est pas touché
    // (retirer un tag d'un contact ne le dé-déclare pas).
    removeTag: async (tenant, waId, tag) => {
      const clean = tag.trim().slice(0, 64);
      if (clean === '') return;
      await contactStore.removeTagsByPhone(tenant, waId, [clean]);
    },
    clearField: async (tenant, waId, key) => { await contactStore.clearFieldsByPhone(tenant, waId, [key]); },
    // Autorité `scenario` (elle lève un STOP, `LEVE_UN_STOP`), et source `scenario` : distingue un consentement posé
    // par un parcours de celui saisi à la main (`crm`) ou coché dans un Flow (`flow`).
    setOptIn: async (tenant, waId, value) => { await contactStore.setOptInByWaId(tenant, waId, value, 'scenario', 'scenario'); },
    /**
     * 🔴 La garde d'opt-out des envois d'un parcours (scénario, automation, outils d'agent qui passent par
     * `apply`) : sans elle, un contact qui a écrit STOP recevrait encore leurs messages. La réponse d'un agent
     * IA ne passe pas par ici (`envoyerTexteAgent`) : elle a sa propre garde dans `src/agent/run-turn.ts`,
     * branchée sur le même dépôt depuis `src/worker.ts`.
     */
    estDesabonne: (tenant, waId) => contactStore.estDesabonneParWaId(tenant, waId),
    // Le numéro délié, vérifié avant les effets d'un parcours qui enverra par WhatsApp (cf. `runFrom`) : même
    // garde que le point de passage des envois, sur le même numéro. DRY_RUN : rien ne part, rien à refuser.
    verifierNumeroWhatsApp: async (tenant) => {
      if (dryRun) return;
      const pn = await numeroDeLEspace(tenant);
      if (pn) await metaFactory.verifierNumero(pn);
    },
    // Mesure par bloc. L'exécuteur l'appelle en best-effort : une panne ici n'arrête jamais un parcours.
    recordNodeEvent: (e) => nodeEvents.record(e),
    // Modèle, message rapide, question et formulaire : `src/workflow/envois-bloc.ts`, étalés tels quels. Leur
    // contrat est tenu par le type de retour de `creerEnvoisDeBloc` ; une clé réécrite APRÈS cet étalement le
    // remplacerait sans erreur de compilation, seuls les tests du vrai câblage le voient.
    ...envois,
    // Node « Envoi de mail » : `apply` enveloppe cet appel d'un try/catch best-effort, rien ici ne doit faire
    // échouer le parcours.
    sendEmail,
  });

  /**
   * L'envoi d'un message d'agent : un texte, rien de plus. Il vit ici, où les autres envois sont construits, pour
   * hériter de trois choses : `dryRun` (sinon envoi réel depuis un poste de test), 🔴 le token par tenant (sinon envoi
   * sous la marque d'un autre client), et la journalisation dans le fil (sinon l'opérateur qui reprend la
   * main ne voit pas ce que l'agent a dit). Rend une chaîne non vide en cas de refus (`SendRefusal`) : le
   * tour sort alors par la branche d'échec.
   */
  const envoyerTexteAgent = async (tenant: string, waId: string, texte: string): Promise<string | void> => {
    if (dryRun) return; // DRY_RUN : aucun appel Meta
    const client = await clientWhatsApp(tenant, 'agent', `réponse non envoyée à ${waId}`);
    if (typeof client === 'string') return client;
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

  return { executor: workflowExecutor, runStore, templateVarInfo, prepareCarouselMedia, prepareHeaderMedia, buildEvalContext, rcsStack, agentSessions, envoyerTexteAgent, poserTagDepuisAgent };
}
