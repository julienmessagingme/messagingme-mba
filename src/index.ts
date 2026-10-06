import './charger-env';
import { buildServer } from './server';
import { config } from './config';
import { adressesPubliques } from './lib/adresses-publiques';
import { surveillerOps } from './ops/tentatives';
import { sendTelegram } from './ops/telegram';
import { creerAlertesReserve } from './http/numero-fourni';
import { PgBossQueue } from './queue/pgboss';
import { pool, mesureAttentePool } from './db/pool';
import { construireSocle } from './socle';
import { PgContactHistoryStore } from './crm/contact-history.pg';
import { PgTagStore } from './crm/tag-store.pg';
import { ensureField, ensureFieldByKey, WHATSAPP_OPTIN_FIELD_KEY, WHATSAPP_OPTIN_FIELD_LABEL } from './crm/fields';
import { PgCampaignDraftStore } from './campaign/draft-store.pg';
import type { ConversationMessage } from './inbox/store.pg';
import { PgStatsStore } from './stats/store.pg';
import { PgConversationStatsStore } from './stats/conversation-stats.pg';
import { PgPerformanceStore } from './stats/performance.pg';
import { lirePerformance } from './stats/performance';
import { creerChiffrage } from './stats/chiffrage';

import { cacheCourt } from './lib/cache-court';
import { journaliser } from './lib/journal';
import { ResendClient } from './support/resend';
import { PgUserAuthStore } from './auth/store';
import { PgMfaStore } from './auth/mfa-store.pg';
import { estAdresseOps } from './auth/middleware';
import type { ActionMfa } from './auth/mfa-routes';
import { PgUserStore } from './user/store.pg';
import { PgAuthTokenStore } from './auth/token-store.pg';
import { verifyGoogleIdToken } from './auth/google';
import { PgApiKeyStore } from './auth/api-key-store.pg';
import { PgOauthStore } from './oauth/store.pg';
import { PgPlafondEspaceStore } from './auth/plafond-espace.pg';
import { upsertContactsFromApi } from './api/contacts-upsert';
import { creerServiceContactsV1 } from './api/contacts-v1';
import { PgReachabilityStore } from './rcs/reachability.pg';
import { joignabiliteRcsToutesFormes } from './rcs/reachability';
import { verdictModele } from './api/modele-envoi';
import { resoudreFiche } from './api/fiche';
import { appliquerConsentement, depsConsentementDe } from './api/consentement';
import { traiterRapportRcs } from './rcs/rapport-livraison';
import { envoyerRcsLibre, phraseOperateur, type DepsRcsLibre } from './rcs/envoyer-libre';
import { PLAFOND_CONTACTS_ERREUR } from './http/stats';
import { viderVersLaBase } from './ops/pool-attentes.pg';
import { viderLatencesVersLaBase } from './ops/latence-http.pg';
import { PgStockageStore } from './ops/stockage.pg';
import { creerSurveillanceWorkers } from './ops/surveillance-workers';
import { MesureLatenceHttp } from './ops/latence-http';
import { PgWorkflowReportStore } from './workflow/reports.pg';
import { lienDe, lienTraceAvecJeton } from './links/rewrite';
import { fabriquerJeton } from './links/jeton-contact';
import { newTrackingCode } from './ids/code';
import type { AuditSink } from './audit/journal';
import { resolveScenario, resolveNode } from './ids/resolve';
import { relanceurDeCampagnes } from './campaign/enqueue';
import { PgSalesforceStore } from './salesforce/store.pg';
import { creerClientSalesforce } from './salesforce/client';
import { connecter as connecterSalesforce, deconnecter as deconnecterSalesforce } from './salesforce/connexion';
import type { SalesforceRouteDeps } from './http/salesforce';
import { signalDeLAccuse, signalDeLaReponse, signalDesabonnement, signalDuClic } from './signaux/emetteur';
import { plafondLePlusBas } from './campaign/pacing';
import { fetchHubspotLists, importHubspotList, disconnectHubspot, fetchHubspotDealStages } from './crm/hubspot-service';
import { PgTemplateHintStore } from './crm/template-hints.pg';
import { MetaMediaClient } from './meta/media';
import { pullFromInfo, pullFromError } from './account/pull';
import { makeDbReadinessCheck } from './db/readiness';
import { lanceurBalayageRisque } from './engagement/cablage';
import { PgChannelsMeConnectionStore } from './channels-me/connection-store.pg';
import { PgChannelsMeLinkStore } from './channels-me/link-store.pg';
import { PgChannelsMePostStore } from './channels-me/post-store.pg';
import { ChannelsMeClient } from './channels-me/client';
import { PgWidgetStore } from './widgets/store.pg';
import { qrSvg } from './widgets/qr';
import { conflitDansLEspace } from './widgets/phrases';
import { gestionDesWidgetsEnBase, type DepsWidgets } from './widgets/gestion';
import { etatDuScenario } from './workflow/store.pg';
import { enfilerEvenementAutomation, type AutomationEventJob } from './automation/event-job';
import { RateLimiter } from './auth/rate-limit';
import { resolveTenantCode } from './ids/tenant-code';
import { MetaEmbeddedSignupClient } from './meta/embedded-signup';
import { setTimeout as dormir } from 'node:timers/promises';
import { appliquerActivation } from './mba/activation';
import { activationPour } from './http/mba';
import type { DepsReglageRepondeur } from './repondeur/reglage';
import { randomBytes, randomUUID } from 'node:crypto';
import { fetchUrlBorne } from './lib/page-distante';
import { signSession, signLienNumero } from './auth/token';
import { lireEtatConnexion } from './otp/etat-connexion';
import { PgAbonnementsNumeroStore } from './stripe/abonnements.pg';
import { ouvrirAbonnement, ouvrirPortail, type DepsAbonnement } from './stripe/abonnement';
import { ecrireHandoffEnabled } from './mba/handoff';
import { buildTemplateComponents, carouselSendBlocker } from './meta/template-components';
import { PgRcsMessageStore } from './rcs/message-store.pg';
import { PgRcsMediaStore } from './rcs/media-store.pg';
import { urlImageRcs } from './rcs/image';
import { newMediaCode } from './ids/code';
import { verifierCleRcs } from './rcs/channel-info';
import { fetchGet } from './lib/http-get';
import { lireCatalogueGateway } from './agent/llm/modeles-gateway';
import { modelesProposables, type ModeleGateway } from './agent/modeles';
import { apercuMo } from './rcs/callback';
import { estDemandeArret } from './crm/consentement';
import { contactVars } from './crm/render';
import { resolveHintParams } from './crm/template';
import { FetchTransport, HTTP_TIMEOUT_MODELE_MS } from './meta/http';
import { creerRechercheSemantique } from './agent/recherche';
import { creerRepondeur } from './aide/repondre';
import { creerRecap } from './aide/recap.pg';
import { creerRecapRedige, creerRedacteurRecap, gabarit } from './aide/recap-rendu';
import { creerTraducteur, type LangueConsole } from './traduction/traduire';
import { PgTraductionStore } from './traduction/traduire.pg';
import { traduireFil } from './traduction/fil';
import { creerAppelConnecteur, creerResolveurHttp } from './agent/resolvers/http';
import { creerResolveurMcp } from './agent/resolvers/mcp';
import { lireContexteAvecReglages } from './agent/contexte';
import { transcrireMessage } from './inbox/transcrire';
import { transcrire } from './agent/llm/transcription';
import { PgNumerosFournisStore } from './otp/store.pg';
import { creerClientDidww } from './didww/client';
import { lireMediaRecu } from './inbox/media-entrant';
import type { DepsRepondre } from './inbox/repondre';
import { assurerCleGateway, creerAssureurDeCle, remonterPlafondApresRecharge, revoquerCleGateway, type DepsProvisionCle } from './agent/provisionner-cle';
import { encryptSecret } from './crypto/secretbox';
import { PasDeConnexionPub, ConnexionPubIncomplete } from './http/pubs';
import { creerConnexionPub } from './pubs/connexion';
import { PgBrouillonsPubStore } from './pubs/brouillons.pg';
import { creerLaPublicite, publierLaPublicite, type DemandeCreation } from './pubs/creation';
import { entonnoir, ISSUES_NON_PRISES_EN_CHARGE } from './pubs/entonnoir';
import { PgAgentSessionStore } from './agent/session-store.pg';
import { PgMcpStore } from './agent/mcp/store.pg';
import { PgEntretienStore } from './agent/setup/entretien-store.pg';
import { PgEntretienMbaStore } from './mba/assistant/entretien-store';
import { lireInventaireMba } from './mba/assistant/inventaire';
import { PgDepenseStore } from './assistant/budget';
import { PgHistoriqueStore } from './reglages/historique.pg';
import { enTetesAuthSource } from './agent/http-cible';
import { creerEprouverSource } from './agent/eprouver-source';
import { GatewayChatClient } from './agent/llm/chat-client';
import { consommateurAgent, consommateurMba } from './agent/consommateur';
import { type OutilAPublier } from './mba/publication';
import { outilsAPublier } from './mba/outils-a-publier';
import { blocsProposables } from './mba/outils-maison';
import { creerGestesEnvoi } from './mba/gestes-envoi';
import { creerSignalerEchecTardif } from './mba/signaler-echec-tardif';
import { creerAttendreFinDuTour } from './mba/fin-de-tour';
import { cleAJour, depsCleRelaisDepuis } from './mba/cle-relais';
import { creerAppliquerGeste } from './mba/appliquer-publication';
import { baseDuRelais } from './mba/relais';
import { resolveursSimulation } from './agent/resolvers/simulation';
import { JOURNAL_MUET } from './agent/journal-muet';
import { installGracefulShutdown, arreterApi } from './shutdown';
import { creerTravauxEnVol } from './lib/en-vol';
import { ATTENTE_GESTES_A_L_ARRET_MS } from './http/mba-relais';
import { catalogueBranchable } from './http/agent-setup';
import type { CountryCode } from 'libphonenumber-js';
import { handlerMaison } from './agent/outils-maison';
import type { TemplateSummary } from './meta/templates';
import { tenter } from './lib/tenter';
import { messageDe } from './lib/erreur';
import { PgStripeStore } from './stripe/store.pg';
import { estCleLive, FetchTransportStripe } from './stripe/client';
import { creerPayeurAutorise, type CreditPaiementRouteDeps } from './http/credit-stripe';
import type { AgentsRouteDeps } from './http/agents';
import type { AgentTestRouteDeps } from './http/agent-test';
import type { AgentKnowledgeRouteDeps } from './http/agent-knowledge';
import type { DepsConnaissance } from './agent/connaissance';
import type { Origine } from './reglages/historique';
import { creerOffreDeBienvenue } from './account/offre-bienvenue';

/** Le nom de cette copie de l'API dans `/ops` et dans ses alertes : `api` seule, `api-<copie>` à plusieurs (`API_COPIE`). */
const NOM_API = config.API_COPIE === '' ? 'api' : `api-${config.API_COPIE}`;

async function main(): Promise<void> {
  /**
   * Les deux bases d'adresses publiques, résolues une fois. `PUBLIC_API_URL` vide rend exactement ce que
   * `APP_URL` rendait : la règle et son cas particulier vivent dans `src/lib/adresses-publiques.ts`.
   */
  const adressesApi = adressesPubliques(config.APP_URL, config.PUBLIC_API_URL);

  // L'API ne fait qu'EMPILER : elle PRÊTE son pool applicatif à pg-boss, qui n'en ouvre aucun à lui. Une copie de
  // l'API ne retient donc plus aucune connexion de session, et N copies ne multiplient plus `PGBOSS_MAX` (lu par le
  // seul worker). Prêter éteint aussi la migration, la supervision et l'écoute : c'est le worker qui les fait
  // (`PgBossQueue`). Contrepartie : un enfilement, donc l'accusé d'un webhook de Meta, attend sur le MÊME pool
  // que les requêtes de la console, ce que mesure `mesureAttentePool`.
  const queue = new PgBossQueue(pool, config.PGBOSS_SCHEMA);
  // Un event `error` de pg-boss non capté est une exception non gérée qui tue l'API. On le journalise
  // et on laisse tourner : une saturation ponctuelle du pooler ne doit pas coûter un redémarrage.
  // eslint-disable-next-line no-console
  queue.onError((err) => console.error('[pg-boss:api]', messageDe(err)));
  await queue.start();

  /**
   * Le socle commun avec le worker (`src/socle.ts`) : les dépôts, le dépôt de contacts qui annonce chaque opt-out
   * (au connecteur du client et aux signaux), l'émetteur de signaux, la pile d'envoi Meta et ses freins, le
   * résolveur e-mail et le runtime de scénario. Appelé une fois : ses caches sont ceux de ce processus, et les
   * routes qui les invalident (numéro délié, comptes e-mail, réglage des signaux) visent ces instances-là.
   * Tout ce qui suit ne vit que dans l'API.
   */
  const {
    transport, repo, recipientStore, integrationBatch, espacesBatch, emetteur, contactStore, fieldStore, inboxStore,
    settingsStore, flowStore, idempotencyStore, auditStore, erreursLivraison, echecsMessages, poolAttentesStore,
    httpLatencesStore, mesuresTachesStore, nodeEventStore, trackedLinkStore, webhookStore, verrousCourts, compteurDebit, phoneStatusStore, opsStore, heartbeatStore, workflowStore,
    automationStore, agentStore, knowledgeStore, rechercheSemantique, toolCatalog, journalAppels, credits,
    agentSources, agentRequetes, essaisStore, depotAide, emailAccounts, emailTemplates, emailResolver, wabaDeLEspace,
    numeroDelieStore, gardeNumeroDelie, esCredentialsStore, metaCredentials, metaFactory, connexionsPub, publicites,
    clientPubs, clientCreationPubs, workflowRuntime, clesGateway, fil, listeDeLAgent,
  } = construireSocle({ pool, queue, config });

  const campaignDraftStore = new PgCampaignDraftStore(pool);
  const contactHistoryStore = new PgContactHistoryStore(pool);
  const templateHintStore = new PgTemplateHintStore(pool);
  const tagStore = new PgTagStore(pool);
  const statsStore = new PgStatsStore(pool);
  const performanceStore = new PgPerformanceStore(pool);
  // Agrégats d'analyse de conversation. `enabled` = état de la feature côté serveur (empty-state différencié).
  // La rétention vient de la même variable que la purge du worker (`CONVERSATION_RETENTION_DAYS`) : l'écran
  // annonce le nombre réellement appliqué. Hors du socle : le worker construit le sien pour écrire les agrégats,
  // avec `enabled` à `true`, que seul l'affichage lit.
  const conversationStatsStore = new PgConversationStatsStore(pool, config.CONVERSATION_ANALYSIS_ENABLED === 'true', config.CONVERSATION_RETENTION_DAYS);
  const userStore = new PgUserStore(pool);
  const authTokenStore = new PgAuthTokenStore(pool);
  const apiKeyStore = new PgApiKeyStore(pool);
  const oauthStore = new PgOauthStore(pool);
  const reportStore = new PgWorkflowReportStore(pool);
  // L'email de l'acteur est résolu ICI, une fois, et écrit en clair dans le journal : une jointure sur `users`
  // rendrait l'historique illisible au premier départ d'un collaborateur.
  const auditSink: AuditSink = async (tenant, actor, action, target, detail) => {
    const email = actor.userId ? (await userStore.getSessionUser(actor.userId))?.email ?? null : null;
    await auditStore.record(tenant, { userId: actor.userId, email }, action, target, detail);
  };
  /**
   * Le second facteur des administrateurs. Ses secrets sont chiffrés avec `ENCRYPTION_KEY`, comme les jetons
   * Meta que cette API chiffre déjà.
   */
  const mfaStore = new PgMfaStore(pool, config.ENCRYPTION_KEY);
  /**
   * Les adresses de l'exploitation : elles seules ouvrent `/ops`, avec leur second facteur. Vide = fermé. Une
   * seule liste pour la connexion, la garde de `/ops` (toutes deux par `auth`) et le lien du menu (`me`).
   */
  const opsEmails = config.OPS_EMAILS.split(',').map((a) => a.trim()).filter((a) => a !== '');
  /**
   * Une ligne d'audit par espace de l'identité : le facteur est celui de la personne, et chacun de ses espaces
   * doit pouvoir lire qu'il a été posé, utilisé ou retiré. L'acteur est son compte dans cet espace, ou, quand
   * c'est l'exploitation qui agit, l'adresse de l'exploitant (`exploitant`), qui n'a pas de compte ici.
   */
  const auditParIdentite = async (
    identityId: string,
    action: ActionMfa | 'mfa.reinitialise',
    detail: Record<string, unknown> = {},
    exploitant?: string,
  ): Promise<void> => {
    for (const c of await mfaStore.comptes(identityId)) {
      await auditStore.record(
        c.tenantId,
        exploitant === undefined ? { userId: c.userId, email: c.email } : { userId: null, email: exploitant },
        action,
        { kind: 'user', id: c.userId },
        detail,
      );
    }
  };
  // Lecture seule, pour le suivi de consommation d'un agent. Le store d'écriture des sessions vit dans le
  // câblage du worker (`src/workflow/wiring.ts`) : l'API ne fait qu'agréger.
  const agentSessions = new PgAgentSessionStore(pool);
  const mcpStore = new PgMcpStore(pool);

  /**
   * Le relais du Meta Business Agent. `adresseDuRelais` est `null` quand `PUBLIC_API_URL` est vide : la
   * publication refuse alors en le disant plutôt que de poser chez Meta un connecteur qui n'appelle rien.
   */
  const adresseDuRelais = (): string | null => baseDuRelais(config.PUBLIC_API_URL);
  /**
   * Les outils exposés à l'agent de Meta, tels qu'ils partent chez Meta : appels de connecteur, gestes maison et
   * outils MCP. Le tri vit dans `src/mba/outils-a-publier.ts`, testé.
   */
  const outilsPourMeta = async (tenant: string, pn: string): Promise<OutilAPublier[]> =>
    outilsAPublier(
      // Les lignes d'écran, qui portent la cause d'inappelabilité du catalogue : un outil mort ne part pas.
      (await toolCatalog.listToutesConsommateur(tenant, consommateurMba(pn))).filter((o) => o.actif),
      (id) => agentRequetes.parId(tenant, id),
    );
  /** La clé « Agent de Meta », par acteur : la fabrique et son audit vivent dans `src/mba/cle-relais.ts`. */
  const depsCleRelaisPour = depsCleRelaisDepuis({ cles: apiKeyStore, reglages: settingsStore, audit: auditSink });
  /**
   * `null` quand le jeton Vercel n'est pas configuré : le provisionnement est éteint et la création d'agent
   * se passe de clé propre.
   */
  const provisionCle: DepsProvisionCle | null = config.VERCEL_API_TOKEN !== '' && config.VERCEL_TEAM_ID !== ''
    ? {
      cles: clesGateway,
      credits,
      nomEspace: async (tenant) => {
        const r = await pool.query<{ name: string }>('select name from tenants where id = $1', [tenant]);
        return r.rows[0]?.name ?? null;
      },
      transport: new FetchTransport(),
      jetonCompte: config.VERCEL_API_TOKEN,
      teamId: config.VERCEL_TEAM_ID,
      cleGatewayMaison: config.AI_GATEWAY_API_KEY,
      tauxEurParDollar: config.EUR_PER_USD,
      journal: (msg, err, tenant) => { journaliser('error', msg, { err, tenantId: tenant, pour: 'cle_modele' }); },
    }
    : null;

  // Vide -> la conversation de construction répond 503, aucun crash au boot.
  // 🔴 Le 3e argument est le résolveur de clé par espace : sans lui, tous les appels partiraient sur la clé
  // maison et aucune dépense ne serait attribuée au client. Seul `gatewayAide`, juste en dessous, s'en passe.
  const gateway = config.AI_GATEWAY_API_KEY
    ? new GatewayChatClient(config.AI_GATEWAY_API_KEY, undefined, async (tenant) => (await clesGateway.lire(tenant))?.cle ?? null)
    : null;
  /**
   * Le client du bot d'aide, construit sans résolveur de clé par espace.
   * 🔴 C'est ce qui fait que nous payons : `cleDe` rend la clé maison quand le résolveur est absent
   * (`src/agent/llm/chat-client.ts`). Lui passer le résolveur facturerait l'aide au crédit prépayé du client.
   * La dépense est bornée par le plafond d'équipe posé chez Vercel et par le plafond de débit par espace de
   * la route (`src/http/aide.ts`).
   */
  const gatewayAide = config.AI_GATEWAY_API_KEY ? new GatewayChatClient(config.AI_GATEWAY_API_KEY) : null;

  /**
   * L'historique des réglages, partagé par les deux assistants et par les formulaires : un historique qui
   * ignorerait les gestes d'écran mentirait par omission.
   */
  const historiqueStore = new PgHistoriqueStore(pool);
  /** Il n'y a aucun espace pour le compte de qui l'aide est appelée : la dépense est la nôtre. */
  const AUCUN_ESPACE_PAYEUR = '';
  /**
   * Le traducteur des conversations.
   * 🔴 Il prend `gateway`, jamais `gatewayAide` : la traduction sert les conversations du client, donc elle
   * tombe sur son crédit prépayé, quand l'aide de la console est à notre charge. Les deux clients se
   * ressemblent à une lettre près et n'ont pas le même payeur.
   * Chaque traduction est DÉBITÉE du solde au prix client, comme un tour d'agent (même taux, même commission). Un
   * solde vide ne traduit pas. `assurerCle` ouvre la clé de l'espace à sa première traduction s'il a du crédit : un
   * espace sans clé ne retombe jamais en silence sur la clé maison comme `cleDe` (nous paierions alors les
   * traductions de tous les espaces sans clé).
   * `TRADUCTION_MODELE` vide -> traduction éteinte : le fil sort en VO, le bouton sortant refuse en 422.
   */
  const traductionStore = new PgTraductionStore(pool);
  /** Les clients Stripe des espaces et les paiements déjà crédités (migration 0191). L'API seule s'en sert. */
  const stripeStore = new PgStripeStore(pool);
  /**
   * Les travaux qu'une réponse laisse en route : les gestes du relais de l'agent de Meta (un envoi attend la fin du
   * tour de l'agent, une quinzaine de secondes), le signal d'un clic sur un lien suivi, l'ouverture d'une clé de
   * modèle pour une première traduction, et la remontée d'un plafond après un crédit. L'arrêt de cette copie les
   * attend avant de fermer la file et le pool. ⚠️ Déclaré ICI, avant le traducteur qui en a besoin.
   */
  const travauxEnVol = creerTravauxEnVol();
  const traducteur = gateway && config.TRADUCTION_MODELE
    ? creerTraducteur({
      client: gateway,
      modele: config.TRADUCTION_MODELE,
      credit: credits,
      assurerCle: creerAssureurDeCle({
        cles: clesGateway,
        provision: provisionCle,
        journal: (msg, err, tenantId) => { journaliser('error', msg, { err, tenantId, pour: 'traduction' }); },
        travaux: travauxEnVol,
      }),
      tauxEurParDollar: config.EUR_PER_USD,
      commissionPct: config.COMMISSION_MODELE_PCT,
    })
    : null;
  // Chaîne WhatsApp (Channels Me). La clé de chiffrement est injectée au store (contrat du sous-système), pas
  // relue depuis la config à l'intérieur : les deux secrets sont chiffrés là, jamais plus haut.
  const channelsMeConnections = new PgChannelsMeConnectionStore(pool, config.ENCRYPTION_KEY);
  const channelsMeLinks = new PgChannelsMeLinkStore(pool);
  const channelsMePosts = new PgChannelsMePostStore(pool);
  // Les widgets WhatsApp : le script public les lit par leur code, le contrôle des liens de chaîne par leur phrase.
  const widgetStore = new PgWidgetStore(pool);
  // Hôte fixe et de confiance : aucune vérification d'adresse privée, même traitement que Meta et Zadarma.
  const channelsMeClient = new ChannelsMeClient();
  const rcsMessageStore = new PgRcsMessageStore(pool);
  const rcsMediaStore = new PgRcsMediaStore(pool);
  // Le cache de joignabilité RCS : lu par la fiche de l'API publique, écrit par le rapport de livraison
  // smsmode (`traiterRapportRcs`). L'envoi a le sien dans `rcsStack`.
  const rcsJoignabilite = new PgReachabilityStore(pool);
  // Clients Meta phone/pricing/templates/flows : résolus par tenant via metaFactory. `media` reste global :
  // endpoint /{appId}/uploads app-scoped.
  const mediaClient = new MetaMediaClient(config.META_ACCESS_TOKEN, config.META_APP_ID, config.META_GRAPH_VERSION);

  // Hors du câblage de l'écran parce qu'ils ont deux consommateurs : les routes de l'écran Publicités, et la
  // route `/ops` qui dépose un jeton créé à la main. Les construire deux fois donnerait deux chemins de
  // chiffrement à tenir alignés. Le jeton se chiffre et se déchiffre dans `src/pubs/connexion.ts`, seul.
  const connexionPub = creerConnexionPub({
    client: clientPubs,
    connexions: connexionsPub,
    cleChiffrement: config.ENCRYPTION_KEY,
  });
  const brouillonsPub = new PgBrouillonsPubStore(pool);

  /**
   * Ce qu'il faut pour agir sur le compte publicitaire d'un espace : le compte, la Page, et le jeton en clair. Un
   * seul endroit pour les deux refus (pas connecté, connexion incomplète), que les routes traduisent en 409 : la
   * création et le dépôt vidéo ne doivent pas diverger sur ce qu'« être connecté » veut dire.
   */
  const accesPub = async (t: string): Promise<{ comptePubId: string; pageId: string; jeton: string }> => {
    const etat = await connexionsPub.lire(t);
    if (etat === null) throw new PasDeConnexionPub();
    if (etat.comptePubId === null || etat.pageId === null) throw new ConnexionPubIncomplete();
    return { comptePubId: etat.comptePubId, pageId: etat.pageId, jeton: await connexionPub.jetonClair(t) };
  };

  // Envoi d'email auth (liens reset/invitation) : seulement si Resend est configuré, sinon undefined.
  const sendAuthEmail = config.RESEND_API_KEY
    ? async ({ to, subject, text, html }: { to: string; subject: string; text: string; html?: string }) => {
        await new ResendClient(config.RESEND_API_KEY).send({ from: `Messaging Me <${config.SUPPORT_FROM}>`, to, subject, text, ...(html ? { html } : {}) });
      }
    : undefined;
  /**
   * Le chiffrage : toutes les lectures de coût (statistiques, fiche contact, `/ops`), leur tarif Meta sous
   * micro-cache et la marge. Construit une fois, donc un cache de tarifs par process ; le worker, qui
   * n'affiche aucun tarif, ne le construit pas. Tout vit dans `src/stats/chiffrage.ts`, exécuté par ses tests.
   */
  const chiffrage = creerChiffrage({
    stats: statsStore,
    waba: repo,
    meta: metaFactory,
    historique: contactHistoryStore,
    scenarios: workflowStore,
    liens: trackedLinkStore,
    evenements: nodeEventStore,
    retentionJours: config.CONVERSATION_RETENTION_DAYS,
  });

  /** Micro-cache de la pastille du numéro : dix minutes, très en deçà de la durée de vie de l'URL signée. */
  const photoNumeroCache = cacheCourt<string | null>(10 * 60_000);

  /**
   * Micro-cache du catalogue de modèles du Gateway : une heure. Il ne bouge pas d'une minute à l'autre et
   * sert un menu déroulant ; sans cache, chaque ouverture de l'onglet Modèle referait un aller-retour de
   * plusieurs centaines de millisecondes vers Vercel.
   */
  const catalogueModelesCache = cacheCourt<ModeleGateway[]>(60 * 60_000);

  /**
   * Micro-cache du catalogue des templates de `GET /v1/templates` : une minute, par espace et par WABA.
   * Route publique, donc appelable en boucle : sans cache, chaque appel relirait la liste complète du WABA
   * chez Meta (jusqu'à vingt pages), épuiserait le quota de gestion du WABA, et `isMetaAuthError` prendrait
   * ce refus pour une panne d'authentification, invalidant le jeton et bloquant les envois de l'espace.
   * Un échec de Meta n'est pas gardé (`list` lève, `cacheCourt` ne garde pas un rejet). Un espace sans WABA
   * n'y entre pas (la clé porte le WABA).
   */
  const catalogueTemplatesCache = cacheCourt<TemplateSummary[]>(60_000);

  // Les dépendances du consentement posé par l'API : la même construction que `/v1/contacts`
  // (`depsConsentementDe`, que `creerServiceContactsV1` appelle aussi), jamais une seconde écrite à la main.
  const depsConsentement = depsConsentementDe(contactStore, auditSink);

  /**
   * L'envoi RCS libre, partagé par le bouton RCS de l'Inbox et par `POST /v1/messages/rcs`. Les gardes
   * vivent dans `envoyerRcsLibre`, testée ; ce bloc ne fait que brancher.
   */
  const depsRcsLibre: DepsRcsLibre = {
    agents: workflowRuntime.rcsStack.agents,
    estDesabonne: (t, waId) => contactStore.estDesabonneParWaId(t, waId),
    estDesabonneRcs: (t, e164) => workflowRuntime.rcsStack.optout.isOptedOut(t, e164),
    aConsentiOuEcrit: (t, waId) => contactStore.aConsentiOuEcritParWaId(t, waId),
    joignabilite: rcsJoignabilite,
    messages: rcsMessageStore,
    variablesDeLaFiche: async (t, waId) => contactVars(await contactStore.getResolvableByPhone(t, waId) ?? {}),
    jetonDuContact: async (t, waId) => (await trackedLinkStore.jetonPourE164(t, waId, fabriquerJeton).catch(() => null)) ?? undefined,
    sender: workflowRuntime.rcsStack.sender,
    nouvelId: () => randomUUID(),
    maintenant: () => Date.now(),
  };

  /**
   * Les dépendances de `repondreDansLaFenetre`, branchées une fois pour ses trois appelants (réponse de
   * l'Inbox, `POST /v1/messages/whatsapp`, serveur MCP) : une garde qui change (fenêtre de 24 h,
   * désabonnement, prise du fil) change pour les trois. `satisfies` porte ici le contrôle des clés en trop,
   * parce qu'il ne traverse pas les spreads qui suivent.
   */
  const depsRepondre = {
    inbox: inboxStore,
    repo,
    sendReply: async (tenant: string, phoneNumberId: string, to: string, text: string) => {
      const client = await metaFactory.clientForTenant(tenant, phoneNumberId); // token par tenant, repli global
      return (await client.sendText(to, text)).messageId;
    },
    /**
     * 🔴 L'opérateur est exempté par la condition dans `repondreDansLaFenetre` (la garde ne se pose que sur
     * une origine machine), pas par l'absence de cette dépendance, que le type exige partout.
     */
    estDesabonne: (tenant: string, waId: string) => contactStore.estDesabonneParWaId(tenant, waId),
    /**
     * Qui écrit prend le fil : le scénario cesse d'avancer tout seul et l'agent de Meta cesse de répondre.
     * Écrire suffit côté Meta (« Sending a message to a conversation takes control implicitly », et mesuré) :
     * retirer le contact de la liste de l'agent sur un chemin d'envoi serait une redondance payante ; c'est le
     * geste de « Reprendre la main » (`reprendreLaMain`). Une campagne part quand même : un opérateur l'a déclenchée, et elle reprend la
     * conduite du fil (la politique de `campagne_scenario`, `src/workflow/lancements.ts`, tenue par
     * `tests/workflow-lancements.test.ts`).
     * `app_human` aussi pour une machine (API publique, agent tiers par MCP) : `ControlOwner` n'a que trois
     * valeurs et celle-ci produit l'effet voulu. Qui a parlé est porté par l'origine du message (`api`, `mcp`).
     */
    takeControl: fil.prisEnEcrivant,
  } satisfies DepsRepondre;

  /**
   * Les widgets WhatsApp, pour leurs DEUX portes : l'écran de la console et les outils MCP (lot 5 du widget). Un seul
   * objet, donc un seul numéro (celui du script public : le lien `wa.me` montré est celui que la bulle ouvrira) et une
   * seule adresse de script (sur l'API, comme celle d'un webhook entrant).
   */
  const widgetsDeLaConsole: DepsWidgets = {
    gestion: gestionDesWidgetsEnBase(pool),
    numero: (tenant) => phoneStatusStore.getPhoneNumber(tenant),
    baseApi: adressesApi.avecPrefixe,
  };

  /**
   * Les numéros fournis (lot 3a) : la réserve, lue et écrite par `/ops`, et le pont du code, que l'Asterisk appelle.
   * La transcription d'un appel de Meta part sur NOTRE clé, comme celle des vocaux : ce n'est la dépense d'aucun client.
   */
  const numerosFournis = new PgNumerosFournisStore(pool);
  /** L'abonnement du numéro fourni (lot 3c, livraison B, migration 0214) : écrit par le webhook, lu par la page et Claude. */
  const abonnementsNumero = new PgAbonnementsNumeroStore(pool);
  /**
   * Le numéro WhatsApp connecté à un espace, en chiffres (`''` si son affichage est inconnu). Le MÊME pour la page du
   * numéro fourni, la garde du lien de Claude Code (qui meurt à la connexion) et son outil d'attente (lot 3c).
   */
  const numeroConnecte = async (tenant: string): Promise<{ chiffres: string; aActiver: boolean } | null> => {
    const pn = await phoneStatusStore.getPhoneNumber(tenant);
    if (!pn) return null;
    // « À activer » : la règle de l'Accueil, un statut lu et différent de `CONNECTED`.
    return { chiffres: (pn.displayPhoneNumber ?? '').replace(/[^0-9]/g, ''), aActiver: pn.status != null && pn.status !== 'CONNECTED' };
  };
  const transcrireAppelOtp = async (audio: Buffer): Promise<string> => {
    if (!config.AI_GATEWAY_API_KEY || !config.TRANSCRIPTION_MODELE) throw new Error('transcription non configurée');
    const r = await transcrire(new FetchTransport(HTTP_TIMEOUT_MODELE_MS), {
      cle: config.AI_GATEWAY_API_KEY, modele: config.TRANSCRIPTION_MODELE, bytes: audio, mime: 'audio/wav',
    });
    return r.texte;
  };

  /**
   * Le répondeur de l'espace (lot 5, `src/repondeur/reglage.ts`), pour ses DEUX portes : la route de la console et
   * l'outil MCP `set_default_responder`. Il éteint l'agent de Meta par le chemin de l'Accueil (`activationPour`, la
   * même construction que `PUT .../mba-activation`) et retire ses contacts de sa liste par le seul module qui la touche.
   * Le modèle est disponible quand la clé du Gateway est posée : la condition à laquelle le worker consomme les tours.
   */
  const repondeurDeLaConsole: DepsReglageRepondeur = {
    agents: agentStore,
    reglages: settingsStore,
    gatewayDisponible: config.AI_GATEWAY_API_KEY !== '',
    eteindreAgentDeMeta: (tenant) => appliquerActivation(
      activationPour({ repo, meta: metaFactory, reglages: settingsStore, attendre: (ms) => dormir(ms) }), tenant, false,
    ),
    liste: listeDeLAgent,
    historique: historiqueStore,
    fils: fil,
  };

  /**
   * L'agent IA, sa connaissance, son bac à sable et le paiement du crédit, pour leurs DEUX portes : les routes de la
   * console et les outils MCP de l'agent (lot 8a). Un seul objet chacun, comme les widgets : un outil MCP n'est
   * qu'un second appelant des fonctions de la console, avec les mêmes dépôts et la même clé de modèle.
   */
  const agentsDeLaConsole: AgentsRouteDeps = {
    agents: agentStore,
    // Le modèle d'un agent neuf vient de la configuration serveur ; le client choisira ensuite dans l'écran
    // de réglage. `AGENT_MODEL` d'abord, `LLM_MODEL` en repli seulement (raison dans `src/config.ts`).
    modeleParDefaut: config.AGENT_MODEL || config.LLM_MODEL,
    // Lecture seule : le client voit ce qui lui reste, il ne se recharge pas lui-même (cf. /ops).
    credits,
    // Absente quand le provisionnement est éteint : la création d'agent se passe alors de clé propre.
    ...(provisionCle ? { assurerCleModele: (tenant: string) => assurerCleGateway(provisionCle, tenant) } : {}),
    // Chaque modification de la fiche y laisse sa ligne `fiche_agent`, avec son auteur et sa porte.
    historique: historiqueStore,
    // Un agent qui quitte le statut actif cesse d'être le répondeur de l'espace (lot 5).
    oublierRepondeur: (tenant, agentId) => settingsStore.oublierRepondeurSi(tenant, agentId),
    repondeur: repondeurDeLaConsole,
    sessions: agentSessions,
    // Le blocage dur avant activation (un agent activé finira par écrire à de vrais clients) : il lit la
    // fiche, la connaissance, et les outils actifs avec leurs handlers, parce que le compte seul ne dit pas
    // quel outil précis manque.
    etatPourLint: async (tenant, agentId) => {
      const fiche = await agentStore.complet(tenant, agentId);
      if (!fiche) return null;
      // Le troisième est un avertissement, pas un manque : un serveur tiers qui change son schéma éteint le
      // consentement d'un outil, mais ne doit pas empêcher le client d'activer son agent.
      const [fiches, outils, debranches] = await Promise.all([
        knowledgeStore.lister(tenant, agentId),
        toolCatalog.listActifs(tenant, agentId),
        mcpStore.debranchesParRafraichissement(tenant, consommateurAgent(agentId)),
      ]);
      return {
        fiche: fiche.contenu,
        fichesConnaissance: fiches.length,
        outilsActifs: outils.length,
        handlersActifs: outils.map(handlerMaison).filter((h) => h !== ''),
        outilsMcpDebranches: debranches,
      };
    },
    /**
     * Les modèles proposables et leur tarif. La liste est la nôtre (`MODELES_CHOISIS`), les prix viennent du
     * Gateway en direct : figés dans le code, ils seraient faux au premier changement de tarif.
     * 🔴 La clé du Gateway ne quitte jamais le serveur : la console reçoit des identifiants et des euros.
     */
    modelesProposes: () => catalogueModelesCache.lire('catalogue', () => lireCatalogueGateway(fetchGet, config.AI_GATEWAY_API_KEY))
      .then((catalogue) => modelesProposables(catalogue, config.EUR_PER_USD, config.COMMISSION_MODELE_PCT)),
  };

  /**
   * 🔴 Pas de corbeille : une fiche de connaissance supprimée disparaît de `agent_knowledge`, et cette ligne est le
   * seul exemplaire de ce que le robot savait dire, et la seule réponse à « qui l'a retirée ? ». Une par porte :
   * la console signe `formulaire`, le serveur MCP `mcp` (l'historique dit alors « par Claude »).
   */
  const journaliserSuppressionDe = (origine: Exclude<Origine, 'assistant'>): DepsConnaissance['journaliserSuppression'] =>
    (tenant, agentId, l) => historiqueStore.ecrire(tenant, {
      surface: 'agent', surfaceId: agentId, element: 'connaissance', operation: 'suppression',
      cible: l.cible, libelle: l.libelle, avant: l.avant, apres: null,
      origine, acteurEmail: null, acteurId: l.acteurId,
    });
  const connaissanceDeLaConsole: AgentKnowledgeRouteDeps = {
    connaissance: knowledgeStore,
    // Les suppressions d'abord, comme pour le MBA : une création ratée se refait, une suppression non.
    journaliserSuppression: journaliserSuppressionDe('formulaire'),
    fetchUrl: fetchUrlBorne(),
  };

  const essaiDeLaConsole: AgentTestRouteDeps = {
    // L'historique des essais (14 j). Il ne conditionne rien : sans lui, l'essai marche et l'écran
    // n'affiche aucune trace.
    essais: essaisStore,
    // Le modèle du bac à sable est celui de la fiche de l'agent : le seul prérequis est la clé du Gateway,
    // sans lien avec LLM_MODEL (désactiver l'analyse de conversation ne doit pas couper /test).
    disponible: gateway !== null,
    // 🔴 Un essai consomme pour de vrai : les outils à effet sont simulés, l'appel de modèle ne l'est pas.
    // Même solde et même garde qu'en production, sinon la console offrirait une porte gratuite sur un
    // compte prépayé. Le mouvement n'a pas de session : la note l'explique dans le journal.
    credits,
    debiter: async (tenant, montant, note) => { await credits.debiter(tenant, montant, { note }); },
    ...(gateway ? {
      cerveau: {
        client: gateway,
        // Point de lecture partagé avec le tour de production : le bac à sable montre exactement ce que la
        // production ferait, modèle et politiques compris.
        contexte: (tenant, agentId) => lireContexteAvecReglages({ agents: agentStore, outils: toolCatalog, reglages: settingsStore }, tenant, agentId),
        // Même taux et même commission qu'en production : un essai annonce, et débite, ce que la conversation
        // coûterait vraiment.
        tauxEurParDollar: config.EUR_PER_USD,
        commissionPct: config.COMMISSION_MODELE_PCT,
        outils: {
          catalogue: toolCatalog,
          // Muet : les essais n'ont pas à apparaître comme des pannes dans le journal que le client consulte.
          journal: JOURNAL_MUET,
          // Le bac à sable reçoit la même recherche que la production : il n'a de valeur que s'il rend
          // exactement ce qu'elle rendrait. Les trois origines ont leur résolveur (le type impose la liste
          // complète) : une origine non traitée arrêterait net un essai. Un connecteur qui lit part pour de vrai,
          // par le même résolveur que la production (`creerResolveurHttp`, comme `src/worker.ts`) ; le reste est simulé.
          resolveurs: resolveursSimulation({
            connaissance: knowledgeStore,
            ...(rechercheSemantique ? { recherche: rechercheSemantique } : {}),
            connecteurs: {
              requetes: agentRequetes,
              reel: creerResolveurHttp({
                // Muette elle aussi : un essai ne note pas la santé de la source. Réussi, il effacerait la dernière
                // erreur réelle de production ; raté faute de contact, il afficherait une panne qui n'en est pas une.
                sources: { pourAppel: (t, id) => agentSources.pourAppel(t, id), marquerEpreuve: async () => {} },
                requetes: agentRequetes,
                inbox: inboxStore,
                fiche: contactStore,
                fuseau: async (t) => (await settingsStore.get(t)).timezone,
              }),
            },
          }),
          // Rien à compter : sans session, pas de compteur. Le plafond d'appels du tour est tenu en mémoire
          // par la boucle du cerveau.
          sessions: { compterAppel: async () => {} },
          /**
           * 🔴 Le bac à sable n'exécute aucun geste, même doctrine que `connecteurSimule` : un essai ne doit
           * pas toucher les données réelles d'un client (vrai tag, vraie fiche).
           * Dette assumée : il ne montre pas non plus les gestes qu'un moment déclencherait, alors qu'il
           * promet « exactement ce que l'agent fera ». Suivi dans
           * `docs/superpowers/plans/2026-09-18-moments-agent-ia.md`, section « État d'exécution ».
           */
          executerGeste: async () => {},
        },
        alerter: (m: string) => console.error(`[agent] ${m}`),
      },
    } : {}),
  };

  const paiementDeLaConsole: CreditPaiementRouteDeps = {
    stripe: config.STRIPE_SECRET_KEY !== ''
      ? {
        cle: config.STRIPE_SECRET_KEY,
        livemode: estCleLive(config.STRIPE_SECRET_KEY),
        prix: { refill_50: config.STRIPE_PRIX_REFILL_50, refill_100: config.STRIPE_PRIX_REFILL_100 },
        transport: new FetchTransportStripe(),
        pageCredit: `${config.APP_URL.trim().replace(/\/+$/, '')}/parametres/credit`,
      }
      : null,
    clients: stripeStore,
    // 🔴 En mode test, seul un exploitant (`OPS_EMAILS`) paie : sinon, le temps des essais, n'importe quel admin
    // client recevrait de vrais euros de modèle contre une carte de test. La règle et son test :
    // `creerPayeurAutorise`, `tests/http-credit-stripe.test.ts`.
    payeurAutorise: creerPayeurAutorise({
      livemode: estCleLive(config.STRIPE_SECRET_KEY),
      adresseDe: async (userId: string) => (await userStore.getById(userId))?.email ?? null,
      estExploitant: (adresse: string) => estAdresseOps(opsEmails, adresse),
    }),
    // La facture d'un achat, relue dans les paiements de l'espace (lien « Facture » de la page Crédit IA).
    factures: stripeStore,
  };

  /**
   * L'abonnement du numéro fourni (lot 3c) : le MÊME Stripe, les MÊMES clients et la MÊME règle du mode test que la
   * recharge, plus le prix mensuel du numéro et l'adresse de la console où Stripe renvoie.
   */
  const abonnementDuNumero: DepsAbonnement = {
    stripe: paiementDeLaConsole.stripe,
    clients: paiementDeLaConsole.clients,
    payeurAutorise: paiementDeLaConsole.payeurAutorise,
    prixNumero: config.STRIPE_PRIX_NUMERO,
    urlConsole: config.APP_URL,
  };

  // La durée de chaque requête, par route normalisée : mesurée par le serveur, vidée en base avec l'attente du pool.
  const mesureLatence = new MesureLatenceHttp();

  const app = buildServer({
    /**
     * 🔴 Le compteur des plafonds de débit, PARTAGÉ par toutes les copies de l'API (migration 0186). Oublié,
     * `buildServer` retomberait sur un compteur en mémoire : chaque copie servirait alors chaque plafond pour elle
     * seule, sans erreur. `tests/debit-cablage.test.ts` tient cette ligne.
     */
    debit: compteurDebit,
    /**
     * L'alerte d'exploitation : les quotas quotidiens de l'API publique la lèvent quand leur compteur ne répond pas (les
     * appels passent alors, les quotas ne sont plus tenus). Absente, elle partirait seulement dans le journal.
     */
    alerter: (texte) => { void sendTelegram(`[mba-${NOM_API}] ${texte}`); },
    mesureLatence,
    /**
     * 🔴 Surveillance de `/ops`, qui ouvre la lecture de toutes les conversations de tous les clients alors
     * que Fastify tourne sans journal d'accès. L'accès est nominatif et exige le second facteur ; ses refus
     * restent rendus visibles. `sendTelegram` est un no-op sans Telegram : la surveillance journalise alors,
     * sans alerter. Compte et repos partagés par les copies : une alerte pour toutes, au seuil de toutes.
     */
    surveillanceOps: surveillerOps({
      alerter: (m) => { void sendTelegram(`[mba-${NOM_API}] ${m}`); },
      // eslint-disable-next-line no-console
      journaliser: (m) => { console.warn(m); },
      compteur: compteurDebit,
      verrous: verrousCourts,
    }),
    // Origines autorisées à appeler l'API depuis un navigateur. Vide -> aucun en-tête CORS. Les deux règles
    // qui la rendent sûre : `src/server.ts`.
    corsOrigins: config.CORS_ORIGINS.split(',').map((o) => o.trim()).filter((o) => o !== ''),
    queue,
    // Readiness : `select 1` (timeout court 2 s) -> /health 503 si la DB est injoignable. /live reste trivial.
    checkReadiness: makeDbReadinessCheck(pool, 2000),
    auth: {
      /**
       * L'acteur est le compte visé, pas l'auteur : personne n'est authentifié sur une connexion échouée.
       * L'email est donc résolu depuis ce compte, comme le fait `auditSink` pour un acteur ordinaire.
       */
      auditConnexion: async (tenant, userId, cause) => {
        const email = (await userStore.getSessionUser(userId))?.email ?? null;
        await auditStore.record(tenant, { userId, email }, 'connexion.echouee', { kind: 'user', id: userId }, { cause });
      },
      users: new PgUserAuthStore(pool),
      secret: config.AUTH_SECRET,
      // Re-vérif par requête : compte révoqué/supprimé -> 401 immédiat, rôle frais depuis la base.
      // Un rappel et non une tranche : c'est `makeRequireAuth` (`src/server.ts`) qui le consomme.
      getUserState: (userId) => userStore.getAuthState(userId),
      // Inscription libre, reset et changement de mot de passe, liaison Google par adresse.
      comptes: userStore,
      tokens: authTokenStore,
      appUrl: config.APP_URL,
      resetTtlMs: config.RESET_TOKEN_TTL_MS,
      // Se connecter avec Google : client public (bouton front) + vérif serveur du jeton ID + liaison par email.
      googleClientId: config.GOOGLE_CLIENT_ID,
      verifyGoogle: (idToken) => verifyGoogleIdToken(idToken, config.GOOGLE_CLIENT_ID),
      ...(sendAuthEmail ? { sendEmail: sendAuthEmail } : {}),
      // Le second facteur : obligatoire pour les admins, à la connexion, à l'inscription et à l'invitation.
      mfa: mfaStore,
      opsEmails,
      auditMfa: async (identityId, action, detail) => { await auditParIdentite(identityId, action, detail); },
    },
    import: {
      contacts: contactStore,
      userFields: fieldStore,
      defaultCountry: config.DEFAULT_COUNTRY as CountryCode,
      audit: auditSink,
    },
    campaigns: {
      repo,
      queue,
      drafts: campaignDraftStore,
      // Palier d'envoi du numéro, pour avertir avant un lancement plus gros que ce que Meta laissera passer
      // en 24 h. Lecture du relevé déjà persisté, aucun appel Graph sur ce chemin.
      getMessagingLimitTier: async (tenant) => (await phoneStatusStore.getPhoneNumber(tenant))?.messagingLimitTier ?? null,
      // La même résolution de cible que les actions en masse du mini-CRM : par l'intention, pas par une liste
      // d'identifiants qui ne tiendrait pas dans le corps de la requête.
      contacts: contactStore,
      // Le plafond de taille sur le chemin « tous les contacts », borné à `limite` : il fige son jeu
      // d'identifiants. `{ filters: {} }` sélectionne l'espace entier, et les contacts bloqués sont écartés au
      // chargement (`listContactsForBuildByIds`).
      identifiantsDeTousLesContacts: (tenant: string, limite: number) => contactStore.contactIdsForTarget(tenant, { filters: {} }, limite),
      plafondDestinataires: config.CAMPAIGN_MAX_RECIPIENTS,
      // 🔴 Garde d'isolation du canal RCS, symétrique de celle du numéro Meta : le partenaire RBM est global,
      // donc c'est ce contrôle qui empêche un tenant de créer une campagne sous la marque d'un autre.
      rcs: workflowRuntime.rcsStack.agents,
      // Garde d'un étage e-mail de la chaîne : `getById` est scopée tenant ET écarte les modèles supprimés
      // (suppression douce), donc elle rend null dans les deux cas où la clé étrangère aurait rendu une 5xx.
      emailTemplateBelongsToTenant: async (id, tenant) => (await emailTemplates.getById(tenant, id)) !== null,
      // Campagne au fil de l'eau : le webhook doit appartenir à l'espace et être actif. Même garde que pour le
      // numéro Meta et l'agent RCS, sur la troisième porte d'entrée des destinataires.
      webhookUsableByTenant: (id, tenant) => webhookStore.usableByTenant(tenant, id),
      getWorkflowGraph: async (wfId, tenant) => (await workflowStore.getById(wfId, tenant))?.graph ?? null,
      defaultRatePerMinute: config.CAMPAIGN_DEFAULT_RATE_PER_MINUTE,
      // Borne sûre pour l'estimation de durée : ces deux routes enfilent sans savoir le canal, et une
      // estimation trop optimiste fait expirer le job en plein envoi (pg-boss le rejoue, le débit double).
      plafondLePlusBas: plafondLePlusBas(config),
    },
    // Redirection publique des liens tracés. Le tenant vient du code retrouvé en base, jamais de l'URL.
    links: {
      liens: trackedLinkStore,
      // Le clic attribué devient un signal. L'espace vient du lien, comme pour le clic.
      signalerClic: (tenant, contactId, code) => emetteur.emettreSignal(tenant, signalDuClic(contactId, code)),
      // Le signal part après le 302 : l'arrêt de cette copie l'attend avant de fermer la file.
      enVol: travauxEnVol,
    },
    // Le script public de la bulle WhatsApp. L'espace vient du widget retrouvé par son code ; le numéro est celui
    // que l'écran Accueil affiche, et son état (délié ou non) décide de la bulle grisée.
    widgetPublic: {
      widgets: widgetStore,
      numero: (tenant) => phoneStatusStore.getPhoneNumber(tenant),
      qrSvg,
      budgetInconnus: new RateLimiter(config.CODES_INCONNUS_PAR_MINUTE, 60_000),
    },
    // Les mêmes widgets, côté console : l'objet que les outils MCP reçoivent aussi (`v1.mcp`).
    widgets: widgetsDeLaConsole,
    // Réception publique des webhooks entrants. L'appelant est un outil tiers : le tenant vient du code, et
    // l'écriture du contact passe par `upsertContactsFromApi`, le chemin partagé avec la console.
    webhookEntrant: {
      limiter: new RateLimiter(config.WEBHOOK_IN_RATE_LIMIT_MAX, config.WEBHOOK_IN_RATE_LIMIT_WINDOW_MS),
      budgetInconnus: new RateLimiter(config.CODES_INCONNUS_PAR_MINUTE, 60_000),
      webhooks: webhookStore,
      trouverWaId: async (tenant, waId) => ((await contactStore.findIdByWaId(tenant, waId)) ? waId : null),
      ecrireContact: async (tenant, entree) => {
        const [res] = await upsertContactsFromApi(
          tenant,
          [{
            phone: entree.phone,
            fields: entree.fields,
            ...(entree.name ? { name: entree.name } : {}),
            ...(entree.optIn ? { optIn: true, optInSource: entree.optInSource } : {}),
          }],
          { contacts: contactStore, fields: fieldStore },
        );
        // Un seul item entré, donc un seul résultat. L'absence de résultat serait un bug d'`upsertContactsFromApi`,
        // pas un cas métier : on le traite comme un refus plutôt que de laisser passer un succès imaginaire.
        if (!res) return { statut: 'error' as const, raison: 'contact non écrit' };
        return res.status === 'error'
          ? { statut: 'error' as const, ...(res.reason ? { raison: res.reason } : {}) }
          : { statut: res.status };
      },
      publish: async (tenantId, event) => {
        await enfilerEvenementAutomation(queue, { tenantId, event } satisfies AutomationEventJob);
      },
    },
    webhooksAdmin: {
      audit: auditSink,
      webhooks: webhookStore,
      workflowBelongsToTenant: async (wfId, tenant) => (await workflowStore.getById(wfId, tenant)) !== null,
      repo,
      baseUrl: adressesApi.avecPrefixe,
    },
    templates: {
      meta: metaFactory, // token par tenant, repli global
      repo,
      getPublishedFlow: (tenant, flowId) => flowStore.isPublished(flowId, tenant),
      indices: templateHintStore,
      // Traçage des liens : l'adresse publique est celle qui part dans les messages, donc elle suit l'API
      // (`adressesPubliques`), pas la console.
      tracking: {
        allocate: (tenant, cible, destination, avecJeton) => trackedLinkStore.allocate(tenant, newTrackingCode(), cible, destination, avecJeton),
        liens: trackedLinkStore,
        // Le lien soumis porte un suffixe variable, qui fera voyager le jeton du destinataire (qui a cliqué).
        // Les templates déjà approuvés gardent l'ancienne forme, leur URL étant figée chez Meta.
        lienDe: (code, avecJeton) => (avecJeton ? lienTraceAvecJeton(adressesApi.racine, code) : lienDe(adressesApi.racine, code)),
        // `adresse de redirection -> destination d'origine`, pour remontrer le lien saisi partout où la
        // console liste des templates. Les deux formes sont dans la map : les anciens templates portent
        // l'adresse nue, les récents le suffixe variable ; n'en mettre qu'une ferait réapparaître notre URL
        // de redirection à la place du lien saisi.
        destinations: async (tenant, noms) => new Map(
          (await trackedLinkStore.listByTemplates(tenant, noms)).flatMap((l) => [
            [lienDe(adressesApi.racine, l.code), l.destination] as [string, string],
            [lienTraceAvecJeton(adressesApi.racine, l.code), l.destination] as [string, string],
          ]),
        ),
      },
    },
    inbox: {
      // Les dépendances de la réponse (fenêtre, désabonnement, envoi, trace, prise du fil) : `depsRepondre`, dont
      // `inbox`, le dépôt des conversations que les routes lisent aussi.
      ...depsRepondre,
      audit: auditSink,
      /**
       * 🔴 La clé maison paie la transcription (un service offert). Le résolveur par espace existe
       * (`clesGateway.lire`) : le jour où elle se refacture, c'est cette ligne, et elle seule.
       */
      ...(config.AI_GATEWAY_API_KEY && config.TRANSCRIPTION_MODELE ? {
        transcrireMessage: (tenant: string, messageId: string, conversationId?: string, cible?: LangueConsole | null) => transcrireMessage({
          messages: inboxStore,
          /**
           * 🔴 La traduction d'un vocal est sur le crédit du client, la transcription sur notre clé : deux
           * payeurs dans le même geste, parce que la traduction sert les conversations du client.
           */
          ...(traducteur ? {
            traducteur,
            rangerTraduction: (t, m2, texte, langue) => traductionStore.ranger(t, null, [{ messageId: m2, texte, langue }]),
          } : {}),
          media: mediaClient,
          // Le transport du modèle (120 s), pas le transport général (30 s) : un fichier de 2 Mo part en base64
          // (2,7 Mo à téléverser), et le défaut couperait les transcriptions les plus longues.
          transport: new FetchTransport(HTTP_TIMEOUT_MODELE_MS),
          cle: config.AI_GATEWAY_API_KEY,
          modele: config.TRANSCRIPTION_MODELE,
          tailleMaxOctets: config.TRANSCRIPTION_TAILLE_MAX_KO * 1024,
          noterCout: (t, m2, cout, secondes) => {
            journaliser('info', 'transcription_cout', { tenantId: t, messageId: m2, coutDollars: cout, secondes });
          },
        }, tenant, messageId, conversationId, cible),
      } : {}),
      /**
       * Lire une pièce jointe reçue (`lireMediaRecu`, `src/inbox/media-entrant.ts`). Hors du bloc de la
       * transcription : lire un fichier n'a besoin que du jeton Meta. Son plafond est le sien
       * (`MEDIA_ENTRANT_TAILLE_MAX_KO`), pas les 2 Mo de la transcription.
       */
      lireMediaMessage: (tenant, messageId, conversationId) => lireMediaRecu({
        messages: inboxStore,
        media: mediaClient,
        tailleMaxOctets: config.MEDIA_ENTRANT_TAILLE_MAX_KO * 1024,
      }, tenant, messageId, conversationId),
      // La prise d'une conversation du pot commun par un agent : le réglage de l'espace qui l'autorise.
      agentsPeuventPrendre: async (tenant) => (await settingsStore.get(tenant)).agentsPeuventPrendre,
      /**
       * La traduction des conversations. Les deux membres sont montés ensemble ou pas du tout : sinon la
       * console proposerait un bouton qui rendrait 503, ou croirait la traduction branchée.
       */
      ...(traducteur ? {
        traduireFil: (tenant: string, conversationId: string, messages: ConversationMessage[], cible: LangueConsole) => traduireFil({
          traducteur,
          traductions: traductionStore,
          // Une écriture d'appoint qui échoue ne prive personne de sa lecture, mais fait repayer la même
          // traduction à chaque ouverture : sans ce journal, la fuite ne se verrait que sur la facture.
          onErreur: (err, quoi) => { journaliser('error', 'traduction_ecriture_impossible', { err, quoi, tenantId: tenant }); },
        }, { tenantId: tenant, conversationId, messages, cible }),
        traducteur,
      } : {}),
      /**
       * Variables d'un template résolues sur la fiche du contact ouvert, avec le libellé du champ qui les
       * alimente. Même résolution que l'envoi réel (`resolveHintParams` + les indices posés à la création du
       * template) : l'écran montre exactement ce qui partira.
       */
      resolveTemplateParams: async (tenant, waId, tpl) => {
        const hints = await templateHintStore.get(tenant, tpl.name, tpl.language);
        const contact = await contactStore.getResolvableByPhone(tenant, waId);
        const { values } = resolveHintParams(hints, tpl.count, contact ?? {}, { now: new Date() });
        // Le libellé dit d'où vient la valeur : sans lui, une variable pré-remplie « Julien » ne se distingue
        // pas d'une valeur tapée à la main, et l'opérateur ne sait pas ce qui changera pour le contact suivant.
        const parPosition = new Map(hints.map((h) => [h.position, h.source]));
        const labels = Array.from({ length: tpl.count }, (_, i) => {
          const src = parPosition.get(i + 1);
          if (!src) return '';
          if (src.type === 'now') return 'date du jour';
          if (src.type === 'literal') return 'texte fixe';
          return src.key ?? '';
        });
        return { values, labels };
      },
      /**
       * Envoi d'un message RCS depuis l'inbox, par le même chemin que `POST /v1/messages/rcs`
       * (`envoyerRcsLibre`), origine `humain`. Chaque refus porte sa raison, destinée à l'opérateur.
       * 🔴 Le STOP RCS s'applique, par le point de passage unique de l'envoi ; la garde de consentement,
       * celle du désabonnement général et le cache de joignabilité ne s'appliquent pas à un opérateur.
       */
      sendRcsFromInbox: async (tenant, waId, contenu) => {
        const issue = await envoyerRcsLibre(depsRcsLibre, tenant, waId, contenu, 'humain');
        return 'refus' in issue ? { refus: phraseOperateur(issue.refus) } : issue;
      },
      /**
       * Les deux boutons de contrôle du fil de l'Inbox, « Reprendre la main » (le contact quitte la liste de l'agent
       * de Meta) et « Rendre la main » (il y entre, puis `release`) : Meta d'abord, notre état ensuite, dans le module
       * (`src/inbox/fil.ts`). Un refus de Meta devient un 409 lisible dans la route (Cloudflare mange le corps des 5xx).
       */
      reprendreLaMain: fil.reprendreLaMain,
      releaseControl: fil.rendreLaMain,
      /**
       * Lancement d'un scénario depuis l'Inbox (type `inbox`, `src/workflow/lancements.ts`) : la fenêtre ouverte
       * laisse le scénario ouvrir par un message rapide ou un formulaire, fermée elle garde ce que Meta refuserait
       * (131047) ; geste délibéré, il reprend le fil (l'opérateur le détient presque toujours) et ses étiquettes
       * publient. La fermeture du parcours en cours et les gardes vivent dans `runFrom`. `null` = scénario inconnu.
       */
      startWorkflow: (tenant, workflowId, waId, fenetreOuverte) =>
        workflowRuntime.lancements.lancer({ type: 'inbox', tenantId: tenant, workflowId, waId, fenetreOuverte }),
      sendTemplateMessage: async (tenant, phoneNumberId, to, tpl) => {
        const client = await metaFactory.clientForTenant(tenant, phoneNumberId); // token par tenant, repli global
        const components = buildTemplateComponents({
          bodyParams: tpl.bodyParams,
          ...(tpl.headerMediaUrl ? { headerMediaUrl: tpl.headerMediaUrl } : {}),
          ...(tpl.headerFormat ? { headerFormat: tpl.headerFormat } : {}),
          ...(tpl.carousel ? { carousel: tpl.carousel } : {}),
        });
        const spec = { name: tpl.name, language: tpl.language, ...(components.length > 0 ? { components } : {}) };
        return (await client.sendTemplate(to, spec)).messageId;
      },
      /**
       * 🔴 La garde d'opt-out de l'envoi de modèle depuis l'Inbox, en deux morceaux : le statut du contact
       * (`estDesabonne`, branché par `depsRepondre`) et la catégorie réelle du modèle. Le `templateCategory` du
       * corps vient du navigateur et ne sert qu'aux statistiques : s'en servir laisserait n'importe qui se
       * déclarer « utility ». `templateVarInfo` est la lecture du worker, avec son cache court.
       */
      categorieDuModele: async (tenant, name, language) => {
        const cat = (await workflowRuntime.templateVarInfo(tenant, name, language))?.category;
        return cat === 'utility' ? 'utility' : cat === 'marketing' ? 'marketing' : null;
      },
      /**
       * Cartes d'un template carousel, relues chez Meta et visuels re-téléversés pour l'envoi. `null` si le
       * template n'est pas un carousel : l'envoi classique reste inchangé.
       */
      prepareCarousel: async (tenant, name, language) => {
        // Même lecture que le worker (`templateVarInfo` de la fabrique partagée : nom+langue, repli sur le nom
        // seul, cache court).
        const lu = (await workflowRuntime.templateVarInfo(tenant, name, language))?.carousel;
        if (!lu) return null;
        const cards = await workflowRuntime.prepareCarouselMedia(tenant, lu.cards);
        const refus = carouselSendBlocker(cards);
        return refus === null ? { cards } : { refus: `Carousel non envoyable : ${refus}` };
      },
    },
    // Canal entrant depuis le connecteur HubSpot. Même secret partagé que le canal sortant (SERVICE_SECRET
    // côté connecteur) et même format de signature : pas de troisième schéma.
    ...(config.HUBSPOT_SERVICE_SECRET ? {
      hubspotEvents: {
        secret: config.HUBSPOT_SERVICE_SECRET,
        findWaId: async (tenant: string, waId: string) => ((await contactStore.findIdByWaId(tenant, waId)) ? waId : null),
        publish: async (tenantId: string, event: { kind: 'hubspot_deal_stage'; waId: string; pipelineId: string; stageId: string }) => {
          await enfilerEvenementAutomation(queue, { tenantId, event } satisfies AutomationEventJob);
        },
      },
    } : {}),
    /**
     * La recharge du crédit IA par Stripe (`src/http/credit-stripe.ts`). Toujours montée : sans clé, elle rend 503,
     * que la console lit comme « recharge pas encore disponible ». Le retour de Stripe se fait sur la page Crédit IA
     * de la console, jamais sur l'API : il ne crédite rien, il fait relire le solde.
     */
    creditPaiement: paiementDeLaConsole,
    // Le pont du code (lot 3a), monté seulement avec son secret : une signature sans secret ne prouverait rien.
    ...(config.OTP_PONT_SECRET ? {
      otpPont: { secret: config.OTP_PONT_SECRET, numeros: numerosFournis, transcrire: transcrireAppelOtp },
    } : {}),
    // Le webhook de Stripe, monté seulement avec son secret (une signature sans secret ne prouverait rien). La
    // configuration refuse de démarrer avec le secret sans la clé, ou l'inverse : monté, il connaît donc le mode.
    ...(config.STRIPE_WEBHOOK_SECRET ? {
      stripeWebhook: {
        secret: config.STRIPE_WEBHOOK_SECRET,
        livemode: estCleLive(config.STRIPE_SECRET_KEY),
        paiements: stripeStore,
        // 🔴 Le plafond de la clé de modèle suit l'achat, exactement comme après une recharge par `/ops` : sinon le
        // client paie et Vercel le coupe au plafond d'avant. La route répond sans l'attendre : l'arrêt du processus,
        // lui, l'attend (`travauxEnVol`), pour ne pas couper l'appel à Vercel en route.
        apresCredit: (tenantId: string) => travauxEnVol.suivre((async () => {
          if (!provisionCle) return;
          await remonterPlafondApresRecharge(provisionCle, tenantId);
        })()),
        // L'abonnement du numéro fourni (lot 3c, livraison B) : le magasin, et Julien prévenu sur Telegram (ne lève jamais).
        numero: {
          enregistrer: (a) => abonnementsNumero.enregistrer(a),
          majStatut: (abonnementId, statut, periodeFin) => abonnementsNumero.majStatut(abonnementId, statut, periodeFin),
          alerter: async (texte) => { await sendTelegram(`[mba-${NOM_API}] ${texte}`); },
        },
      },
    } : {}),
    stats: {
      stats: statsStore,
      conversationStats: conversationStatsStore,
      // Les lectures de coût : `src/stats/chiffrage.ts`. `margeTemplate` ne lit pas l'espace (une seule grille
      // pour tous), le contrat de la route le garde.
      margeTemplate: chiffrage.margeTemplate,
      getPricing: chiffrage.getPricing,
      getCostSeries: chiffrage.getCostSeries,
      getCoutParCampagne: chiffrage.getCoutParCampagne,
      // Les publicités Click-to-WhatsApp, à côté des campagnes push : la devise est celle du compte publicitaire.
      getCoutParPub: async (tenant, range, o) => {
        const [lignes, connexion] = await Promise.all([publicites.coutParPub(tenant, range, o), connexionsPub.lire(tenant)]);
        return { currency: connexion?.devise ?? null, lignes };
      },
      getCoutMessages: chiffrage.getCoutMessages,
      getCoutIa: chiffrage.getCoutIa,
      getDetailCoutCampagne: chiffrage.getDetailCoutCampagne,
      getWorkflowNodeCounts: chiffrage.getWorkflowNodeCounts,
      // Quantitatif > Performance : les demandes de la base, les durées en heures d'ouverture de L'ESPACE (ses
      // réglages, défauts du serveur compris, ceux que l'écran Paramètres lui montre).
      getPerformance: (tenant, range) => lirePerformance(
        { demandes: (t, r) => performanceStore.lire(t, r), reglages: (t) => settingsStore.get(t) },
        tenant, range,
      ),
      // Le même journal que l'écran d'exploitation (`/parametres`), avec le code et la plage en filtre : deux
      // requêtes sur des populations voisines feraient se contredire deux écrans de même titre.
      getErrorContacts: (tenant, range, code, filter) => erreursLivraison.lister(tenant, {
        code,
        from: range.from,
        to: range.to,
        ...filter,
        // Les seules campagnes : le compteur cliqué (`getErrorBreakdown`) ne compte qu'elles. Sans ce filtre,
        // un « 12 » ouvrirait aussi les messages libres du même code.
        campagnesSeulement: true,
        // Une ligne de plus que le plafond : c'est ainsi que la route sait qu'elle tronque, et le dit.
        limit: PLAFOND_CONTACTS_ERREUR + 1,
      }),
    },
    workflowReports: reportStore,
    settings: {
      reglages: settingsStore,
      // Canal RCS allumé dès qu'un agent est rattaché au tenant : l'interface suit l'état réel du dépôt.
      rcs: workflowRuntime.rcsStack.agents,
      /**
       * Un portail HubSpot est-il lié à cet espace ? Lecture locale : le mapping vit dans le schéma `mmhs` de
       * la même base (jointure indexée sur `tenant_id`), pas un aller-retour vers le connecteur.
       * 🔴 `42P01 -> false`, et seulement lui : c'est une base sans schéma `mmhs` (instance sans connecteur,
       * base de CI), où aucun portail ne peut être relié. Toute autre erreur remonte : l'affichage la lit « pas
       * relié », l'extinction de l'interrupteur la refuse en 503, pour ne pas éteindre HubSpot par-dessus un
       * portail relié.
       */
      hubspotPortalConnecte: (tenant) => phoneStatusStore.getHubspotPortal(tenant).then((p) => p.connected).catch((err: unknown) => {
        if (typeof err === 'object' && err !== null && 'code' in err && err.code === '42P01') return false;
        throw err;
      }),
      // Applique le choix chez Meta immédiatement. Mêmes helpers que le balayage horaire, pour que « je viens
      // de choisir » et « l'heure a changé » écrivent exactement la même chose.
      applyMbaHandoffEnabled: (tenant, enabled) => ecrireHandoffEnabled(
        { numeros: repo, meta: metaFactory },
        tenant,
        enabled,
      ),
      /**
       * Le connecteur prévenu à chaque désabonnement : on ne rend que l'identifiant et le libellé, l'écran du
       * Consentement a besoin de nommer un appel, pas de connaître son adresse, ses en-têtes ni ce qu'il envoie.
       */
      listerRequetesConnecteur: async (tenant) => (await agentRequetes.lister(tenant)).map((r) => ({ id: r.id, label: r.label })),
      agents: agentStore,
    },
    // Import de listes HubSpot (3e source de campagne) : monté seulement si le canal service est configuré.
    ...(config.HUBSPOT_SERVICE_URL
      ? {
          hubspotImport: {
            // Accès listes = réglage utilisateur + pause. La pause du toggle Synchronisation pose
            // campaigns_paused sans écraser hubspot_lists_enabled ; la route compose les deux.
            listsAccess: async (tenant: string) => {
              const s = await settingsStore.get(tenant);
              return { enabled: s.hubspotListsEnabled, paused: s.campaignsPaused };
            },
            fetchLists: (tenant: string, query?: string) => fetchHubspotLists({ baseUrl: config.HUBSPOT_SERVICE_URL, secret: config.HUBSPOT_SERVICE_SECRET, transport }, tenant, query),
            importList: (tenant: string, listId: string, listName: string) =>
              importHubspotList({ baseUrl: config.HUBSPOT_SERVICE_URL, secret: config.HUBSPOT_SERVICE_SECRET, transport }, { contacts: contactStore, userFields: fieldStore }, tenant, listId, listName),
          },
          // Étapes de deal : même canal service, mais aucun rapport avec le réglage « listes » (cf. la route).
          hubspotPipelines: {
            fetchDealStages: (tenant: string) =>
              fetchHubspotDealStages({ baseUrl: config.HUBSPOT_SERVICE_URL, secret: config.HUBSPOT_SERVICE_SECRET, transport }, tenant),
          },
        }
      : {}),
    // Émission du lien d'install/re-consentement HubSpot signé (admin-only). Vide si l'origine publique du connecteur
    // ou le secret ne sont pas configurés -> la route répond 503, le front garde son bouton.
    hubspotInstall: {
      connectorPublicUrl: config.HUBSPOT_CONNECTOR_PUBLIC_URL,
      serviceSecret: config.HUBSPOT_SERVICE_SECRET,
    },
    admin: {
      audit: auditSink,
      users: userStore,
      createInviteToken: (userId) => authTokenStore.create('invite', userId, config.INVITE_TOKEN_TTL_MS),
      // Personnalisation de l'email d'invitation : nom de l'invitant (repli email) + nom de l'espace.
      getInviterName: async (userId) => {
        const u = await userStore.getById(userId);
        return u ? (u.name ?? u.email) : null;
      },
      mfa: mfaStore,
      appUrl: config.APP_URL,
      ...(sendAuthEmail ? { sendEmail: sendAuthEmail } : {}),
    },
    /**
     * L'assistant du Meta Business Agent.
     * 🔴 Il passe par `gatewayAide`, donc par notre clé (facturer l'apprentissage du produit se retourne
     * contre nous), d'où le plafond `ASSISTANT_PLAFOND_EUROS_MOIS` : sur notre clé, rien d'autre ne borne un
     * bavardage. Absent sans clé de modèle : la route n'est pas montée (un 404 lisible plutôt qu'un 503 à
     * chaque tour).
     */
    ...(gatewayAide ? {
      mbaAssistant: {
        inventaire: async (tenant: string) => {
          const phoneNumberId = await repo.getTenantPhoneNumberId(tenant);
          if (!phoneNumberId) return null;
          // L'« agentId » des routes MBA est le `phone_number_id`, comme dans `src/http/mba.ts` : un second
          // champ créerait une seconde vérité pour la même chose.
          return lireInventaireMba(await metaFactory.mbaClientForTenant(tenant), phoneNumberId, phoneNumberId);
        },
        entretiens: new PgEntretienMbaStore(pool),
        depenses: new PgDepenseStore(pool),
        plafondEuros: config.ASSISTANT_PLAFOND_EUROS_MOIS,
        modele: config.AGENT_SETUP_MODEL || config.LLM_MODEL,
        tauxEurParDollar: config.EUR_PER_USD,
        numeros: repo,
        completer: (i: Parameters<GatewayChatClient['completer']>[0]) =>
          gatewayAide.completer({ ...i, tenantId: AUCUN_ESPACE_PAYEUR }),
        application: (_tenant: string, acteur: { id: string | null; email: string | null }) => ({
          numeros: repo,
          meta: metaFactory,
          historique: historiqueStore,
          acteur,
          drapeau: settingsStore,
          attendre: (ms: number) => dormir(ms),
        }),
      },
    } : {}),
    historique: { historique: historiqueStore },
    // 🔴 Configuration de l'agent MBA (admin-only) : `phoneNumberBelongsToTenant` est le contrôle d'isolation
    // de la plupart de ces routes, la surface MBA étant indexée par numéro chez Meta, pas par tenant.
    // `PUT /tenants/:id/mba-activation` fait exception : elle résout le numéro elle-même et s'isole par
    // `scopeTenant`.
    mba: {
      /**
       * Seules les suppressions sont journalisées depuis les onglets : chez Meta une suppression est
       * définitive et cette ligne en est le seul exemplaire, alors qu'une création ratée se refait.
       */
      journaliserSuppression: (tenant, l) => historiqueStore.ecrire(tenant, {
        surface: 'mba', surfaceId: null, element: l.element, operation: 'suppression',
        cible: l.cible, libelle: l.libelle, avant: l.avant, apres: null,
        origine: 'formulaire', acteurEmail: null, acteurId: l.acteurId,
      }),
      meta: metaFactory,
      // Le numéro se résout ici, côté serveur : c'est ce qui rend la route d'activation possible (côté
      // navigateur, l'état du compte n'est pas toujours arrivé au moment du clic).
      repo,
      fetchUrl: fetchUrlBorne(),
      reglages: settingsStore,
      stats: statsStore,
      attendre: (ms) => dormir(ms),
    },
    // Agents IA, en lecture : la palette du builder a besoin de la liste pour proposer le bloc.
    agents: agentsDeLaConsole,
    /**
     * Le bot d'aide de la console. Il explique et il emmène, il n'écrit jamais rien.
     * 🔴 `gatewayAide` et non `gateway` : construit sans résolveur de clé par espace, il paie sur la nôtre. Les
     * intervertir facturerait l'aide au crédit du client, en silence (gardé par `tests/aide-cablage.test.ts`).
     */
    aide: {
      /**
       * Le récap de la veille, branché même sans modèle : tout ce qui est chiffré sort du SQL, et le gabarit
       * le dit en trois phrases. Le modèle n'ajoute que le remarquable, les jours où il y en a un.
       */
      recap: {
        calculer: creerRecapRedige({
          recap: creerRecap(pool),
          rediger: gatewayAide && config.AGENT_AIDE_MODEL
            ? creerRedacteurRecap({
              // Même clé que la question, et pour la même raison : c'est nous qui payons.
              completer: (i) => gatewayAide.completer({ ...i, tenantId: AUCUN_ESPACE_PAYEUR }),
              modele: config.AGENT_AIDE_MODEL,
            })
            : async (r, langue) => ({ texte: gabarit(r, langue), redigeParModele: false }),
        }),
      },
      ...(gatewayAide && config.AGENT_AIDE_MODEL ? {
        repondre: creerRepondeur({
          depot: depotAide,
          recherche: creerRechercheSemantique(),
          // Aucun espace ne paie cet appel : `gatewayAide` n'a pas de résolveur de clé par espace, donc cette
          // valeur n'est jamais lue. La nommer évite qu'on y mette le tenant, ce qui facturerait le client.
          completer: (i) => gatewayAide.completer({ ...i, tenantId: AUCUN_ESPACE_PAYEUR }),
          modele: config.AGENT_AIDE_MODEL,
        }),
      } : {}),
    },
    // L'assistant de construction. Il ne peut écrire ni la mention légale d'IA, ni les plafonds, ni le
    // modèle, ni le risque ou l'activation d'un outil : il rend une proposition, le client l'applique.
    agentSetup: {
      etatCourant: async (tenant, agentId) => {
        const fiche = await agentStore.complet(tenant, agentId);
        if (!fiche) return null;
        const [outils, fiches, sources, catalogue, offrables] = await Promise.all([
          toolCatalog.listToutes(tenant, agentId),
          knowledgeStore.lister(tenant, agentId),
          // Les sources déclarées de l'espace, branchées sur cet agent ou non, pour répondre « vous avez
          // déclaré votre ERP, il reste à y brancher l'appel » plutôt que « rien n'existe ».
          agentSources.lister(tenant),
          // La bibliothèque de l'espace, pas les outils de cet agent : elle borne ce que l'assistant peut
          // brancher. La définition appartient à l'espace, le consentement au couple (outil, consommateur) ;
          // l'assistant n'agit que sur le second et ne crée jamais rien.
          toolCatalog.listCatalogue(tenant),
          // Ce que le catalogue permet de lui offrir : la règle unique, que l'assistant ne recalcule pas. Il écarte
          // seulement ce que le catalogue marque `nomPris` (0211).
          toolCatalog.offrablesPour(tenant, consommateurAgent(agentId)),
        ]);
        return {
          label: fiche.label,
          // Le régime d'annonce d'IA, que l'entretien pose : il vient de l'espace, pas de la fiche (la
          // question règle la politique de la marque, pas celle de ce robot-là).
          mentionIaFrequence: (await settingsStore.get(tenant)).mentionIaFrequence ?? 'session',
          // Idem pour le délai d'inactivité, depuis que l'entretien demande quand l'agent lâche un contact muet.
          inactiviteMinutes: fiche.inactiviteMinutes,
          fiche: fiche.contenu,
          // Les outils maison, par leur handler : c'est par lui que l'assistant les désigne.
          outils: outils.filter((o) => o.origin === 'mba')
            .map((o) => ({ handler: String(o.binding.handler ?? ''), description: o.description, nePasUtiliser: o.nePasUtiliser })),
          // Les connecteurs déjà déclarés, par leur nom exposé. L'assistant peut en réécrire les mots, jamais
          // en créer (déclarer une source, c'est écrire une adresse réseau et un secret). L'origine part avec,
          // sinon un outil MCP serait annoncé comme un connecteur API.
          connecteurs: outils.filter((o) => o.origin !== 'mba')
            .map((o) => ({
              nom: o.name, titre: o.title, description: o.description, nePasUtiliser: o.nePasUtiliser,
              origine: o.origin === 'mcp' ? 'mcp' as const : 'http' as const,
              sourceId: o.sourceId,
            })),
          titresConnaissance: fiches.map((f) => f.titre),
          // `id` part avec : c'est lui qui apparie un outil à son serveur, pas le préfixe de son nom, que le
          // client peut réécrire.
          sources: sources.map((s) => ({ id: s.id, label: s.label, kind: s.kind, status: s.status })),
          // `branche` se lit sur les consommateurs de la définition : seul le catalogue connaît les outils
          // non branchés, justement ceux que l'assistant peut proposer de brancher, s'ils sont offrables.
          catalogue: catalogueBranchable(catalogue, offrables, agentId),
        };
      },
      /**
       * Les adresses des membres, par identifiant, pour afficher qui a écrit chaque tour du fil : `list` rend
       * les membres de l'espace, et un tour ne peut avoir été écrit que par l'un d'eux.
       */
      emailsDesMembres: async (tenant: string) =>
        Object.fromEntries((await userStore.list(tenant)).map((u) => [u.id, u.email])),
      // Les pièces jointes écrivent des fiches de connaissance par le même store que l'onglet Connaissance :
      // ce que le client joint y reste relisible et modifiable.
      ecrireFichesDocument: (tenant, agentId, nom, fiches) =>
        knowledgeStore.remplacerSource(tenant, agentId, { type: 'document', nom }, fiches),
      // L'entretien est tenu par le serveur : conversation persistante entre deux visites, et séquence des
      // questions déterministe (la couverture devient un fait, plus une déclaration du modèle).
      entretiens: new PgEntretienStore(pool),
      /**
       * 🔴 `gatewayAide` et pas `gateway` : configurer son robot ne se facture pas au client, l'assistant
       * passe sur notre clé maison. `AUCUN_ESPACE_PAYEUR` n'est jamais lu pour choisir une clé ; le nommer
       * évite qu'on y remette le tenant, ce qui refacturerait le client sans rien signaler.
       */
      ...(gatewayAide ? {
        completer: (i: Parameters<GatewayChatClient['completer']>[0]) =>
          gatewayAide.completer({ ...i, tenantId: AUCUN_ESPACE_PAYEUR }),
      } : {}),
      modele: config.AGENT_SETUP_MODEL || config.LLM_MODEL,
      /**
       * 🔴 Le même compteur et le même plafond que l'assistant du MBA : sur notre clé, rien d'autre ne borne
       * un bavardage. Le compteur est par espace, donc les deux assistants d'un client partagent la même
       * enveloppe mensuelle.
       */
      depenses: new PgDepenseStore(pool),
      plafondEuros: config.ASSISTANT_PLAFOND_EUROS_MOIS,
      tauxEurParDollar: config.EUR_PER_USD,
      // Le modèle de vision est distinct : `zai/glm-4.7`, le modèle d'entretien, refuse une part image en 400.
      // Vide -> les images sont refusées explicitement, les documents passent.
      modeleVision: config.AGENT_VISION_MODEL,
    },
    // Le bac à sable : parler à son agent depuis la console avant de l'activer. Il fait tourner le vrai
    // cerveau (prompt, outils exposés, recherche de connaissance), mais les outils à effet sont simulés : il
    // n'y a ni contact, ni conversation, ni parcours, et poser un tag écrirait sur une vraie fiche.
    agentTest: essaiDeLaConsole,
    // Base de connaissance d'un agent : la seule source que l'agent a le droit d'utiliser. `fetchUrl` porte
    // la garde SSRF (le serveur vit dans le réseau Docker du VPS) et le plafond de taille.
    agentKnowledge: connaissanceDeLaConsole,
    // Outils d'un agent. L'activation et l'autonomie portent le nom de qui les a posées (exigé en base) :
    // c'est ce qui rend un incident instruisable.
    agentTools: {
      outils: toolCatalog,
      requetes: agentRequetes,
      // Les règles d'arrêt viennent de la fiche : c'est d'elles que dérive l'énumération de « terminer ».
      sortiesDeLAgent: async (tenant, agentId) => {
        const fiche = await agentStore.complet(tenant, agentId);
        return fiche ? fiche.contenu.sorties : null;
      },
    },
    // La bibliothèque d'outils de l'espace : les définitions, et qui s'en sert. Isolée par `scopeTenant` et
    // non par un agent dans l'URL, parce qu'une définition appartient à l'espace. Elle ne porte que la
    // lecture (la route n'appelle que `listCatalogue`) ; les routes de l'agent de Meta sont dans `mbaOutils`.
    agentCatalogue: toolCatalog,
    /**
     * L'onglet « Outils » de l'agent de Meta. Le numéro est résolu ici, côté serveur, jamais porté par le
     * navigateur ; la requête d'un connecteur est lue, pas crue sur parole : le risque et la source en
     * dérivent.
     */
    mbaOutils: {
      repo,
      lister: (tenant, pn) => toolCatalog.listToutesConsommateur(tenant, consommateurMba(pn)),
      contexte: async (tenant, outils) => {
        // Les scénarios ne se lisent que si une ligne en désigne un : la liste porte les graphes complets.
        const veutScenarios = outils.some((o) => {
          const h = (o.binding as { handler?: unknown } | null)?.handler;
          return h === 'bloc_fixe' || h === 'scenario_fixe';
        });
        const [requetes, champs, bibliotheque, workflows, sources] = await Promise.all([
          agentRequetes.lister(tenant), fieldStore.list(tenant), toolCatalog.listCatalogue(tenant),
          veutScenarios ? workflowStore.list(tenant) : Promise.resolve([]),
          outils.some((o) => o.origin === 'mcp') ? agentSources.lister(tenant) : Promise.resolve([]),
        ]);
        return {
          requetes: new Map(requetes.map((r) => [r.id, { label: r.label }])),
          champs: new Set(champs.map((f) => f.key)),
          bibliotheque: new Map(bibliotheque.map((o) => [o.id, o])),
          workflows: new Map(workflows.map((w) => [w.id, { name: w.name, graph: w.graph }])),
          serveurs: new Map(sources.map((s) => [s.id, { label: s.label }])),
        };
      },
      // Le graphe publié, celui que le relais joue : jamais le brouillon.
      workflow: async (tenant, id) => {
        const w = await workflowStore.getById(id, tenant);
        return w ? { name: w.name, graph: w.graph } : null;
      },
      blocs: async (tenant, id) => {
        const w = await workflowStore.getById(id, tenant);
        return w ? blocsProposables([{ id: w.id, name: w.name, graph: w.graph }]) : [];
      },
      requetes: agentRequetes,
      champs: async (tenant) => (await fieldStore.list(tenant)).map((f) => f.key),
      outils: toolCatalog,
      // Deux gestes, comme l'ancienne route : créer, puis activer pour l'agent de Meta au nom de l'administrateur.
      creerConnecteur: async (tenant, pn, outil, par) => {
        const cree = await toolCatalog.ajouterConnecteurPourMba(tenant, pn, outil);
        if (!cree) return null;
        await toolCatalog.activerConsommateur(tenant, consommateurMba(pn), cree.id, true, par);
        return { id: cree.id };
      },
      // `consommateurMba(pn)` et pas un agent : c'est lui qui borne la correction à un outil de ce consommateur.
      modifierConnecteur: (tenant, pn, id, patch) => toolCatalog.patchConsommateur(tenant, consommateurMba(pn), id, patch),
      reactiver: async (tenant, pn, id, par) =>
        (await toolCatalog.activerConsommateur(tenant, consommateurMba(pn), id, true, par)) !== null,
      bibliotheque: (tenant) => toolCatalog.listCatalogue(tenant),
      offrables: (tenant, pn) => toolCatalog.offrablesPour(tenant, consommateurMba(pn)),
      serveurs: async (tenant) => new Map((await agentSources.lister(tenant))
        .filter((s) => s.kind === 'mcp').map((s) => [s.id, { label: s.label }])),
      // Deux gestes, comme `creerConnecteur` : rattacher (inactif), puis activer au nom de l'administrateur. Le refus
      // de la porte remonte avec sa raison.
      proposerMcp: async (tenant, pn, id, par) => {
        const r = await toolCatalog.rattacherConsommateur(tenant, consommateurMba(pn), id);
        if (!r.ok) return r;
        return (await toolCatalog.activerConsommateur(tenant, consommateurMba(pn), id, true, par)) !== null
          ? r : { ok: false, refus: 'introuvable' };
      },
    },
    /**
     * Publication du catalogue chez Meta, sous forme de relais.
     * Le plan est recalculé au moment d'appliquer, jamais transmis par le navigateur : Meta a pu changer
     * entre l'aperçu et le clic.
     * 🔴 Ce qui part chez Meta est le relais : un connecteur `EngageMe` par espace, dont l'adresse est notre
     * API et la clé une clé d'API de l'espace (`src/mba/cle-relais.ts`). Le secret du client ne quitte pas
     * notre serveur ; les valeurs du mini-CRM sont remplies par le relais (`src/http/mba-relais.ts`).
     */
    mbaPublication: {
      repo,
      relais: async (tenant) => {
        const base = adresseDuRelais();
        if (base === null) return null;
        return { baseUrl: base, cleAJour: await cleAJour(depsCleRelaisPour(null), tenant) };
      },
      outilsExposes: (tenant, pn) => outilsPourMeta(tenant, pn),
      etatMeta: async (tenant, pn) => {
        const client = await metaFactory.mbaClientForTenant(tenant);
        const connecteurs = await client.listConnectors(pn);
        /**
         * Le type vient du client, il n'est pas recopié : le plan compare `request_definition`, qu'une
         * annotation écrite à la main pourrait omettre.
         */
        const outilsParConnecteur: Record<string, Awaited<ReturnType<typeof client.listConnectorTools>>> = {};
        for (const c of connecteurs) outilsParConnecteur[c.id] = await client.listConnectorTools(pn, c.id);
        return { connecteurs, outilsParConnecteur };
      },
      /** Sorti en module pour être testé contre des faux (`src/mba/appliquer-publication.ts`). */
      appliquer: creerAppliquerGeste({
        meta: metaFactory,
        adresseDuRelais,
        outils: outilsPourMeta,
        cle: depsCleRelaisPour,
      }),
      // En base, pour que deux copies de l'API ne publient pas en même temps pour un espace.
      verrous: verrousCourts,
    },
    /**
     * Les connecteurs MCP. Tout passe par `PgMcpStore` sauf la source elle-même, servie par `agentSources` :
     * c'est la même table (`agent_tool_sources`, `kind = 'mcp'`), et un second chemin de lecture ferait deux
     * façons de déchiffrer un secret.
     */
    agentMcp: {
      audit: auditSink,
      // 🔴 La suppression d'un serveur passe par `PgMcpStore`, jamais par `agentSources.supprimer`, un `delete` nu
      // qui emporterait les outils et les consentements par cascade en rendant `true`.
      mcp: mcpStore,
      sources: agentSources,
      // Le même store que les connecteurs API : même table, secret chiffré au même endroit.
      creerServeur: (tenant, input) => agentSources.creer(tenant, { kind: 'mcp', ...input }),
      // La même lecture que pour les variables de requête : deux définitions de « ce champ existe »
      // finiraient par diverger.
      clesDeChamps: async (tenant) => (await fieldStore.list(tenant)).map((f) => f.key),
    },
    // Les sources externes d'outils : l'adresse de base du système du client, son mode d'authentification et
    // son secret. Le secret est chiffré par le store, et aucune route ne le rend.
    agentSources: {
      audit: auditSink,
      sources: agentSources,
      // Éprouver une source : un appel réel, le résultat écrit sur la ligne. Ses gardes (nature de la source,
      // adresse vérifiée avant l'appel et à la connexion, redirection refusée) vivent dans
      // `src/agent/eprouver-source.ts`, testé à part.
      eprouver: creerEprouverSource({ sources: agentSources }),
    },
    // Les requêtes de connecteur : un appel mis au point une fois dans la bibliothèque, que l'outil d'un
    // agent désigne au lieu de le redécrire.
    agentRequetes: {
      requetes: agentRequetes,
      /**
       * Ce qu'il faut pour éprouver une requête : l'adresse de base et les en-têtes d'authentification, par
       * le même point de passage que l'appel réel (`enTetesAuthSource`), sinon le test dirait « ça répond »
       * d'une source que les appels ne savent pas authentifier.
       */
      sourcePourTest: async (tenant, sourceId) => {
        const src = await agentSources.pourAppel(tenant, sourceId);
        /**
         * 🔴 `kind === 'http'` : la route de test prend `sourceId` dans le corps, et sans ce filtre un
         * administrateur pourrait y passer l'identifiant d'un serveur MCP et faire partir une requête de sa
         * composition sur le point MCP du client, avec son secret déchiffré dans l'en-tête. Le repli sur
         * `null` rend déjà un 400 lisible.
         */
        return src && src.kind === 'http'
          ? { baseUrl: src.baseUrl, entetes: enTetesAuthSource(src), status: src.status }
          : null;
      },
      // Les clés des champs déclarés : une variable `champ` doit en désigner une, sinon la faute de frappe ne
      // se verrait qu'à l'appel, en pleine conversation.
      clesDeChamps: async (tenant) => (await fieldStore.list(tenant)).map((f) => f.key),
      // Le second usage d'une requête, que le compteur `outils` ne voit pas : la poussée d'opt-out.
      brancheeSurConsentement: async (tenant, requestId) => (await settingsStore.get(tenant)).optoutRequestId === requestId,
    },
    flows: {
      meta: metaFactory, // token par tenant, repli global
      repo,
      flows: flowStore,
      insertFlow: (tenantId, id, name, screens, ref, mapping, cta) => flowStore.insert({ id, tenantId, name, screens, ref, mapping, ...(cta ? { cta } : {}) }),
      ensureUserField: async (tenant, label, type) => { await ensureField(fieldStore, tenant, label, type); },
      champs: fieldStore,
      ensureOptinField: async (tenant) => { await ensureFieldByKey(fieldStore, tenant, WHATSAPP_OPTIN_FIELD_KEY, WHATSAPP_OPTIN_FIELD_LABEL, 'boolean'); },
      updateFlowRow: (tenant, id, name, screens, ref, mapping, cta) => flowStore.update(id, tenant, { name, screens, ref, mapping, ...(cta ? { cta } : {}) }),
      insertExternalFlow: (tenant, f) => flowStore.insertExternal({ ...f, tenantId: tenant }),
    },
    media: mediaClient,
    tags: tagStore,
    fields: {
      fields: fieldStore,
      tenantCode: (tenant) => resolveTenantCode(pool, tenant),
      contacts: contactStore,
    },
    contacts: {
      contacts: contactStore,
      audit: auditSink,
      journal: auditStore,
      erreurs: erreursLivraison,
      champs: fieldStore,
      // Champ socle absent -> créé au premier usage (idempotent) : sans ça, un espace neuf refuserait
      // « Prénom » alors que l'écran le propose.
      ensureSocleField: async (tenant, key, label, type) => { await ensureFieldByKey(fieldStore, tenant, key, label, type); },
      // Création à la main : même upsert que le webhook entrant, avec le pays par défaut du tenant.
      createOneContact: async (tenant, input) => {
        const [r] = await upsertContactsFromApi(tenant, [input], { contacts: contactStore, fields: fieldStore, defaultCountry: config.DEFAULT_COUNTRY as CountryCode });
        return r ? { status: r.status, ...(r.contactId ? { contactId: r.contactId } : {}), ...(r.reason ? { reason: r.reason } : {}) } : { status: 'error', reason: 'aucun résultat' };
      },
      contactHistory: contactHistoryStore,
      // Le coût d'un contact, aux mêmes tarifs que la fiche de campagne : `src/stats/chiffrage.ts`.
      getBilanContact: chiffrage.getBilanContact,
      // La pose d'étiquettes sur UNE fiche, le MÊME module que l'agent, le scénario, le widget et l'outil MCP : la
      // déclaration dans le référentiel, et « tag ajouté » pour les nouvelles. L'API ne démarre pas de scénario (le
      // worker tient l'exécuteur), elle publie un événement par étiquette nouvelle. Un contact sans identité joignable
      // (ni numéro ni BSUID) n'a rien à déclencher.
      etiquettes: workflowRuntime.etiquettes,
      // Les contacts purgés sortent de la liste de l'agent de Meta, après la purge (`src/mba/liste.ts`).
      listeDeLAgent,
      // Ce retrait part après la réponse : l'arrêt de cette copie l'attend avant de fermer le pool.
      enVol: travauxEnVol,
    },
    embeddedSignup: (() => {
      const esClient = new MetaEmbeddedSignupClient(config.META_APP_ID, config.META_APP_SECRET, config.META_GRAPH_VERSION);
      return {
        audit: auditSink,
        configId: config.META_ES_CONFIG_ID,
        appId: config.META_APP_ID,
        graphVersion: config.META_GRAPH_VERSION,
        meta: esClient,
        inscriptions: {
          linkTenant: (input) => esCredentialsStore.linkTenant(input),
          lierCompteSansNumero: (input) => esCredentialsStore.lierCompteSansNumero(input),
        },
        /**
         * Le crédit de bienvenue, que la route n'appelle que pour un numéro que Meta dit vérifié. 🔴 Un espace qui a
         * déjà une clé de modèle voit son plafond remonter, comme après une recharge (sinon Vercel le couperait avant
         * qu'il ait consommé ce crédit), EN ARRIÈRE-PLAN et suivi par l'arrêt propre : Vercel peut prendre 30 s, que
         * l'inscription n'a pas à attendre (`creerOffreDeBienvenue`).
         */
        offrirCredit: creerOffreDeBienvenue({
          offrir: (tenant: string, phoneNumberId: string) => esCredentialsStore.offrirCredit(tenant, phoneNumberId),
          remonterPlafond: provisionCle ? (tenant: string) => remonterPlafondApresRecharge(provisionCle, tenant) : null,
          travaux: travauxEnVol,
          journal: (msg, err, tenant) => { journaliser('error', msg, { err, tenantId: tenant, pour: 'credit_offert' }); },
        }),
        // 🔴 Chiffrement au repos ici (la route ne voit jamais le stockage) : AES-GCM avec ENCRYPTION_KEY,
        // pour le token et le PIN 2FA du numéro (un secret Meta).
        saveCredentials: (waba: string, tenant: string, token: string, pin: string | null) =>
          esCredentialsStore.saveCredentials(waba, tenant, encryptSecret(token, config.ENCRYPTION_KEY), pin === null ? null : encryptSecret(pin, config.ENCRYPTION_KEY)),

        // ----- « Activer le numéro » -----
        // 🔴 Le jeton ne sort pas d'ici : ces fonctions ne prennent qu'un `tenantId`, la route ne voit jamais
        // un secret.
        numeroDuTenant: async (tenant: string) => (await phoneStatusStore.getPhoneNumber(tenant))?.id ?? null,
        // Relu chez Meta à chaque geste, jamais dans notre base : notre copie date du dernier pull, et c'est
        // Meta qui décide si un code est encore nécessaire.
        etatNumero: async (tenant: string, phoneNumberId: string) => {
          const client = await metaFactory.phoneClientForTenant(tenant);
          const info = await client.get(phoneNumberId);
          return { status: info.status ?? null, codeVerificationStatus: info.codeVerificationStatus ?? null };
        },
        demanderCode: async (tenant: string, phoneNumberId: string, methode: 'VOICE' | 'SMS') => {
          const client = await metaFactory.phoneRegisterClientForTenant(tenant);
          await client.requestCode(phoneNumberId, { methode });
        },
        verifierCode: async (tenant: string, phoneNumberId: string, code: string) => {
          const client = await metaFactory.phoneRegisterClientForTenant(tenant);
          await client.verifyCode(phoneNumberId, code);
        },
        // Le register reste celui de l'inscription : `MetaPhoneRegisterClient` dit pourquoi il ne le porte pas
        // (deux copies du même appel Graph divergeraient), d'où le jeton résolu à la main ici. Pas
        // d'interception d'erreur d'auth : ce client lève des `Error` ordinaires, que `isMetaAuthError` ne
        // reconnaît pas.
        enregistrerNumero: async (tenant: string, phoneNumberId: string, pin: string) => {
          const { token } = await metaCredentials.resolveForTenant(tenant);
          await esClient.register(phoneNumberId, token, pin);
        },
        sauverPin: async (tenant: string, pin: string) => {
          const waba = await wabaDeLEspace(tenant);
          if (waba === null) {
            // Numéro branché à la main, hors Embedded Signup : aucune ligne où conserver le PIN. L'activation
            // a réussi, on le dit plutôt que de laisser croire que le PIN est gardé quelque part.
            // eslint-disable-next-line no-console
            console.warn(`numero/activer: PIN non conservé (espace ${tenant} sans compte WhatsApp rattaché)`);
            return;
          }
          await esCredentialsStore.enregistrerPin(waba, tenant, encryptSecret(pin, config.ENCRYPTION_KEY));
        },

        // ----- « Délier » et « Relier » : aucun appel à Meta -----
        // La garde de CETTE copie est vidée après chaque geste. Les autres copies de l'API et le worker gardent au
        // plus `NUMERO_DELIE_TTL_MS` de retard (fenêtre acceptée, `src/meta/numero-delie.ts`).
        delierNumero: async (tenant: string) => {
          const r = await numeroDelieStore.delier(tenant);
          gardeNumeroDelie.invaliderTout();
          return r;
        },
        relierNumero: async (tenant: string) => {
          const r = await numeroDelieStore.relier(tenant);
          gardeNumeroDelie.invaliderTout();
          return r;
        },
        // La minute entre deux demandes de code d'un numéro, commune à toutes les copies (le quota de Meta).
        verrous: verrousCourts,
      };
    })(),
    /**
     * Les publicités Click-to-WhatsApp.
     * 🔴 Le jeton est chiffré dans `src/pubs/connexion.ts`, et déchiffré là ou par le worker (routage d'un lead, suivi des publicités) : la route ne
     * reçoit qu'un `tenantId`, comme pour l'inscription WhatsApp, donc le jeton ne peut fuiter ni dans un
     * journal, ni dans une réponse, ni dans une trace de pile.
     * `META_ADS_CONFIG_ID` vide : routes montées, l'échange répond 503 et l'écran l'annonce. La configuration
     * refuse de démarrer si cette variable est posée sans `ENCRYPTION_KEY`.
     */
    pubs: {
      audit: auditSink,
      configId: config.META_ADS_CONFIG_ID,
      appId: config.META_APP_ID,
      graphVersion: config.META_GRAPH_VERSION,
      connexions: connexionsPub,
      // La connexion, du code échangé à la révocation : `src/pubs/connexion.ts`.
      etatCompte: connexionPub.etatCompte,
      connecter: connexionPub.connecter,
      actifsAccordes: connexionPub.actifsAccordes,
      choisir: connexionPub.choisir,
      deconnecter: connexionPub.deconnecter,

      publicites,
      brouillons: brouillonsPub,

      /**
       * Créer une publicité chez Meta, en pause. Ce câblage ne fait que lier (connexion, jeton de Page, deux
       * objets) : la séquence et son rattrapage vivent dans `src/pubs/creation.ts`, exécutés contre de faux
       * objets, chemins d'échec compris.
       */
      creerPub: async (t: string, d: Omit<DemandeCreation, 'comptePubId' | 'pageId' | 'numeroWhatsApp'>) => {
        const { comptePubId, pageId, jeton } = await accesPub(t);
        // Le jeton de Page ne sert qu'à la créa et n'est jamais stocké. Meta l'exige pour ce guide sans dire
        // s'il le faut partout : repli sur le jeton du client, et le refus de Meta sera lisible.
        const jetonCrea = (await clientCreationPubs.jetonDePage(pageId, jeton)) ?? jeton;
        /**
         * Le numéro est facultatif chez Meta, on le pose quand on le connaît : sans lui, Meta choisit le
         * numéro de la Page, qui peut ne pas être celui de cet espace, et les prospects écriraient à un
         * numéro dont aucun webhook ne nous parviendrait. Meta l'attend en chiffres, sans le `+` de l'E.164.
         */
        const affiche = (await phoneStatusStore.getPhoneNumber(t))?.displayPhoneNumber ?? null;
        const numeroWhatsApp = affiche === null ? null : affiche.replace(/[^0-9]/g, '');
        return creerLaPublicite(
          { ...d, comptePubId, pageId, numeroWhatsApp },
          {
            televerserImage: (b64) => clientCreationPubs.televerserImage(comptePubId, jeton, b64),
            etatVideo: (videoId) => clientCreationPubs.etatVideo(videoId, jeton),
            vignetteVideo: (videoId) => clientCreationPubs.vignetteVideo(comptePubId, jeton, videoId),
            etatAudiences: (ids) => clientCreationPubs.etatAudiences(comptePubId, ids, jeton),
            creerCampagne: (p) => clientCreationPubs.creerCampagne(comptePubId, jeton, p),
            creerEnsemble: (p) => clientCreationPubs.creerEnsemble(comptePubId, jeton, p),
            creerCrea: (p) => clientCreationPubs.creerCrea(comptePubId, jetonCrea, p),
            creerPub: (p) => clientCreationPubs.creerPub(comptePubId, jeton, p),
            supprimerCampagne: (id) => clientCreationPubs.supprimerCampagne(id, jeton),
          },
          {
            ouvrir: (v) => publicites.ouvrir(t, v),
            noterIds: (id, v) => publicites.noterIds(t, id, v),
            marquerEtat: (id, etatPub) => publicites.marquerEtat(t, id, etatPub),
            memoriserPub: (adId, campagneId) => publicites.memoriserPub(t, adId, campagneId),
            creerAutomation: (id, v) => publicites.creerAutomation(t, id, v),
            supprimerAutomation: (id) => publicites.supprimerAutomation(t, id),
          },
        );
      },

      /**
       * Le dépôt d'une vidéo, sur le compte publicitaire de l'espace, avec le jeton du client (la vidéo appartient
       * au compte, pas à la Page). Les octets ne font que traverser : `transfererMorceauVideo` les relaie en flux.
       */
      videos: {
        demarrer: async (t: string, taille: number) => {
          const { comptePubId, jeton } = await accesPub(t);
          return clientCreationPubs.demarrerDepotVideo(comptePubId, jeton, taille);
        },
        transferer: async (t: string, m: { sessionId: string; debut: number; taille: number; octets: AsyncIterable<Uint8Array> }) => {
          const { comptePubId, jeton } = await accesPub(t);
          return clientCreationPubs.transfererMorceauVideo(comptePubId, jeton, m);
        },
        terminer: async (t: string, sessionId: string) => {
          const { comptePubId, jeton } = await accesPub(t);
          await clientCreationPubs.terminerDepotVideo(comptePubId, jeton, sessionId);
        },
        etat: async (t: string, videoId: string) => clientCreationPubs.etatVideo(videoId, (await accesPub(t)).jeton),
      },
      audiences: async (t: string) => {
        const { comptePubId, jeton } = await accesPub(t);
        return clientCreationPubs.audiences(comptePubId, jeton);
      },

      /** Publier : l'automation d'abord, Meta ensuite. L'ordre vit dans `publierLaPublicite`. */
      publierPub: async (t: string, publiciteId: string) => {
        const pub = await publicites.lire(t, publiciteId);
        if (pub === null) throw new Error('cette publicité n’existe pas');
        const jeton = await connexionPub.jetonClair(t);
        await publierLaPublicite(
          publiciteId,
          { campagneId: pub.campagneId, ensembleId: pub.ensembleId, pubId: pub.pubId, etat: pub.etat, destination: pub.destination },
          { allumer: (objetId) => clientCreationPubs.changerStatut(objetId, jeton, 'ACTIVE') },
          {
            allumerAutomation: (id) => publicites.allumerAutomation(t, id),
            marquerPubliee: (id) => publicites.marquerEtat(t, id, 'publiee'),
          },
        );
      },

      /**
       * La page d'une publicité : ce qu'on sait d'elle, et son entonnoir. Aucun appel à Meta : les chiffres
       * viennent du balayage (toutes les quinze minutes), pour que l'affichage ne dépende pas de Meta.
       */
      lirePub: async (t: string, publiciteId: string) => {
        const publicite = await publicites.lire(t, publiciteId);
        if (publicite === null) return null;
        const comptes = await publicites.comptesDeLaCampagne(t, publicite.campagneId, ISSUES_NON_PRISES_EN_CHARGE);
        return {
          publicite,
          entonnoir: entonnoir({
            depense: publicite.depense, clics: publicite.clics,
            impressions: publicite.impressions, couverture: publicite.couverture, ...comptes,
          }),
        };
      },

      /**
       * Pause et reprise, sur la campagne seulement, chez Meta.
       * 🔴 La campagne est l'interrupteur (Meta met en pause tout ce qu'elle contient) : toucher aussi
       * l'ensemble et la publicité ferait trois façons d'échouer à mi-chemin sur le bouton d'arrêt d'une
       * dépense. L'automation n'est pas touchée : un prospect qui a cliqué juste avant la pause peut écrire
       * plus tard, et son lead a été payé.
       */
      basculerPub: async (t: string, publiciteId: string, actif: boolean) => {
        const pub = await publicites.lire(t, publiciteId);
        if (pub === null) throw new Error('cette publicité n’existe pas');
        await clientCreationPubs.changerStatut(pub.campagneId, await connexionPub.jetonClair(t), actif ? 'ACTIVE' : 'PAUSED');
        // Meta vient d'accepter : on l'écrit tout de suite, sinon l'écran afficherait « Diffuse » sur une
        // campagne qu'on vient d'arrêter, jusqu'au balayage suivant, et le client recliquerait.
        await publicites.noterStatutMeta(t, publiciteId, actif ? 'ACTIVE' : 'PAUSED');
      },
    },
    account: {
      numeros: phoneStatusStore,
      /**
       * La pastille du numéro, relue et jamais stockée : l'URL que Meta rend est signée et expire. Derrière
       * un micro-cache de dix minutes, très en deçà de sa durée de vie : l'Accueil est la page la plus
       * ouverte de la console.
       */
      photoNumero: (tenant, phoneNumberId) => photoNumeroCache.lire(`${tenant}:${phoneNumberId}`, async () => {
        if (!config.META_ACCESS_TOKEN) return null;
        const client = await metaFactory.phoneClientForTenant(tenant);
        return client.photoDeProfil(phoneNumberId);
      }),
      pullStatus: async (phoneNumberId, tenant) => {
        if (!config.META_ACCESS_TOKEN) return null; // pas de token global -> pas de pull live (statut sur le dernier connu)
        try {
          const phoneClientT = await metaFactory.phoneClientForTenant(tenant); // token par tenant, repli global
          const info = await phoneClientT.get(phoneNumberId);
          // Santé WABA : 2e appel Graph, best-effort. Un échec (droits/état) ne casse pas le pull du numéro :
          // on retombe sur le statut du numéro seul (les champs WABA restent sur leur dernier connu via coalesce).
          const wabaId = await repo.getTenantWabaId(tenant);
          const waba = wabaId ? await phoneClientT.getWabaHealth(wabaId).catch(() => undefined) : undefined;
          return pullFromInfo(info, waba);
        } catch (err) {
          return pullFromError(err);
        }
      },
      // Rattrapage HubSpot : enfile un seul job hubspot-catchup (le worker liste les marques et re-pousse).
      // No-op si le pipeline analyse/push est inerte (mêmes conditions que le worker qui consomme la file).
      enqueueHubspotCatchup: async (tenant) => {
        if (!(config.CONVERSATION_ANALYSIS_ENABLED === 'true' && config.CONNECTOR_PUSH_URL !== '')) return;
        await queue.enqueue('hubspot-catchup', { tenantId: tenant });
      },
      // Déconnexion complète : appel service signé vers mm-hubspot (unlink + révocation du token). Monté
      // seulement si le canal service est configuré (sinon la route répond 503).
      ...(config.HUBSPOT_SERVICE_URL
        ? { disconnectHubspot: (tenant: string) => disconnectHubspot({ baseUrl: config.HUBSPOT_SERVICE_URL, secret: config.HUBSPOT_SERVICE_SECRET, transport }, tenant) }
        : {}),
    },
    me: { getById: (userId) => userStore.getById(userId), estExploitant: (email) => estAdresseOps(opsEmails, email) },
    workflows: {
      scenarios: workflowStore,
      tenantCode: (tenant) => resolveTenantCode(pool, tenant),
      audit: auditSink,
      // La garde du 409 : une publicité vivante retient son scénario. Requise par le type : un câblage qui
      // l'oublierait laisserait supprimer le scénario d'une pub qui diffuse, en silence.
      publicites,
      // Déclare les tags des blocs « ajout de tag » dans le référentiel (Contenus > Tags) à la sauvegarde.
      declareTags: async (tenant, tags) => { for (const t of tags) await tagStore.create(tenant, t); },
      // Le numéro affiché, pour construire le lien wa.me du lien de test.
      getDisplayPhoneNumber: async (tenant) => (await phoneStatusStore.getPhoneNumber(tenant))?.displayPhoneNumber ?? null,
    },
    // Node « Envoi de mail » : boîtes SMTP + modèles (Contenu), et le résolveur qu'invalident les routes
    // d'écriture pour ne jamais garder un transport périmé (hôte/mot de passe changés).
    email: { accounts: emailAccounts, templates: emailTemplates, resolver: emailResolver },
    // 🔴 Paramètres > Intégrations > Batch : les clés sont chiffrées ici, jamais stockées en clair. Le cache
    // de l'émetteur de l'API est invalidé à chaque changement : brancher ou débrancher prend effet aussitôt.
    integrationBatch: {
      batch: integrationBatch,
      // Mesuré avec la vraie fonction de chiffrement, pas une copie de sa règle : c'est exactement ce
      // qu'`enregistrer` va appeler.
      chiffrementPret: (() => {
        try {
          encryptSecret('sonde', config.ENCRYPTION_KEY);
          return true;
        } catch {
          return false;
        }
      })(),
      enregistrer: async (tenant, r) => {
        const fait = await integrationBatch.enregistrer(tenant, {
          cleRestChiffree: r.cleRest === undefined ? null : encryptSecret(r.cleRest, config.ENCRYPTION_KEY),
          cleProjetChiffree: r.cleProjet === undefined ? null : encryptSecret(r.cleProjet, config.ENCRYPTION_KEY),
          envoyerResume: r.envoyerResume,
        });
        espacesBatch.invalider('actifs');
        return fait;
      },
      supprimer: async (tenant) => {
        const fait = await integrationBatch.supprimer(tenant);
        espacesBatch.invalider('actifs');
        return fait;
      },
      audit: auditSink,
    },
    // Paramètres > Intégrations > Salesforce, monté seulement quand la clé d'app est posée (sinon 404, et la
    // carte de la console ne s'affiche pas).
    // 🔴 Le secret de chaque org est tiré par la connexion, chiffré dans le store et posé dans l'org : aucune
    // route n'en voit la couleur. `satisfies` sur l'objet intérieur : le contrôle des propriétés ne traverse
    // pas un spread.
    ...(config.SALESFORCE_CLIENT_ID !== '' ? { salesforce: (() => {
      const store = new PgSalesforceStore(pool, config.ENCRYPTION_KEY);
      const client = creerClientSalesforce({ clientId: config.SALESFORCE_CLIENT_ID, clientSecret: config.SALESFORCE_CLIENT_SECRET });
      const depsConnexion = { client, store, genererSecret: () => randomBytes(32).toString('hex') };
      const version = config.SALESFORCE_PACKAGE_VERSION;
      return {
        orgs: store,
        reglages: settingsStore,
        connecter: (tenant: string, adresse: string, auteur: string | null) => connecterSalesforce(depsConnexion, tenant, adresse, auteur),
        deconnecter: (tenant: string) => deconnecterSalesforce(depsConnexion, tenant),
        cleAppPosee: true,
        chiffrementPret: (() => {
          try {
            encryptSecret('sonde', config.ENCRYPTION_KEY);
            return true;
          } catch {
            return false;
          }
        })(),
        liensInstallation: version === '' ? null : {
          production: `https://login.salesforce.com/packaging/installPackage.apexp?p0=${version}`,
          sandbox: `https://test.salesforce.com/packaging/installPackage.apexp?p0=${version}`,
        },
        audit: auditSink,
      } satisfies SalesforceRouteDeps;
    })() } : {}),
    rcsChannel: {
      agents: workflowRuntime.rcsStack.agents,
      verifier: (apiKey) => verifierCleRcs(fetchGet, apiKey),
      activer: async (tenant, canal, apiKey) => {
        // La clé est chiffrée ici, jamais stockée en clair. `client_token_enc` reste réservé au jour où un
        // fournisseur signera ses rappels (Google le fait) ; smsmode ne signe pas.
        // 🔴 Le `webhook_code` est le secret de l'adresse de rappel : lui seul dit à quel workspace appartient
        // un appel non signé. Donc 128 bits, comme le code des webhooks entrants, jamais une valeur courte.
        await workflowRuntime.rcsStack.agents.activer(
          tenant,
          canal,
          encryptSecret(apiKey, config.ENCRYPTION_KEY),
          encryptSecret(randomBytes(24).toString('hex'), config.ENCRYPTION_KEY),
          `rcs-${randomBytes(16).toString('hex')}`,
        );
      },
    },
    /**
     * Rappels smsmode : rapports de livraison et réponses des contacts.
     * 🔴 Le tenant vient du code de l'URL (`parWebhookCode`), jamais du corps : smsmode ne signe pas ses
     * rappels.
     */
    rcsCallback: {
      agents: workflowRuntime.rcsStack.agents,
      /**
       * Le rapport de livraison : destinataire de campagne, mesure par bloc, échec d'un message libre,
       * joignabilité RCS, sorties du bloc. La logique et ses raisons vivent dans `traiterRapportRcs`, testée ;
       * ce câblage ne fait que brancher.
       */
      onDlr: async (tenant, dlr) => {
        await traiterRapportRcs({
        majLivraison: (id, statut, detail) => recipientStore.updateDeliveryByMessageId(id, statut, detail, null),
        mesures: nodeEventStore,
        echecs: echecsMessages,
        joignabilite: rcsJoignabilite,
        parcours: workflowRuntime.executor,
        maintenant: () => Date.now(),
        }, tenant, dlr);
        // Les signaux, après le rapport (livraison, échec d'un message libre, joignabilité, sorties du bloc) :
        // l'état que l'outil relira est alors écrit. L'émetteur ne lève jamais : un rapport de livraison ne
        // doit pas échouer pour lui.
        if (dlr.status !== null && dlr.to !== '') {
          const signal = signalDeLAccuse({ messageId: dlr.messageId, status: dlr.status, waId: dlr.to, motif: dlr.detail, codeMeta: null, le: null }, 'rcs');
          if (signal !== null) await emetteur.emettreSignal(tenant, signal);
        }
      },
      onMo: async (tenant, mo) => {
        // Une position ou un fichier n'ont pas de texte : `apercuMo` en fabrique un lisible plutôt que de
        // laisser une bulle vide et de jeter les coordonnées.
        const apercu = apercuMo(mo);
        // 🔴 1. Le STOP avant tout le reste : continuer d'écrire après un refus fait suspendre l'agent par
        //    l'opérateur, et l'enregistrement de l'opt-out ne doit dépendre d'aucune étape qui pourrait
        //    échouer après lui.
        if (mo.kind === 'text' && estDemandeArret(mo.text)) {
          const marque = await workflowRuntime.rcsStack.optout.markOptedOut(tenant, mo.from);
          if (!marque) {
            // eslint-disable-next-line no-console
            console.error(`STOP RCS reçu de ${mo.from} (${tenant}) sans fiche contact : rien à désabonner`);
          }
          // Le STOP RCS n'écrit pas par le dépôt des contacts (il pose `rcs_optout_at`) : l'annonce composée
          // plus haut ne le voit pas, il émet donc lui-même son signal, avec l'identifiant du message STOP pour
          // clé naturelle (un STOP redélivré garde le même `em_event_id`).
          if (marque) await emetteur.emettreSignal(tenant, signalDesabonnement(mo.from, 'rcs', mo.messageId));
        }
        // 2. Le fil d'inbox : un échange RCS se lit au même endroit qu'un échange WhatsApp, dans le fil unique
        //    du contact. La bulle porte son canal.
        await inboxStore.recordInbound(tenant, {
          phoneNumberId: '',
          waId: mo.from,
          messageId: mo.messageId,
          type: mo.kind === 'suggestion' ? 'button' : mo.kind,
          body: apercu,
          buttonPayload: mo.postbackData,
          profileName: null,
          field: 'messages',
        }, 'rcs');
        // 2 ter. La réponse comme signal : le bouton tapé seulement, jamais le texte.
        await emetteur.emettreSignal(tenant, signalDeLaReponse({
          messageId: mo.messageId, waId: mo.from, bouton: mo.kind === 'suggestion' ? mo.text : null,
        }, 'rcs'));
        // 2 bis. La fiche contact et les automations, comme sur le chemin Meta : sans elles, un client qui
        //    écrit DEVIS en RCS ne déclencherait rien, et le STOP ci-dessus ne trouverait pas de fiche.
        //    Le canal part dans l'événement : sans lui, le runner croirait la fenêtre de service WhatsApp
        //    ouverte, et le scénario ouvrirait par un message rapide hors fenêtre (refus Meta 131047).
        //    Isolé : ni la fiche ni l'automation ne doivent faire échouer la réception d'un message.
        try {
          const issue = await contactStore.upsertFromInbound(tenant, mo.from, null);
          await enfilerEvenementAutomation(queue, {
            tenantId: tenant,
            event: { kind: 'message', waId: mo.from, body: mo.kind === 'text' ? mo.text : null, isNewContact: issue === 'created', channel: 'rcs' },
          } satisfies AutomationEventJob);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('automations RCS ignorées:', messageDe(err));
        }
        // 3. Le parcours. Un bouton tapé porte `btn:<i>` (cf. `normaliserPostbacks`) et choisit sa branche ;
        //    une réponse écrite suit la sortie « envoyé ». Isolé : un scénario qui casse ne doit pas faire
        //    rejouer six fois un rappel dont l'inbox et l'opt-out sont déjà enregistrés.
        await tenter('avance de scénario sur réponse RCS ignorée:', () => workflowRuntime.executor.advance(tenant, mo.from, mo.messageId, mo.postbackData, 'rcs'));
      },
    },
    /**
     * Visuels des messages RCS. Le téléversement rend directement l'URL publique : l'opérateur télécom va
     * chercher l'image lui-même.
     */
    rcsMedia: {
      medias: rcsMediaStore,
      create: async (tenant, input) => {
        const code = newMediaCode();
        const media = await rcsMediaStore.create(tenant, { ...input, code });
        return { media, url: urlImageRcs(adressesApi.racine, code, input.mime) };
      },
    },
    // Le dépôt lui-même : la route n'en appelle que `list`, `create`, `update` et `remove`, en méthodes.
    rcsMessages: rcsMessageStore,
    // Automations : déclencher un scénario sur un événement (mot-clé, nouveau contact, tag ajouté).
    automations: {
      automations: automationStore,
      // 🔴 Un tenant ne peut cibler que ses propres scénarios (même garde que la campagne workflow).
      workflowBelongsToTenant: async (wfId, tenant) => (await workflowStore.getById(wfId, tenant)) !== null,
    },
    // Chaîne WhatsApp (Channels Me) : publier un post dont le bouton démarre un scénario.
    channelsMe: {
      connexions: channelsMeConnections,
      client: channelsMeClient,
      liens: channelsMeLinks,
      posts: channelsMePosts,
      // L'automation compagnon du lien. Trois choses se décident ici et nulle part ailleurs :
      //  - `enabled: false`, parce qu'un lien créé mais jamais publié ne doit rien déclencher ;
      //  - `possedePar`, qui met la ligne hors de portée de l'écran Automation (prédicat du store) ;
      //  - `mode: 'contains'`, qui laisse passer un abonné ayant ajouté un mot devant ou derrière la phrase.
      // L'unicité se tranche avec la même normalisation que la correspondance (`normalizeText`, celle de
      // `matchesTrigger` et `keywordsOf`) : une comparaison SQL approchée laisserait passer « Ça m'intéresse »
      // et « ca m interesse ». L'inclusion dans les deux sens, pas l'égalité : en mode `contains`, un abonné qui
      // appuie sur « Je veux le guide 2026 » envoie aussi « Je veux le guide ».
      // 🔴 Contre les liens ET les widgets (lot 4 du widget) : la comparaison est celle de la route des widgets,
      // écrite une fois dans `src/widgets/phrases.ts`.
      phraseEnConflit: conflitDansLEspace({
        phrasesDesLiens: (tenant) => channelsMeLinks.phrasesDesLiens(tenant),
        phrasesDesWidgets: (tenant) => widgetStore.phrasesDesWidgets(tenant),
      }),
      creerAutomationCompagnon: (tenant, input) => automationStore.create(tenant, {
        name: input.nom,
        triggerKind: 'keyword',
        // 🔴 `contains` sauve les posts déjà publiés : un ancien post envoie `phrase (cm-xxxx)`, qui contient
        // le mot-clé (la phrase). En mode `equals`, tous les posts en circulation seraient morts, sans recours.
        triggerConfig: { keywords: [input.motCle], mode: 'contains' },
        conditionGroup: null,
        workflowId: input.workflowId,
        startNodeId: input.startNodeId,
        cooldownSeconds: input.cooldownSeconds,
        enabled: false,
        possedePar: 'channelsme_link',
        maxFiresPerHour: input.maxParHeure,
      }),
      // La lecture que les widgets font aussi (`gestionDesWidgetsEnBase`) : écrite une fois, dans `etatDuScenario`.
      scenarioEtat: async (tenant, wfId) => etatDuScenario(await workflowStore.getById(wfId, tenant)),
      getDisplayPhoneNumber: async (tenant) => (await phoneStatusStore.getPhoneNumber(tenant))?.displayPhoneNumber ?? null,
      // Notification best-effort : `sendTelegram` ne lève jamais et est un no-op sans Telegram. Le jeton d'un
      // lien n'apparaît nulle part dans ce message.
      demanderActivation: async ({ tenantId, userId, message }) => {
        await sendTelegram(`[engage-me] demande d’activation Channels Me\nespace ${tenantId}\nutilisateur ${userId ?? 'inconnu'}\n${message.slice(0, 500)}`);
      },
    },
    ops: {
      /**
       * Déposer un jeton publicitaire créé à la main (notre propre portefeuille, que la fenêtre Meta ne peut pas
       * servir). Il remplace une connexion existante, là où l'écran la refuse. Vérification chez Meta,
       * chiffrement et sort de l'ancien jeton : `src/pubs/connexion.ts`.
       */
      deposerJetonPub: connexionPub.deposerJeton,
      /**
       * 🔴 L'arrêt d'urgence d'un espace : il ferme la console et l'API publique (`/v1`, `/mcp`), il n'arrête
       * pas les campagnes déjà enfilées (runbook de `DEPLOY.md`). La note est journalisée une fois, par la
       * route (`ops_verrou_espace`) : c'est la seule trace durable du pourquoi.
       */
      verrouillerEspace: (tenantId, verrouille, _note) => opsStore.verrouillerEspace(tenantId, verrouille),
      exploitation: opsStore,
      /**
       * 🔴 La grille de prix, une pour tous les espaces, ici et pas dans les réglages du client : un client n'a
       * ni à fixer ni à voir ce qu'on lui facture, et le geste ne doit jamais être atteignable depuis la
       * console. La même lecture que celle qui marge les prix affichés (`src/stats/chiffrage.ts`).
       */
      lireGrillePrix: chiffrage.grille,
      reglages: settingsStore,
      // Les jobs morts et leur rejeu : un geste d'exploitation cross-espace, qui suppose qu'on ait corrigé la
      // cause de l'échec.
      file: queue,
      heartbeat: heartbeatStore,
      /**
       * L'attente du pool. L'état instantané ne peut être que celui de ce process (l'API voit son propre pool
       * en mémoire) ; la courbe vient de la base, seul canal par lequel le worker se montre. Le vrai signal
       * est un `waitingCount` non nul : quelqu'un attend.
       */
      etatPoolInstantane: () => ({
        process: 'api',
        total: pool.totalCount,
        libres: pool.idleCount,
        enAttente: pool.waitingCount,
        max: config.DB_POOL_MAX,
        maxMsDepuisDemarrage: Math.round(mesureAttentePool.maxDepuisDemarrage),
      }),
      attentesPool: poolAttentesStore,
      latencesHttp: httpLatencesStore,
      mesuresTaches: mesuresTachesStore,
      stockage: new PgStockageStore(pool),
      // 🔴 Le solde prépayé d'un espace pour l'agent IA. La recharge est ici parce qu'un client ne doit
      // jamais pouvoir créditer son propre compte. L'espace est résolu d'abord : en lecture, un espace inconnu
      // rendrait un solde de zéro qu'on rechargerait ; en écriture, la clé étrangère lèverait un 500 masqué
      // par Cloudflare. `getTenantName` est le même point de résolution que `/ops/observe`.
      soldeAgent: async (tenantId) => {
        if ((await opsStore.getTenantName(tenantId)) === null) return null;
        return {
          soldeMicroEur: await credits.solde(tenantId),
          mouvements: await credits.mouvements(tenantId, 50),
        };
      },
      // 🔴 Le jour où un espace se supprimera, ceci passe avant : sinon le `on delete cascade` emporte notre
      // ligne et la clé survit chez Vercel, identifiant perdu, donc facturable et irrévocable.
      ...(provisionCle ? { revoquerCleModele: (tenantId: string) => revoquerCleGateway(provisionCle, tenantId) } : {}),
      rechargerAgent: async (tenantId, montant, note) => {
        if ((await opsStore.getTenantName(tenantId)) === null) return null;
        const solde = await credits.crediter(tenantId, montant, note);
        // 🔴 Le plafond de la clé suit le rechargement, sinon le client paie et reste bloqué au plafond
        // d'avant. Les deux autres crédits (achat Stripe, crédit de bienvenue) le remontent aussi, par la même
        // fonction. Ne lève pas et n'annule rien : le rechargement est écrit, et le plafond rattrapera à la
        // remontée suivante, qui recalcule depuis le solde.
        if (provisionCle) await remonterPlafondApresRecharge(provisionCle, tenantId);
        return solde;
      },
      /**
       * Session d'observation d'un espace client : un jeton de session en lecture seule. `userId` porte une
       * valeur parlante, pas un identifiant (le porteur n'a pas de compte ici) : dans une trace, elle se lit
       * pour ce qu'elle est. Le jeton porte l'adresse de l'exploitant qui observe. Durée courte (1 h).
       */
      observerTenant: async (tenantId, observateur) => {
        const nom = await opsStore.getTenantName(tenantId);
        if (nom === null) return null;
        const token = await signSession(
          { userId: 'ops-observation', tenantId, role: 'admin', impersonated: true, observateur },
          config.AUTH_SECRET,
          '1h',
        );
        return { token, tenantName: nom };
      },
      /**
       * Le balayage du risque d'un espace, à la demande, par le câblage du worker
       * (`src/engagement/cablage.ts`) : même plafond, même émetteur, même file d'automations.
       */
      balayerRisque: lanceurBalayageRisque({
        pool,
        file: queue,
        emetteur,
        automations: automationStore,
        // eslint-disable-next-line no-console
        journal: (m) => console.warn(m),
      }),
      /**
       * Le second facteur d'une personne, depuis l'exploitation (le cas multi-espace, que l'admin d'un espace ne
       * peut pas trancher). Journalisé dans chacun de ses espaces, avec l'adresse de l'exploitant pour acteur.
       */
      reinitialiserMfa: async (email, par) => {
        const identityId = await mfaStore.reinitialiserParEmail(email);
        if (identityId === null) return null;
        const espaces = new Set((await mfaStore.comptes(identityId)).map((c) => c.tenantId)).size;
        // Le facteur est déjà retiré : un journal en échec ne doit pas faire croire que rien n'a eu lieu.
        await tenter('audit ignoré:', () => auditParIdentite(identityId, 'mfa.reinitialise', { par: 'exploitation' }, par));
        return { identityId, espaces };
      },
    },
    // Le réglage du plafond de l'API par espace : lu par le limiteur de `/v1` et `/mcp`, écrit par `/ops`.
    plafondApi: new PgPlafondEspaceStore(pool),
    // Le numéro fourni côté client (lot 3b) : la page « Connecter WhatsApp » obtient un numéro de la réserve et lit le
    // code capté par l'Asterisk. Julien est prévenu sous le seuil, au plus une fois par jour : le verrou court n'est
    // jamais relâché, son échéance EST le silence, commun à toutes les copies de l'API.
    numeroFourni: {
      numeros: numerosFournis,
      numeroConnecte,
      verrous: verrousCourts,
      alertes: creerAlertesReserve({ verrous: verrousCourts, envoyer: (texte) => sendTelegram(`[mba-${NOM_API}] ${texte}`) }),
      seuilReserve: config.ALERTE_RESERVE_SEUIL,
      abonnements: abonnementsNumero,
      abonnement: { ouvrir: (tenant, retour, payeur) => ouvrirAbonnement(abonnementDuNumero, tenant, retour, payeur) },
    },
    // La réserve de numéros fournis (lot 3a). Sans clé DIDWW ou sans trunk, la déclaration rend 503 et la lecture marche.
    opsNumeros: {
      numeros: numerosFournis,
      abonnes: abonnementsNumero,
      didww: config.DIDWW_API_KEY && config.DIDWW_TRUNK_OTP_ID
        ? { client: creerClientDidww({ cle: config.DIDWW_API_KEY, url: config.DIDWW_API_URL }), trunkId: config.DIDWW_TRUNK_OTP_ID }
        : null,
    },
    support: {
      enabled: !!config.RESEND_API_KEY && !!config.SUPPORT_TO,
      getUserEmail: async (userId) => (await userStore.getById(userId))?.email ?? null,
      sendSupport: async ({ tenantId, userId, email, subject, message }) => {
        const client = new ResendClient(config.RESEND_API_KEY);
        const text = [
          'Nouveau message de support (console MBA)',
          '',
          `Tenant : ${tenantId}`,
          `User : ${userId ?? 'inconnu'}`,
          `Email : ${email ?? 'non fourni'}`,
          '',
          `Sujet : ${subject}`,
          '',
          message,
        ].join('\n');
        await client.send({
          from: config.SUPPORT_FROM,
          to: config.SUPPORT_TO,
          subject: `[Support MBA] ${subject}`,
          text,
          ...(email ? { replyTo: email } : {}),
        });
      },
    },
    // Même envoi et même destinataire que le support : le texte du courriel se construit dans la route (testée).
    contactVitrine: {
      enabled: !!config.RESEND_API_KEY && !!config.SUPPORT_TO,
      envoyer: async ({ sujet, texte, repondreA }) => {
        await new ResendClient(config.RESEND_API_KEY).send({
          from: config.SUPPORT_FROM,
          to: config.SUPPORT_TO,
          subject: sujet,
          text: texte,
          replyTo: repondreA,
        });
      },
    },
    apiKeys: {
      audit: auditSink,
      cles: apiKeyStore,
    },
    /**
     * L'OAuth devant `/mcp` (migration 0204) : les routes publiques et celles de la console partagent le même
     * magasin, les mêmes comptes et le même secret. Ne monte rien sans `PUBLIC_API_URL`.
     */
    oauth: {
      store: oauthStore,
      comptes: userStore,
      verifyGoogle: (idToken) => verifyGoogleIdToken(idToken, config.GOOGLE_CLIENT_ID),
      secret: config.AUTH_SECRET,
      appUrl: config.APP_URL,
      audit: auditSink,
    },
    oauthConsentement: { store: oauthStore, comptes: userStore, secret: config.AUTH_SECRET, audit: auditSink },
    v1: {
      apiKeys: apiKeyStore,
      oauth: oauthStore,
      /**
       * Les catalogues de l'API publique. Ce bloc ne fait que brancher : le tri vit dans
       * `src/http/v1-catalogues.ts`, testé. `templates` passe par `catalogueTemplatesCache` (une minute) : un
       * template tout juste approuvé y paraît au plus une minute plus tard, en deçà de ce que l'envoi tolère
       * déjà (`templateVarInfo` garde cinq minutes).
       */
      catalogues: {
        templates: async (tenant) => {
          const waba = await repo.getTenantWabaId(tenant);
          if (!waba) return [];
          return catalogueTemplatesCache.lire(`${tenant}:${waba}`, async () => (await metaFactory.templateClientForTenant(tenant)).list(waba));
        },
        indices: templateHintStore,
        scenarios: workflowStore,
        messagesRcs: rcsMessageStore,
      },
      /**
       * Le relais du Meta Business Agent : le même point de passage que l'agent IA (`creerAppelConnecteur`),
       * donc les mêmes gardes, journalisé sous l'appelant `mba`.
       */
      mbaRelais: {
        numeros: repo,
        catalogue: toolCatalog,
        // Le même résolveur que les agents IA du worker (`src/worker.ts`) : un outil MCP proposé à l'agent de Meta passe
        // par notre relais, puis par lui, avec ses gardes (source active, adresse publique, transport borné).
        resolveurMcp: creerResolveurMcp({ sources: agentSources }),
        requetes: agentRequetes,
        // 🔴 Projection, jamais la ligne brute (même règle que `lireContact` du worker) : le numéro, le BSUID
        // et le statut d'opt-in n'ont rien à faire dans ce qui part vers le système du client.
        contacts: contactStore,
        appeler: creerAppelConnecteur({
          sources: agentSources,
          requetes: agentRequetes,
          inbox: inboxStore,
          fiche: contactStore,
          fuseau: async (t) => (await settingsStore.get(t)).timezone,
        }),
        journal: journalAppels,
        // La forme de l'en-tête du numéro, jamais sa valeur : sans ce journal, une macro que Meta cesserait de
        // remplir serait invisible.
        // eslint-disable-next-line no-console
        journaliserForme: (f) => console.info(`mba-relais: en-tete du numero ${f}`),
        // Borne l'attente d'un envoi avant de répondre à Meta, qui coupe un outil vers trois secondes
        // (`DELAI_REPONSE_ENVOI_MS`, `src/http/mba-relais.ts`).
        attendre: (ms) => dormir(ms),
        // Un envoi qui échoue après « C'est parti » est dit à l'agent de Meta par un événement (gardes dans le
        // module, testé).
        signalerEchecTardif: creerSignalerEchecTardif({
          inbox: inboxStore,
          numeros: repo,
          envoyer: async (t, pn, to, event) => (await metaFactory.mbaClientForTenant(t)).agentEvent(pn, to, event, AbortSignal.timeout(10_000)),
          // eslint-disable-next-line no-console
          journal: (ligne) => console.log(ligne),
        }),
        enVol: travauxEnVol,
        // Les gestes maison : les mêmes fonctions que les agents IA et le mini-CRM, aucune réécrite ici.
        maison: {
          poserTag: workflowRuntime.poserTagDepuisAgent,
          ecrireChamp: async (t, waId, champ, valeur) => { await contactStore.mergeFieldsByPhone(t, waId, { [champ]: valeur }); },
          // La même liste que la ligne rouge de l'onglet Outils (`mbaOutils.champs`), sinon l'écran et le relais
          // ne seraient pas d'accord sur ce qui existe.
          champExiste: async (t, champ) => (await fieldStore.list(t)).some((f) => f.key === champ),
          contacts: contactStore,
          // En base, partagé par les copies de l'API : un rappel servi par une autre copie ne renvoie rien.
          antiRejeu: verrousCourts,
          inbox: inboxStore,
          // Les deux gestes qui envoient : ils rendent le fil sur toute issue ratée, exception comprise
          // (`src/mba/gestes-envoi.ts`, testé).
          ...creerGestesEnvoi({
            graphePublie: async (t, id) => (await workflowStore.getById(id, t))?.graph ?? null,
            fenetreOuverte: async (t, waId) => (await inboxStore.getWindowOpenByWaIds(t, [waId])).get(waId) === true,
            contacts: contactStore,
            // Les deux types de l'agent de Meta (`src/workflow/lancements.ts`) : le bloc part du graphe réduit, sans
            // garde de fenêtre (vérifiée juste avant) ni publication ; le scénario suit la règle du bouton de l'Inbox.
            envoyerDepuisBloc: (t, workflowId, graphe, contact, noeudId) =>
              workflowRuntime.lancements.lancer({ type: 'agent_meta_bloc', tenantId: t, workflowId, graphe, contact, noeudId }),
            lancerScenario: (t, workflowId, waId, ouverte) =>
              workflowRuntime.lancements.lancer({ type: 'agent_meta_scenario', tenantId: t, workflowId, waId, fenetreOuverte: ouverte }),
            fil,
            // On ne prend le fil qu'une fois le tour de l'agent de Meta fini.
            attendreFinDuTour: creerAttendreFinDuTour({
              inbox: inboxStore,
              attendre: (ms) => dormir(ms),
              maintenant: () => Date.now(),
              // eslint-disable-next-line no-console
              journal: (ligne) => console.log(ligne),
            }),
            inbox: inboxStore,
          }),
        },
      },
      // Les fiches de l'API publique : identité multi-clés, consentement journalisé, lecture.
      contacts: creerServiceContactsV1({
        contacts: contactStore,
        fields: fieldStore,
        audit: auditSink,
        joignabiliteRcs: async (tenant, e164) => {
          const agentId = await workflowRuntime.rcsStack.agents.agentIdForTenant(tenant);
          if (!agentId) return null;
          // Les deux formes de clé du cache (`+33…` des campagnes, chiffres seuls des scénarios et de l'Inbox).
          return joignabiliteRcsToutesFormes(rcsJoignabilite, agentId, e164, Date.now());
        },
      }),
      sends: {
        resolveScenario: (tenant, ref) => resolveScenario(tenant, ref, workflowStore),
        /**
         * Cible node : le code `nod_` vit dans le graphe publié, d'où le scan des scénarios de l'espace. Le
         * graphe est rendu avec le bloc : c'est depuis lui que `ouvertureApi` juge ce qui part en premier.
         * Le libellé du bloc (ou son code à défaut) nomme la campagne dans la console.
         */
        resolveNode: async (tenant, code) => {
          const r = await resolveNode(tenant, code, workflowStore);
          // Un code `nod_` est unique : resolveNode ne produit jamais 'ambiguous', seulement not_found.
          if (!r.ok) return { ok: false, reason: 'not_found' };
          const node = r.value.graph.nodes.find((n) => n.id === r.value.nodeId);
          const label = String(node?.data.label ?? '').trim() || code;
          return { ok: true, value: { workflowId: r.value.workflowId, nodeId: r.value.nodeId, label, graph: r.value.graph } };
        },
        /**
         * 🔴 La catégorie d'un template est lue chez Meta, comme dans l'Inbox (`categorieDuModele`) : déclarée
         * par l'appelant, un template marketing annoncé « utility » partirait aux contacts sans consentement.
         * Même lecture et même cache court que le worker. Une panne de lecture est « illisible », jamais
         * « utility » par défaut.
         */
        lireModele: async (tenant, name, language) => {
          try {
            return verdictModele(await workflowRuntime.templateVarInfo(tenant, name, language), language);
          } catch (err) {
            // Journalisée : une panne durable (jeton révoqué, compte déconnecté) rendrait sinon 422 pour
            // toujours sans aucune trace chez nous.
            console.error('v1/sends: lecture du template chez Meta échouée:', messageDe(err));
            return { statut: 'illisible' };
          }
        },
        inbox: inboxStore,
        // Bloqués compris à la lecture des fiches : l'API les écarte avec un motif au lieu de les perdre.
        repo,
        // La garde de ce process, celle dont « Délier » et « Relier » vident le cache.
        numerosDelies: gardeNumeroDelie,
        // La résolution de fiche et l'écriture du consentement, sur les mêmes dépendances que `/v1/contacts`
        // (le dépôt des contacts et `depsConsentementDe`). Les quatre paramètres de chaque flèche sont gardés
        // par `tests/v1-cablage.test.ts`.
        resoudreFiche: (tenant, cles, o) => resoudreFiche(contactStore, tenant, cles, o),
        appliquerConsentement: (tenant, contactId, consent, source) => appliquerConsentement(depsConsentement, tenant, contactId, consent, source),
        enqueue: (campaignId, tenantId, count, rate) =>
          relanceurDeCampagnes(queue, config)({ campaignId, tenantId, pendingCount: count, ratePerMinute: rate }),
        idempotence: idempotencyStore,
        // La cible `rcsMessage` : la bibliothèque par son nom, et l'agent RCS de l'espace.
        rcs: { messages: rcsMessageStore, agents: workflowRuntime.rcsStack.agents },
      },
      /**
       * `POST /v1/messages/whatsapp` : un simple texte dans la fenêtre de 24 h. Ce bloc ne fait que brancher :
       * les quatre gestes (fenêtre, désabonnement, envoi, trace) vivent dans `repondreDansLaFenetre`, partagé
       * avec la console et le serveur MCP.
       * 🔴 `estDesabonne` y est branchée, requise par le type : une machine ne parle pas à quelqu'un qui a dit
       * STOP, et la règle vise tout ce qui n'est pas un opérateur humain, pas une liste d'appelants.
       */
      messages: {
        repondre: depsRepondre,
        // La même résolution de fiche, sur le même dépôt, que `/v1/contacts` et `/v1/sends`. La route demande
        // `jamais` : un message simple ne crée pas de fiche.
        resoudreFiche: (tenant, cles, o) => resoudreFiche(contactStore, tenant, cles, o),
        // Le fil cherché, jamais créé : un refus ne laisse pas de fil vide dans l'Inbox. Même fragment que le
        // bouton « Ouvrir la conversation » du mini-CRM, qui refuse un contact supprimé comme un contact
        // bloqué : c'est la garde de blocage de cette route.
        inbox: inboxStore,
      },
      /**
       * `POST /v1/messages/rcs`. Ce bloc ne fait que brancher : les gardes du RCS vivent dans
       * `envoyerRcsLibre`, la même fonction que le bouton RCS de l'Inbox (`depsRcsLibre`).
       */
      messagesRcs: {
        // La même résolution de fiche que `sends` et `messages`, sur le même dépôt que `/v1/contacts` : sinon
        // une personne serait trouvée par une route et pas par l'autre. Ses quatre paramètres passent.
        resoudreFiche: (tenant, cles, o) => resoudreFiche(contactStore, tenant, cles, o),
        contacts: contactStore,
        rcs: depsRcsLibre,
        inbox: inboxStore,
        // `app_human`, comme les autres machines : le scénario cesse d'avancer seul. Qui a parlé est porté par
        // l'origine du message (`api`).
        takeControl: fil.prisEnEcrivant,
      },
      /**
       * Serveur MCP (`POST /mcp`) : les mêmes fonctions que la console, jamais des variantes. Un outil MCP
       * n'est qu'un second appelant : une garde qui change (fenêtre de 24 h, prise de fil, scope tenant) change
       * pour les deux d'un coup.
       */
      mcp: {
        ...depsRepondre,
        contacts: contactStore,
        // La pose d'étiquettes de `tag_conversation` : le MÊME module que la fiche et l'agent, appelé SANS publier.
        etiquettes: workflowRuntime.etiquettes,
        listerMembres: async (tenant) => (await userStore.list(tenant)).map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role })),
        // Les widgets de l'écran, le MÊME objet : un outil MCP n'est qu'un second appelant de leur gestion.
        widgets: widgetsDeLaConsole,
        scenarios: workflowStore,
        // L'agent IA et le crédit : les MÊMES objets que leurs routes. Seul le journal des suppressions de
        // connaissance change, pour signer l'origine `mcp`.
        agentIa: {
          gestion: agentsDeLaConsole,
          connaissance: { ...connaissanceDeLaConsole, journaliserSuppression: journaliserSuppressionDe('mcp') },
          essai: essaiDeLaConsole,
          paiement: paiementDeLaConsole,
          outils: toolCatalog,
          reglages: settingsStore,
          repondeur: repondeurDeLaConsole,
        },
        // La connexion du numéro depuis Claude Code (lot 3c) : le lien signé avec le secret des sessions, vers la page
        // `/brancher` de la console, et la MÊME lecture de l'état que cette page.
        numero: {
          signerLien: (l) => signLienNumero(l, config.AUTH_SECRET),
          etat: (tenant) => lireEtatConnexion({ numeros: numerosFournis, numeroConnecte, abonnements: abonnementsNumero }, tenant),
          urlConsole: config.APP_URL,
          attendre: (ms) => new Promise((r) => { setTimeout(r, ms); }),
          maintenant: () => Date.now(),
          ouvrirPortail: (tenant, payeur) => ouvrirPortail(abonnementDuNumero, tenant, 'console', payeur),
        },
      },
    },
  });

  /**
   * L'attente du pool, versée en base une fois par minute. Chaque processus a son propre pool : une ligne par
   * processus et par minute, sous son nom (`NOM_API` ici), jamais agrégées, pour savoir lequel souffre. Une seule
   * minuterie, posée à la main, `unref` (elle ne retient pas le process) et arrêtée dans l'arrêt propre.
   */
  /**
   * La latence HTTP, sous le même nom de copie. ⚠️ PAS dans `sansSeMesurer` : la suspension vaut pour tout le
   * processus, et sur un pool saturé ce vidage attendrait jusqu'au délai de connexion, rendant la saturation
   * invisible au moment exact où elle a lieu. Il compte donc pour une acquisition par minute, ce qui est vrai.
   */
  const viderLatences = (): Promise<boolean> => viderLatencesVersLaBase(httpLatencesStore, mesureLatence, NOM_API, new Date(), (err) => {
    // eslint-disable-next-line no-console
    console.error('latences-http: écriture impossible:', messageDe(err));
  });
  /**
   * La surveillance des workers (`src/ops/surveillance-workers.ts`) : l'API est le seul processus qui ne dépend pas
   * d'eux, c'est donc elle qui prévient quand l'un se tait. Une alerte par épisode pour tout le service, même avec
   * plusieurs copies : un verrou court en base décide qui envoie.
   */
  const surveillerWorkers = creerSurveillanceWorkers({
    lister: () => heartbeatStore.lister(),
    verrous: verrousCourts,
    envoyer: (texte) => sendTelegram(`[mba-${NOM_API}] ${texte}`),
  });
  const minuteriePoolAttentes = setInterval(() => {
    void viderVersLaBase(poolAttentesStore, mesureAttentePool, NOM_API, new Date(), (err) => {
      // eslint-disable-next-line no-console
      console.error('pool-attentes: écriture impossible:', messageDe(err));
    });
    void viderLatences();
    void surveillerWorkers().catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error('surveillance-workers: lecture impossible:', messageDe(err));
    });
  }, 60_000);
  minuteriePoolAttentes.unref?.();

  installGracefulShutdown(async () => {
    clearInterval(minuteriePoolAttentes);
    await arreterApi({
      fermerServeur: () => app.close(),
      travaux: travauxEnVol,
      borneMs: ATTENTE_GESTES_A_L_ARRET_MS,
      fermerFile: () => queue.stop(),
      // Le dernier vidage, une fois le serveur fermé et les requêtes en vol finies : sinon chaque déploiement perd sa
      // dernière minute, celle du redémarrage.
      fermerPool: async () => { await viderLatences(); await pool.end(); },
      // eslint-disable-next-line no-console
      journal: (ligne) => console.warn(ligne),
    });
  });
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  // eslint-disable-next-line no-console
  console.log(`messagingme-mba api en écoute sur :${config.PORT}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
