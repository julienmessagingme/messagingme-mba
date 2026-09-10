import 'dotenv/config';
import { buildServer } from './server';
import { config } from './config';
import { adressesPubliques } from './lib/adresses-publiques';
import { surveillerOps } from './ops/tentatives';
import { sendTelegram } from './ops/telegram';
import { PgBossQueue } from './queue/pgboss';
import { pool, mesureAttentePool } from './db/pool';
import { PgContactStore } from './crm/contact-store.pg';
import { PgContactHistoryStore } from './crm/contact-history.pg';
import { PgUserFieldStore } from './crm/field-store.pg';
import { PgTagStore } from './crm/tag-store.pg';
import { ensureField, ensureFieldByKey, WHATSAPP_OPTIN_FIELD_KEY, WHATSAPP_OPTIN_FIELD_LABEL } from './crm/fields';
import { PgCampaignRepo, PgRecipientStore } from './campaign/store.pg';
import { PgCampaignDraftStore } from './campaign/draft-store.pg';
import { PgInboxStore } from './inbox/store.pg';
import { PgStatsStore } from './stats/store.pg';
import { PgConversationStatsStore } from './stats/conversation-stats.pg';
import { estimateCostSeries, estimateCoutParCampagne, type CategoryRates } from './stats/cost';
import { assemblerDetailCampagne } from './stats/cout-campagne';
import { rangeToUnix, addDays, todayParis } from './stats/range';
import type { CompteurClic } from './links/mesures';

import { cacheCourt } from './lib/cache-court';
import { ResendClient } from './support/resend';
import { PgTenantSettingsStore } from './settings/store.pg';
import { PgUserAuthStore } from './auth/store';
import { PgUserStore } from './user/store.pg';
import { PgAuthTokenStore } from './auth/token-store.pg';
import { verifyGoogleIdToken } from './auth/google';
import { PgFlowStore } from './flow/store.pg';
import { PgApiKeyStore } from './auth/api-key-store.pg';
import { upsertContactsFromApi } from './api/contacts-upsert';
import { PgApiIdempotencyStore } from './api/idempotency-store.pg';
import { PgAuditStore } from './audit/store.pg';
import { PgErreursLivraisonStore } from './ops/erreurs-livraison.pg';
import { PLAFOND_CONTACTS_ERREUR } from './http/stats';
import { PgPoolAttentesStore, viderVersLaBase } from './ops/pool-attentes.pg';
import { PgWorkflowNodeEventStore } from './workflow/node-events.pg';
import { PgWorkflowReportStore } from './workflow/reports.pg';
import { PgTrackedLinkStore } from './links/tracked-links.pg';
import { lienDe, lienTraceAvecJeton } from './links/rewrite';
import { noeudsTemplate, compteursDeClics, liensRcsDesNoeuds, compteursDeClicsRcs } from './links/mesures';
import { aDesLiensTracables } from './links/rcs-liens';
import { fabriquerJeton } from './links/jeton-contact';
import { newTrackingCode } from './ids/code';
import type { AuditSink } from './audit/journal';
import { resolveScenario, resolveNode } from './ids/resolve';
import { enqueueCampaignRun } from './campaign/enqueue';
import { resolveRatePerMinute } from './campaign/pacing';
import { fetchHubspotLists, importHubspotList, disconnectHubspot, fetchHubspotDealStages } from './crm/hubspot-service';
import { PgTemplateHintStore } from './crm/template-hints.pg';
import { MetaMediaClient } from './meta/media';
import { PgPhoneStatusStore } from './account/store.pg';
import { pullFromInfo, pullFromError } from './account/pull';
import { PgOpsStore } from './ops/store.pg';
import { PgWorkerHeartbeatStore } from './ops/heartbeat-store.pg';
import { makeDbReadinessCheck } from './db/readiness';
import { PgAutomationStore } from './automation/store.pg';
import { PgChannelsMeConnectionStore } from './channels-me/connection-store.pg';
import { PgChannelsMeLinkStore } from './channels-me/link-store.pg';
import { normalizeText } from './automation/match';
import { PgChannelsMePostStore } from './channels-me/post-store.pg';
import { ChannelsMeClient } from './channels-me/client';
import { enfilerEvenementAutomation, type AutomationEventJob } from './automation/event-job';
import { PgWebhookStore } from './webhook-entrant/store.pg';
import { RateLimiter } from './auth/rate-limit';
import { PgWorkflowStore } from './workflow/store.pg';
import { resolveTenantCode } from './ids/tenant-code';
import { MetaEmbeddedSignupClient } from './meta/embedded-signup';
import { PgEmbeddedSignupStore } from './account/es-store.pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { MetaCredentialsResolver } from './meta/credentials';
import { fetchUrlBorne } from './lib/page-distante';
import { signSession } from './auth/token';
import { ecrireHandoffEnabled } from './mba/handoff';
import { MetaClientFactory } from './meta/factory';
import { arbitreDeDebit } from './meta/arbitre-debit';
import { arbitreDeDebitPartage, depsPorteDebitPg } from './meta/arbitre-debit-partage';
import { buildTemplateComponents, carouselSendBlocker } from './meta/template-components';
import { buildWorkflowRuntime } from './workflow/wiring';
import { PgEmailAccountStore } from './email/account-store.pg';
import { PgEmailTemplateStore } from './email/template-store.pg';
import { PgRcsMessageStore } from './rcs/message-store.pg';
import type { RcsOutbound } from './rcs/types';
import { PgRcsMediaStore } from './rcs/media-store.pg';
import { urlImageRcs } from './rcs/image';
import { newMediaCode } from './ids/code';
import { verifierCleRcs } from './rcs/channel-info';
import { fetchGet } from './lib/http-get';
import { lireCatalogueGateway } from './agent/llm/modeles-gateway';
import { modelesProposables, type ModeleGateway } from './agent/modeles';
import { apercuMo } from './rcs/callback';
import { estDemandeArret } from './crm/consentement';
import { apercuRcsSortant } from './rcs/schema';
import { aDesVariables, appliquerVariables } from './rcs/variables';
import { contactVars } from './crm/render';
import { resolveHintParams } from './crm/template';
import { EmailAccountResolver } from './email/resolver';
import { buildTransport as buildEmailTransport } from './email/smtp';
import { FetchTransport, HTTP_TIMEOUT_MODELE_MS } from './meta/http';
import { PgAgentStore } from './agent/agent-store.pg';
import { PgKnowledgeStore } from './agent/knowledge.pg';
import { creerRechercheSemantique } from './agent/recherche';
import { PgToolCatalog } from './agent/catalog.pg';
import { lireContexteAgent } from './agent/contexte';
import { PgCreditStore } from './agent/credits.pg';
import { PgCleGatewayStore } from './agent/cles-gateway.pg';
import { transcrireMessage } from './inbox/transcrire';
import { assurerCleGateway, remonterPlafondApresRecharge, revoquerCleGateway, type DepsProvisionCle } from './agent/provisionner-cle';
import { encryptSecret, decryptSecret } from './crypto/secretbox';
import { PgAgentSessionStore } from './agent/session-store.pg';
import { PgSourceStore } from './agent/sources.pg';
import { PgRequeteStore } from './agent/requetes.pg';
import { PgEntretienStore } from './agent/setup/entretien-store.pg';
import { PgTestRunStore } from './agent/test-runs.pg';
import { creerResolveurHttp } from './agent/resolvers/http';
import { construireCible, enTetesAuthSource } from './agent/http-cible';
import { resolutionPublique } from './lib/adresse-privee';
import { GatewayChatClient } from './agent/llm/chat-client';
import { creerRendreLeFil } from './inbox/rendre-le-fil';
import { consommateurMba } from './agent/consommateur';
import { corpsConnecteurMeta, corpsOutilMeta, corpsApiKey } from './http/mba-publication';
import { creerResolveurSimulation } from './agent/resolvers/simulation';
import { JOURNAL_MUET } from './agent/journal-muet';
import { installGracefulShutdown } from './shutdown';
import type { CountryCode } from 'libphonenumber-js';
import { handlerMaison } from './agent/outils-maison';

async function main(): Promise<void> {
  /**
   * Les deux bases d'adresses publiques, résolues UNE fois. `PUBLIC_API_URL` vide (le cas d'aujourd'hui) rend
   * exactement ce que `APP_URL` rendait avant : ce câblage est donc sans effet tant qu'on ne pose pas la
   * variable. Détail de la règle et de son cas particulier dans `src/lib/adresses-publiques.ts`.
   */
  const adressesApi = adressesPubliques(config.APP_URL, config.PUBLIC_API_URL);

  // `supervise: false` : l'API ne fait qu'EMPILER des jobs, elle n'en dépile aucun. Superviser (récupération des
  // jobs expirés, monitoring, flow) est le travail du worker. Laisser l'API superviser doublait la maintenance
  // sur la base pour zéro bénéfice : mesuré le 2026-08-17, c'était la moitié des ~55 000 requêtes/jour de
  // maintenance du projet, sur un quota d'egress Supabase déjà dépassé.
  const queue = new PgBossQueue(config.DATABASE_URL, config.PGBOSS_SCHEMA, {
    max: config.PGBOSS_MAX,
    connectionTimeoutMillis: config.DB_CONN_TIMEOUT_MS,
    supervise: false,
  });
  // Un event `error` de pg-boss non capté est une exception non gérée qui tue l'API. On le journalise
  // et on laisse tourner : une saturation ponctuelle du pooler ne doit pas coûter un redémarrage.
  // eslint-disable-next-line no-console
  queue.onError((err) => console.error('[pg-boss:api]', err instanceof Error ? err.message : err));
  await queue.start();

  const repo = new PgCampaignRepo(pool);
  // Statuts de livraison des destinataires. Le worker en a le sien pour les accusés Meta ; l'API en a besoin
  // parce que les rappels du fournisseur RCS arrivent SUR L'API (le worker n'expose aucune route publique).
  const recipientStore = new PgRecipientStore(pool);
  const campaignDraftStore = new PgCampaignDraftStore(pool);
  const contactStore = new PgContactStore(pool);
  const contactHistoryStore = new PgContactHistoryStore(pool);
  const templateHintStore = new PgTemplateHintStore(pool);
  const fieldStore = new PgUserFieldStore(pool);
  const tagStore = new PgTagStore(pool);
  const inboxStore = new PgInboxStore(pool);
  const statsStore = new PgStatsStore(pool);
  // Lecture des agrégats d'analyse de conversation (Pièce 1). `enabled` = état de la feature côté serveur
  // (empty-state différencié). La lecture ne coûte rien ; l'écriture (analyse LLM) est gatée ailleurs.
  // La rétention vient du MÊME endroit que la purge du worker (`CONVERSATION_RETENTION_DAYS`) : l'écran
  // annonce ainsi le nombre réellement appliqué, pas une valeur recopiée qui dériverait le jour où on la change.
  const conversationStatsStore = new PgConversationStatsStore(pool, config.CONVERSATION_ANALYSIS_ENABLED === 'true', config.CONVERSATION_RETENTION_DAYS);
  const settingsStore = new PgTenantSettingsStore(pool);
  const userStore = new PgUserStore(pool);
  const authTokenStore = new PgAuthTokenStore(pool);
  const flowStore = new PgFlowStore(pool);
  const apiKeyStore = new PgApiKeyStore(pool);
  const idempotencyStore = new PgApiIdempotencyStore(pool);
  const auditStore = new PgAuditStore(pool);
  const erreursLivraison = new PgErreursLivraisonStore(pool);
  const poolAttentesStore = new PgPoolAttentesStore(pool);
  const nodeEventStore = new PgWorkflowNodeEventStore(pool);
  const trackedLinkStore = new PgTrackedLinkStore(pool);
  const webhookStore = new PgWebhookStore(pool);
  const reportStore = new PgWorkflowReportStore(pool);
  // L'email de l'acteur est résolu ICI, une fois, et écrit en clair dans le journal : une jointure sur `users`
  // rendrait l'historique illisible au premier départ d'un collaborateur.
  const auditSink: AuditSink = async (tenant, actor, action, target, detail) => {
    const email = actor.userId ? (await userStore.getSessionUser(actor.userId))?.email ?? null : null;
    await auditStore.record(tenant, { userId: actor.userId, email }, action, target, detail);
  };
  const phoneStatusStore = new PgPhoneStatusStore(pool);
  const opsStore = new PgOpsStore(pool, config.PGBOSS_SCHEMA);
  const heartbeatStore = new PgWorkerHeartbeatStore(pool);
  const workflowStore = new PgWorkflowStore(pool);
  const agentStore = new PgAgentStore(pool);
  const knowledgeStore = new PgKnowledgeStore(pool);
  // Une seule fabrique pour les trois usages (agent, bac a sable, balayage) : trois constructions seraient
  // trois occasions de cabler un modele ou un seuil different.
  const rechercheSemantique = creerRechercheSemantique();
  const toolCatalog = new PgToolCatalog(pool);
  const credits = new PgCreditStore(pool);
  // Lecture SEULE, pour le suivi de consommation d'un agent. Le store d'ECRITURE des sessions vit dans le
  // cablage du worker (`src/workflow/wiring.ts`) : c'est lui qui les fait avancer, l'API ne fait qu'agreger.
  const agentSessions = new PgAgentSessionStore(pool);
  const agentSources = new PgSourceStore(pool);
  const agentRequetes = new PgRequeteStore(pool);
  /**
   * LA CLE DE MODELE PROPRE A CHAQUE ESPACE (2026-09-09).
   *
   * 🔴 LE CHIFFREMENT EST INJECTE, il n'est pas relu dans le store : meme contrat que
   * `PgChannelsMeConnectionStore`. Un store qui irait chercher la cle de chiffrement tout seul serait un
   * second endroit ou la lire, donc un second endroit ou l'oublier.
   */
  const clesGateway = new PgCleGatewayStore(
    pool,
    (clair) => encryptSecret(clair, config.ENCRYPTION_KEY),
    (chiffre) => decryptSecret(chiffre, config.ENCRYPTION_KEY),
    // ⚠️ Le repli sur la cle maison est SILENCIEUX par nature : les agents repondent, tout a l'air normal, et
    // la depense de cet espace cesse d'etre attribuee. Sans cette ligne, personne ne l'apprend jamais.
    (tenantId, err) => { app.log.error({ err, tenantId }, 'cle_gateway_indechiffrable'); },
  );
  /**
   * ⚠️ `null` quand le jeton Vercel n'est pas configure : le provisionnement est alors ETEINT et la creation
   * d'agent se comporte comme avant. C'est ce qui permet de deployer ce lot avant d'avoir pose le jeton.
   */
  const provisionCle: DepsProvisionCle | null = config.VERCEL_API_TOKEN !== '' && config.VERCEL_TEAM_ID !== ''
    ? {
      cles: clesGateway,
      solde: (tenant) => credits.solde(tenant),
      nomEspace: async (tenant) => {
        const r = await pool.query<{ name: string }>('select name from tenants where id = $1', [tenant]);
        return r.rows[0]?.name ?? null;
      },
      transport: new FetchTransport(),
      jetonCompte: config.VERCEL_API_TOKEN,
      teamId: config.VERCEL_TEAM_ID,
      cleGatewayMaison: config.AI_GATEWAY_API_KEY,
      tauxEurParDollar: config.EUR_PER_USD,
    }
    : null;

  // Vide -> la conversation de construction repond 503, aucun crash au boot.
  // ⚠️ Le 3e argument est le resolveur de cle PAR ESPACE : sans lui, tous les appels partiraient sur la cle
  // maison et aucune depense ne serait attribuee, ce qui est exactement ce que ce lot vient corriger.
  const gateway = config.AI_GATEWAY_API_KEY
    ? new GatewayChatClient(config.AI_GATEWAY_API_KEY, undefined, async (tenant) => (await clesGateway.lire(tenant))?.cle ?? null)
    : null;
  const automationStore = new PgAutomationStore(pool);
  // Chaine WhatsApp (Channels Me). La cle de chiffrement est INJECTEE au store (contrat du sous-systeme),
  // elle n'est pas relue depuis la config a l'interieur : les deux secrets sont chiffres la, jamais plus haut.
  const channelsMeConnections = new PgChannelsMeConnectionStore(pool, config.ENCRYPTION_KEY);
  const channelsMeLinks = new PgChannelsMeLinkStore(pool);
  const channelsMePosts = new PgChannelsMePostStore(pool);
  // Hote FIXE et de confiance : aucune verification d'adresse privee, meme traitement que les clients Meta
  // et Zadarma.
  const channelsMeClient = new ChannelsMeClient();
  // Node « Envoi de mail » : boîtes SMTP + modèles (scopés tenant), résolveur de transport à cache par
  // tenant+compte (invalidé par les routes email à chaque écriture d'un compte).
  const emailAccounts = new PgEmailAccountStore(pool);
  const emailTemplates = new PgEmailTemplateStore(pool);
  const rcsMessageStore = new PgRcsMessageStore(pool);
  const rcsMediaStore = new PgRcsMediaStore(pool);
  const emailResolver = new EmailAccountResolver({
    getDecrypted: (t, id) => emailAccounts.getDecrypted(t, id),
    buildTransport: buildEmailTransport,
  });
  const transport = new FetchTransport();
  // Clients Meta phone/pricing/templates/flows : résolus PAR TENANT via metaFactory (B1, plus de singleton global).
  // media reste global : endpoint /{appId}/uploads app-scoped (décision assumée, cf. .loop/bloc4.md).
  const mediaClient = new MetaMediaClient(config.META_ACCESS_TOKEN, config.META_APP_ID, config.META_GRAPH_VERSION);

  // Résolution du token Meta PAR TENANT (B1). SOMMEIL : repli sur le token global tant qu'aucun WABA n'a de
  // credentials propres -> le numéro Zadarma reste sur config.META_ACCESS_TOKEN, comportement identique.
  const esCredentialsStore = new PgEmbeddedSignupStore(pool);
  const metaCredentials = new MetaCredentialsResolver({
    getWabaIdForTenant: (t) => repo.getTenantWabaId(t),
    getCredentialsByWaba: (w) => esCredentialsStore.getCredentialsByWaba(w),
    markTokenInvalid: (w) => esCredentialsStore.markTokenInvalid(w),
    decrypt: (enc) => decryptSecret(enc, config.ENCRYPTION_KEY),
    fallbackToken: config.META_ACCESS_TOKEN,
  });
  const metaFactory = new MetaClientFactory({
    resolver: metaCredentials,
    transport,
    version: config.META_GRAPH_VERSION,
    marketingViaLite: config.META_MM_LITE === 'true',
    // Frein PAR NUMÉRO, partagé par tout ce qui envoie depuis lui (lot 4). Instancié ICI, donc un par
    // process : le budget n'est pas partagé entre l'API et le worker, et `arbitre-debit.ts` dit pourquoi
    // c'est acceptable aujourd'hui et pourquoi ça ne le sera plus au second worker.
    // Le budget du numéro est PARTAGÉ entre l'API et le worker (migration 0102). L'arbitre local reste
    // dessous : il est le repli si la base de débit ne répond pas, donc le pire cas de ce montage est
    // exactement le comportement d'avant, jamais une absence de frein.
    arbitreDebit: arbitreDeDebitPartage(
      arbitreDeDebit(config.PHONE_RATE_PER_MINUTE_MAX),
      config.PHONE_RATE_PER_MINUTE_MAX,
      depsPorteDebitPg(pool),
    ),
  });

  /**
   * Rendre le fil à l'agent de Meta. MÊME module que le balayage du worker (`src/inbox/rendre-le-fil.ts`) :
   * le geste vivait dans une fermeture du worker, donc l'API ne pouvait pas l'appeler, et le bouton « rendre
   * la main » de l'Inbox n'écrivait que notre état local.
   */
  const rendreLeFilAuMba = creerRendreLeFil({
    numeroDuTenant: (t) => repo.getTenantPhoneNumberId(t),
    clientMba: (t) => metaFactory.mbaClientForTenant(t),
  });

  /**
   * DRY_RUN : aucun appel Meta. ⚠️ L'API ne lisait PAS ce drapeau jusqu'ici, alors que le worker le respecte
   * dans chacune de ses dep d'envoi. Le câbler est indispensable avant de donner à l'API le droit d'exécuter
   * un scénario : sans ça, un déploiement déclaré DRY_RUN enverrait pour de vrai depuis l'Inbox.
   */
  const dryRun = config.DRY_RUN === 'true';

  /**
   * Exécuteur de scénarios, câblage PARTAGÉ avec le worker (`workflow/wiring.ts`). Il apporte aussi la
   * préparation des visuels de carousel et la lecture mémoïsée du corps d'un template : l'API en avait sa
   * propre version, plus courte et sans cache, ce qui en faisait un troisième doublon de cette famille.
   */
  const workflowRuntime = buildWorkflowRuntime({
    pool, queue, dryRun, repo, contactStore, inboxStore, settingsStore, workflowStore, metaCredentials, metaFactory,
    rcsProvider: config.RCS_PROVIDER,
    // Node « Envoi de mail » (Task 8) : mêmes instances que celles passées aux routes email (registerRoutes,
    // ci-dessous), pour que l'invalidation du résolveur à une écriture de compte vaille aussi pour l'exécuteur.
    emailTemplates, emailResolver,
  });

  // Envoi d'email auth (liens reset/invitation) : seulement si Resend est configuré, sinon undefined.
  const sendAuthEmail = config.RESEND_API_KEY
    ? async ({ to, subject, text, html }: { to: string; subject: string; text: string; html?: string }) => {
        await new ResendClient(config.RESEND_API_KEY).send({ from: `Messaging Me <${config.SUPPORT_FROM}>`, to, subject, text, ...(html ? { html } : {}) });
      }
    : undefined;
  /**
   * Les TARIFS Meta de la période (par catégorie, plus la devise), pour un espace donné.
   *
   * 🔴 UN SEUL LECTEUR DE `pricing_analytics`, parce que DEUX écrans du même onglet en dépendent : le
   * graphe de coût estimé et le tableau « coût par engagement » de la synthèse. Deux lectures écrites
   * séparément finiraient par diverger (une qui lit la devise, l'autre non ; une qui retombe sur zéro,
   * l'autre sur null), et le client comparerait deux totaux qui devraient être le même.
   *
   * ⚠️ `null` partout quand l'espace n'a pas de WABA ou que Meta ne rend rien : c'est cette absence qui
   * fait dire aux deux écrans « tarif indisponible » au lieu d'afficher un coût inventé.
   */
  const tarifsMeta = async (tenant: string, range: { from: string; to: string }): Promise<CategoryRates> => {
    const wabaId = await repo.getTenantWabaId(tenant);
    const { startTs, endTs } = rangeToUnix(range);
    const pricingClientT = wabaId ? await metaFactory.pricingClientForTenant(tenant) : null;
    const pricing = pricingClientT && wabaId ? await pricingClientT.getPricingAnalytics(wabaId, startTs, endTs) : null;
    return {
      marketing: pricing?.byCategory['marketing']?.ratePerMessage ?? null,
      utility: pricing?.byCategory['utility']?.ratePerMessage ?? null,
      currency: pricing?.currency ?? null,
    };
  };

  /** Micro-cache de la pastille du numéro : dix minutes, très en deçà de la durée de vie de l'URL signée. */
  const photoNumeroCache = cacheCourt<string | null>(10 * 60_000);

  /**
   * Micro-cache du CATALOGUE de modèles du Gateway : une heure.
   *
   * Un catalogue de 373 modèles et leurs tarifs ne bouge pas d'une minute à l'autre, et cette lecture sert un
   * menu déroulant qu'on ouvre en réglant un agent. Sans cache, chaque ouverture de l'onglet Modèle, de
   * chaque onglet de navigateur ouvert, referait un aller-retour de plusieurs centaines de millisecondes vers
   * Vercel pour une réponse identique.
   */
  const catalogueModelesCache = cacheCourt<ModeleGateway[]>(60 * 60_000);

  const app = buildServer({
    /**
     * 🔴 SURVEILLANCE DE `/ops` (décision de Julien, 2026-09-03). `/ops` ouvre la lecture de toutes les
     * conversations de tous les clients, et Fastify tourne sans journal d'accès : jusqu'ici, quelqu'un qui
     * cherchait le jeton ne laissait AUCUNE trace. On n'a pas durci l'accès (une liste blanche d'IP couperait
     * Julien dès que son IP change), on l'a rendu VISIBLE.
     *
     * `sendTelegram` est un no-op silencieux si Telegram n'est pas configuré : cette surveillance journalise
     * alors, sans alerter, ce qui reste mieux que rien.
     */
    surveillanceOps: surveillerOps({
      alerter: (m) => { void sendTelegram(`[mba-api] ${m}`); },
      // eslint-disable-next-line no-console
      journaliser: (m) => { console.warn(m); },
    }),
    // Origines autorisées à appeler l'API depuis un navigateur. Vide (le cas d'aujourd'hui) -> aucun en-tête
    // CORS n'est posé du tout. Voir `src/server.ts` pour les deux règles qui la rendent sûre.
    corsOrigins: config.CORS_ORIGINS.split(',').map((o) => o.trim()).filter((o) => o !== ''),
    queue,
    // Readiness : `select 1` (timeout court 2 s) -> /health 503 si la DB est injoignable. /live reste trivial.
    checkReadiness: makeDbReadinessCheck(pool, 2000),
    auth: {
      users: new PgUserAuthStore(pool),
      secret: config.AUTH_SECRET,
      // Re-vérif par requête : compte révoqué/supprimé -> 401 immédiat, rôle frais depuis la base.
      getUserState: (userId) => userStore.getAuthState(userId),
      // Refonte auth : inscription libre, reset/changement de mot de passe.
      createTenantWithAdmin: (name, admin) => userStore.createTenantWithAdmin(name, admin),
      setPassword: (userId, hash) => userStore.setPassword(userId, hash),
      touchLastLogin: (userId) => userStore.touchLastLogin(userId),
      getPasswordHash: (userId) => userStore.getPasswordHash(userId),
      sessionUser: (userId) => userStore.getSessionUser(userId),
      tokens: authTokenStore,
      appUrl: config.APP_URL,
      resetTtlMs: config.RESET_TOKEN_TTL_MS,
      // Se connecter avec Google : client public (bouton front) + vérif serveur du jeton ID + liaison par email.
      googleClientId: config.GOOGLE_CLIENT_ID,
      verifyGoogle: (idToken) => verifyGoogleIdToken(idToken, config.GOOGLE_CLIENT_ID),
      getUserByEmail: (email) => userStore.getByEmail(email),
      ...(sendAuthEmail ? { sendEmail: sendAuthEmail } : {}),
    },
    import: {
      contacts: contactStore,
      userFields: fieldStore,
      defaultCountry: config.DEFAULT_COUNTRY as CountryCode,
      listContacts: (tenantId, limit, offset, tag) => contactStore.list(tenantId, limit, offset, tag),
      queryContacts: (tenantId, filters, limit, offset) => contactStore.query(tenantId, filters, limit, offset),
      countContacts: (tenantId, filters) => contactStore.count(tenantId, filters),
      contactIdsForFilters: (tenantId, filters) => contactStore.idsForFilters(tenantId, filters),
      audit: auditSink,
    },
    campaigns: {
      repo,
      queue,
      drafts: campaignDraftStore,
      // Palier d'envoi du numéro, pour AVERTIR avant un lancement plus gros que ce que Meta laissera passer
      // en 24 h (lot 7). Lecture du relevé déjà persisté, aucun appel Graph sur ce chemin.
      getMessagingLimitTier: async (tenant) => (await phoneStatusStore.getPhoneNumber(tenant))?.messagingLimitTier ?? null,
      phoneNumberBelongsToTenant: (pn, tenant) => repo.phoneNumberBelongsToTenant(pn, tenant),
      // La MÊME résolution de cible que les actions en masse du mini-CRM : une campagne désigne ses
      // destinataires comme le mini-CRM désigne les siens, donc par l'intention et non par une liste
      // d'identifiants qui ne tiendrait pas dans le corps de la requête.
      // 🔴 `limite` DOIT ÊTRE RELAYÉE. Une flèche à DEUX paramètres est parfaitement assignable à un contrat
      // qui en déclare TROIS : le troisième est avalé EN SILENCE, le typecheck ne dit rien, et la route qui
      // passe soigneusement `plafond + 1` retombe sur le plafond technique de 100 000 du store. C'est le
      // défaut même que ce lot ferme, reproduit dans son propre câblage. Trouvé par la contre-vérification
      // du 2026-09-03, pas par le compilateur, qui ne peut pas le voir.
      contactIdsForTarget: (tenant, target, limite) => contactStore.contactIdsForTarget(tenant, target, limite),
      // Le plafond de taille, sur le chemin « tous les contacts », celui qui n'était borné par rien.
      // Bornée à `limite` : le chemin « tous les contacts » ne compte plus, il FIGE son jeu d'identifiants
      // (constat B4). `{ filters: {} }` sélectionne l'espace entier, exactement comme le comptage d'avant,
      // et les contacts bloqués qu'il ramène sont écartés au chargement (`listContactsForBuildByIds`), donc
      // la liste finale de destinataires est identique.
      identifiantsDeTousLesContacts: (tenant: string, limite: number) => contactStore.contactIdsForTarget(tenant, { filters: {} }, limite),
      plafondDestinataires: config.CAMPAIGN_MAX_RECIPIENTS,
      // Garde d'isolation du canal RCS, symétrique de celle du numéro Meta : le partenaire RBM est global,
      // donc c'est CE contrôle qui empêche un tenant de créer une campagne sous la marque d'un autre.
      rcsAgentBelongsToTenant: (agentId, tenant) => workflowRuntime.rcsStack.agents.belongsToTenant(agentId, tenant),
      listRcsAgents: (tenant) => workflowRuntime.rcsStack.agents.listForTenant(tenant),
      campaignBelongsTo: (id, tenant) => repo.campaignBelongsTo(id, tenant),
      // Campagne AU FIL DE L'EAU : le webhook doit appartenir à l'espace ET être actif. Même nature de garde
      // que pour le numéro Meta et l'agent RCS, sur la troisième porte d'entrée possible des destinataires.
      webhookUsableByTenant: (id, tenant) => webhookStore.usableByTenant(tenant, id),
      stopWebhookCampaign: (id, tenant) => repo.stopWebhookCampaign(id, tenant),
      // Arrêt d'urgence d'un envoi en cours, et son pendant : la reprise lève la pause avant d'enfiler le run.
      // Les deux vont ensemble, câbler l'un sans l'autre donne soit un bouton sans effet, soit une campagne
      // qu'on ne peut plus relancer.
      pauseCampaign: (id, tenant) => repo.pauseCampaign(id, tenant),
      resumeCampaign: (id, tenant) => repo.resumeCampaign(id, tenant),
      getRunSizing: (id) => repo.getRunSizing(id),
      scheduleCampaign: (id, tenant, when) => repo.scheduleCampaign(id, tenant, when),
      cancelSchedule: (id, tenant) => repo.cancelSchedule(id, tenant),
      getWorkflowGraph: async (wfId, tenant) => (await workflowStore.getById(wfId, tenant))?.graph ?? null,
      listCampaigns: (tenant, opts) => repo.listCampaignSummaries(tenant, opts),
      archiveCampaign: (id, tenant) => repo.archiveCampaign(id, tenant),
      unarchiveCampaign: (id, tenant) => repo.unarchiveCampaign(id, tenant),
      deleteDraftCampaign: (id, tenant) => repo.deleteDraftCampaign(id, tenant),
      getCampaignDetail: (id, tenant) => repo.getCampaignDetail(id, tenant),
      resetRecipientForRetry: (tenant, id, rid) => repo.resetRecipientForRetry(tenant, id, rid),
      listPhoneNumbers: (tenant) => repo.listPhoneNumbers(tenant),
      defaultRatePerMinute: config.CAMPAIGN_DEFAULT_RATE_PER_MINUTE,
    },
    // Redirection publique des liens tracés. Le tenant vient du code retrouvé en base, jamais de l'URL.
    links: {
      getByCode: (code) => trackedLinkStore.getByCode(code),
      recordClick: (code, tenant, contactId) => trackedLinkStore.recordClick(code, tenant, contactId),
      // QUI a clique (migration 0106). L espace vient du LIEN, jamais de l URL : un jeton d un autre client
      // ne doit pas s attribuer ce clic-ci.
      contactParJeton: (tenant, jeton) => trackedLinkStore.contactParJeton(tenant, jeton),
    },
    // Réception PUBLIQUE des webhooks entrants. L'appelant est un outil tiers : le tenant vient du code, et
    // l'écriture du contact passe par le MÊME chemin partagé que l'API publique et l'import CSV.
    webhookEntrant: {
      limiter: new RateLimiter(config.WEBHOOK_IN_RATE_LIMIT_MAX, config.WEBHOOK_IN_RATE_LIMIT_WINDOW_MS),
      getByCode: (code) => webhookStore.getByCode(code),
      recordCall: (tenant, id, payload, cree) => webhookStore.recordCall(tenant, id, payload, cree),
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
      list: (tenant) => webhookStore.list(tenant),
      get: (tenant, id) => webhookStore.get(tenant, id),
      create: (tenant, input) => webhookStore.create(tenant, input),
      update: (tenant, id, input) => webhookStore.update(tenant, id, input),
      remove: (tenant, id) => webhookStore.remove(tenant, id),
      rotateSecret: (tenant, id) => webhookStore.rotateSecret(tenant, id),
      clearSecret: (tenant, id) => webhookStore.clearSecret(tenant, id),
      forgetPayload: (tenant, id) => webhookStore.forgetPayload(tenant, id),
      workflowBelongsToTenant: async (wfId, tenant) => (await workflowStore.getById(wfId, tenant)) !== null,
      campagneVivante: (tenant, id) => repo.webhookFeedsLiveCampaign(tenant, id),
      baseUrl: adressesApi.avecPrefixe,
    },
    templates: {
      templatesFor: (tenant) => metaFactory.templateClientForTenant(tenant), // token PAR TENANT (B1), repli global en sommeil
      getWabaId: (tenant) => repo.getTenantWabaId(tenant),
      getPublishedFlow: (tenant, flowId) => flowStore.isPublished(flowId, tenant),
      listActiveCampaignsForTemplate: (tenant, name, language) => repo.listActiveCampaignsForTemplate(tenant, name, language),
      saveParamHints: (tenant, name, language, hints) => templateHintStore.save(tenant, name, language, hints),
      getParamHints: (tenant, name, language) => templateHintStore.get(tenant, name, language),
      removeParamHints: (tenant, name) => templateHintStore.removeByName(tenant, name),
      // Traçage des liens : l'adresse publique est celle qui part DANS LES MESSAGES. Elle vient de
      // `adressesPubliques` et non plus d'`APP_URL` en direct, parce que le front et l'API se séparent :
      // cette adresse-là doit suivre l'API, pas la console.
      tracking: {
        allocate: (tenant, cible, destination, avecJeton) => trackedLinkStore.allocate(tenant, newTrackingCode(), cible, destination, avecJeton),
        confirm: (tenant, codes) => trackedLinkStore.confirm(tenant, codes),
        // 🔴 Le lien SOUMIS porte desormais son suffixe variable : c est lui qui fera voyager le jeton du
        // destinataire, donc qui permettra de savoir QUI a clique. Les templates deja approuves gardent
        // l ancienne forme, leur URL etant figee chez Meta.
        lienDe: (code, avecJeton) => (avecJeton ? lienTraceAvecJeton(adressesApi.racine, code) : lienDe(adressesApi.racine, code)),
        // `adresse de redirection -> destination d'origine` : c'est ce qui permet de remontrer à
        // l'utilisateur le lien qu'il a saisi, partout où la console liste des templates.
        // ⚠️ Les DEUX formes sont dans la map, et il le faut : les templates approuves AVANT le 2026-09-02
        // portent l adresse nue, ceux d apres portent le suffixe variable. N en mettre qu une ferait
        // reapparaitre notre URL de redirection a la place du lien saisi, sur toute une famille de
        // templates, dans les quatre ecrans qui les listent.
        destinations: async (tenant, noms) => new Map(
          (await trackedLinkStore.listByTemplates(tenant, noms)).flatMap((l) => [
            [lienDe(adressesApi.racine, l.code), l.destination] as [string, string],
            [lienTraceAvecJeton(adressesApi.racine, l.code), l.destination] as [string, string],
          ]),
        ),
      },
    },
    inbox: {
      listConversations: (tenant, opts) => inboxStore.listConversations(tenant, opts),
      // Effacer le CONTENU d une conversation. Reserve aux administrateurs par la garde de `server.ts`, et
      // trace au Journal des actions (sans le numero ni le texte : y ecrire ce qu on vient d effacer
      // annulerait l effacement).
      effacerMessages: (tenant, id) => inboxStore.effacerMessages(tenant, id),
      audit: auditSink,
      countATraiter: (tenant) => inboxStore.countATraiter(tenant),
      // Les cinq compteurs du menu de dossiers, plus la charge par membre, en une lecture.
      compterConversations: (tenant) => inboxStore.compterConversations(tenant),
      archiverConversation: (tenant, id, archive) => inboxStore.archiverConversation(tenant, id, archive),
      signalerConversation: (tenant, id, signale, par) => inboxStore.signalerConversation(tenant, id, signale, par),
      /**
       * ⚠️ LA CLE MAISON PAIE LA TRANSCRIPTION, decision de Julien du 2026-09-09 : « on va le payer
       * nous-memes sur la cle API generale, et on verra apres si je la refacture au client ». Le resolveur
       * par espace existe deja (`clesGateway.lire`) : le jour ou ca change, c'est cette ligne, et elle seule.
       */
      ...(config.AI_GATEWAY_API_KEY && config.TRANSCRIPTION_MODELE ? {
        transcrireMessage: (tenant: string, messageId: string, conversationId?: string) => transcrireMessage({
          lireMessage: (t, m2, c2) => inboxStore.lireMessagePourTranscription(t, m2, c2),
          ecrireTranscription: (t, m2, texte, modele) => inboxStore.ecrireTranscription(t, m2, texte, modele),
          telecharger: (mediaId, max) => mediaClient.telechargerEntrant(mediaId, max),
          // ⚠️ Le transport du MODÈLE (120 s), pas le transport général (30 s) : un fichier de 2 Mo part en
          // base64, donc 2,7 Mo à téléverser, et un modèle a le droit d'être lent là où Meta n'en a pas le
          // droit. Le défaut aurait coupé les transcriptions les plus longues, celles qui servent le plus.
          transport: new FetchTransport(HTTP_TIMEOUT_MODELE_MS),
          cle: config.AI_GATEWAY_API_KEY,
          modele: config.TRANSCRIPTION_MODELE,
          tailleMaxOctets: config.TRANSCRIPTION_TAILLE_MAX_KO * 1024,
          noterCout: (t, m2, cout, secondes) => {
            app.log.info({ tenant: t, messageId: m2, coutDollars: cout, secondes }, 'transcription_cout');
          },
        }, tenant, messageId, conversationId),
        /**
         * ⚠️ MÊME plafond de taille que la transcription, et pour la même raison : le fichier entre entier en
         * mémoire du serveur avant de partir vers le navigateur. Sans borne, un média inattendu ferait
         * grossir le processus au lieu d'échouer proprement.
         */
        lireMediaMessage: async (tenant: string, messageId: string, conversationId?: string) => {
          const msg = await inboxStore.lireMessagePourTranscription(tenant, messageId, conversationId);
          if (!msg?.mediaId) return null;
          const f = await mediaClient.telechargerEntrant(msg.mediaId, config.TRANSCRIPTION_TAILLE_MAX_KO * 1024);
          // Le mime du MESSAGE d'abord : c'est celui que WhatsApp a annoncé, et Meta ne le rend pas toujours.
          return { bytes: f.bytes, mime: msg.mediaMime ?? f.mime };
        },
      } : {}),
      getAssignee: (tenant, id) => inboxStore.getAssignee(tenant, id),
      setAssignee: (tenant, id, assignee, par) => inboxStore.setAssignee(tenant, id, assignee, par),
      getConversationContext: (id, tenant) => inboxStore.getConversationContext(id, tenant),
      getMessages: (id) => inboxStore.getMessages(id),
      recordOutbound: (id, body, msgId, origine, type, cat, name, sender, canal) => inboxStore.recordOutbound(id, body, msgId, origine, type, cat, name, sender, canal),
      /**
       * Variables d'un template résolues sur la fiche du contact ouvert, avec le libellé du champ qui les
       * alimente. MÊME résolution que l'envoi réel (`resolveHintParams` + les indices posés à la création du
       * template) : l'écran montre donc exactement ce qui partira, pas une approximation.
       */
      resolveTemplateParams: async (tenant, waId, tpl) => {
        const hints = await templateHintStore.get(tenant, tpl.name, tpl.language);
        const contact = await contactStore.getResolvableByPhone(tenant, waId);
        const { values } = resolveHintParams(hints, tpl.count, contact ?? {}, { now: new Date() });
        // Le libellé dit D'OÙ vient la valeur. Sans lui, une variable pré-remplie « Julien » ne se distingue
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
       * Envoi d'un message RCS depuis l'inbox. Le message vient de la bibliothèque et ses variables sont
       * résolues sur la fiche du contact, exactement comme dans une campagne : c'est le MÊME chemin d'envoi
       * (`rcsStack.sender`), donc les mêmes garde-fous (opt-out, élagage des boutons, normalisation des
       * charges utiles) sans en réécrire un seul.
       *
       * Chaque refus porte sa RAISON, destinée à l'opérateur qui a le doigt sur le bouton : « le canal RCS
       * n'est pas activé » et « ce contact s'est désabonné » demandent deux gestes différents.
       */
      sendRcsFromInbox: async (tenant, waId, contenu) => {
        const agentId = await workflowRuntime.rcsStack.agents.agentIdForTenant(tenant);
        if (!agentId) return { refus: "Le canal RCS n'est pas activé sur cet espace (page d'accueil, sous le numéro WhatsApp)." };
        // Réponse LIBRE : rien à relire en bibliothèque, et rien à substituer non plus. L'opérateur a écrit ce
        // qu'il voulait dire ; y chercher des {{champ}} transformerait une accolade tapée par erreur en trou.
        let brut: RcsOutbound;
        if ('text' in contenu) {
          brut = { kind: 'text', text: contenu.text };
        } else {
          const enregistre = await rcsMessageStore.getById(tenant, contenu.rcsMessageId);
          if (!enregistre?.content) return { refus: 'Ce message RCS n’existe plus, ou son format n’est plus reconnu.' };
          brut = enregistre.content;
        }
        const message = 'text' in contenu
          ? brut
          : aDesVariables(brut)
            ? appliquerVariables(brut, contactVars(await contactStore.getResolvableByPhone(tenant, waId) ?? {}))
            : brut;
        // QUI a cliqué : le jeton du contact ouvert, écrit dans les liens tracés du message. Lu SEULEMENT si
        // le message porte un lien, et jamais bloquant : sans jeton, le lien part tracé mais anonyme.
        const jeton = aDesLiensTracables(message)
          ? (await trackedLinkStore.jetonPourE164(tenant, waId, fabriquerJeton).catch(() => null)) ?? undefined
          : undefined;
        const issue = await workflowRuntime.rcsStack.sender.sendTo(tenant, agentId, waId, message, randomUUID(), jeton);
        if ('skipped' in issue) {
          return {
            refus: issue.skipped === 'rcs_optout'
              ? 'Ce contact s’est désabonné du RCS (il a répondu STOP). Passez par WhatsApp.'
              : 'Ce contact n’est pas joignable en RCS.',
          };
        }
        return { messageId: issue.messageId, apercu: apercuRcsSortant(message) };
      },
      // Un opérateur qui écrit prend le fil : le scénario cesse d'avancer TOUT SEUL sur ce contact et MBA cesse de répondre.
      // 🔴 CE N'EST PLUS UNE HYPOTHÈSE, C'EST MESURÉ (2026-09-10). Meta n'a AUCUNE action `take` : la spec
      // v1.0.0 n'expose que `pass` et `release`. On prend donc le fil en ENVOYANT, et c'est ce qu'on a
      // observé pour de vrai ce jour-là : après une réponse depuis l'Inbox pendant que l'agent de Meta
      // tenait le fil, l'entrant suivant est arrivé en `field: "messages"` et non plus en `standby`.
      // ⚠️ Une CAMPAGNE, elle, part quand même : elle est déclenchée par un opérateur, donc c'est un humain qui a la main, et elle REPREND la conduite du fil (`ignoreHumanControl`). Le contraire a été écrit ici pendant des semaines, cf. `tests/campagne-controle-humain.test.ts`.
      takeControl: async (tenant, waId) => { await inboxStore.setControlOwner(tenant, waId, 'app_human'); },
      getControlOwner: (tenant, waId) => inboxStore.getControlOwner(tenant, waId),
      /**
       * L'opérateur rend la main : au scénario, ou à l'agent de Meta quand le client l'a allumé.
       *
       * 🔴 CE PRÉ-CÂBLAGE EST RESTÉ À MOITIÉ FAIT UN JOUR DE TROP. Il écrivait notre état local et
       * n'appelait JAMAIS Meta ; son propre commentaire annonçait l'appel « le jour venu ». Le jour venu
       * était le 2026-09-10, et le symptôme a été exactement celui qu'on pouvait prédire : Julien rend la
       * main, écrit sur WhatsApp, et l'agent de Meta reste muet parce que Meta croit toujours que NOUS
       * tenons le fil (son entrant suivant est arrivé en `field: "messages"`, pas en `standby`).
       *
       * ⚠️ META D'ABORD, NOTRE ÉTAT ENSUITE, ET SEULEMENT S'IL A CONFIRMÉ. L'ordre inverse est précisément
       * ce qui vient de coûter la soirée : un état local qui annonce ce que Meta n'a pas fait est pire
       * qu'une erreur, parce qu'il rend le problème invisible. Un échec REMONTE à l'appelant, qui le
       * traduit en 4xx lisible plutôt qu'en 500 dont Cloudflare mange le corps.
       *
       * ⚠️ `mbaEnabled` est notre drapeau, il peut avoir dérivé de l'état réel chez Meta. C'est acceptable
       * ICI parce que la dérive est réparée automatiquement à chaque message entrant, à partir du `field`
       * du webhook (`processInbound`) : au pire on rend au scénario un fil que Meta donnerait au MBA, et
       * le premier message suivant remet les deux d'accord.
       */
      releaseControl: async (tenant, waId) => {
        /**
         * 🔴 UN SEUL BOUTON, DEUX GESTES OPPOSÉS, ET C'EST CE QUI A CASSÉ. L'écran affiche « Rendre la main »
         * quand un opérateur détient le fil, et « Reprendre la main » quand c'est l'agent de Meta : deux
         * libellés contraires pour le MÊME appel. Ça marchait tant que cette fonction ne faisait qu'écrire
         * `app_workflow` en local. Depuis qu'elle appelle Meta (2026-09-10), partir de `mba` revenait à
         * RENDRE le fil à celui qui l'a déjà : un bouton sans effet, sous un libellé qui promet l'inverse.
         *
         * ⚠️ ET ON NE PEUT PAS LE PRENDRE, il n'existe aucune action `take` chez Meta. Partir de `mba` ne
         * peut donc faire qu'une chose : rouvrir NOTRE côté (le scénario cesse d'être bloqué par la garde
         * `mayAct`), la reprise réelle se produisant au premier message envoyé. C'est exactement ce que
         * faisait le code d'avant, et c'est correct : on le garde tel quel pour ce cas.
         */
        if ((await inboxStore.getControlOwner(tenant, waId)) === 'mba') {
          await inboxStore.setControlOwner(tenant, waId, 'app_workflow');
          return 'app_workflow';
        }
        const reglages = await settingsStore.get(tenant);
        if (!reglages.mbaEnabled) {
          await inboxStore.setControlOwner(tenant, waId, 'app_workflow');
          return 'app_workflow';
        }
        const rendu = await rendreLeFilAuMba(tenant, waId);
        if (!rendu) {
          // Aucun numéro connecté : il n'y a pas de fil à rendre chez Meta, et notre état local reste la
          // seule vérité. Ce n'est pas un échec, c'est un espace sans WhatsApp.
          await inboxStore.setControlOwner(tenant, waId, 'app_workflow');
          return 'app_workflow';
        }
        await inboxStore.setControlOwner(tenant, waId, 'mba');
        return 'mba';
      },
      /**
       * Lancement d'un SCÉNARIO depuis l'Inbox. La fenêtre décide de la porte d'entrée :
       *  - ouverte -> `startInWindow` : le scénario peut ouvrir par un message rapide ou un formulaire ;
       *  - fermée  -> `start` : la garde de fenêtre s'applique et REND la raison si le scénario ouvre par un
       *    message de session, ce que Meta refuserait (131047).
       *
       * `ignoreHumanControl` : c'est l'opérateur qui déclenche, et il détient presque toujours le fil (il l'a
       * pris en répondant). Le refuser à ce titre serait absurde. Même règle qu'au lancement d'une campagne.
       * `emitEvents` : un lancement à la main est unitaire (un contact, ici et maintenant), donc ses tags
       * publient, comme après une réponse du contact.
       */
      startWorkflow: async (tenant, workflowId, waId, windowOpen) => {
        const wf = await workflowStore.getById(workflowId, tenant);
        if (!wf) return null;
        const contactId = await contactStore.findIdByWaId(tenant, waId);
        const contact = { waId, contactId };
        // ⚠️ LA FERMETURE DU PARCOURS EN COURS N'EST PLUS ICI, elle est dans `runFrom` (l'exécuteur), et
        // c'est le point du lot du 2026-09-07 : elle vivait chez cet appelant-ci, donc sur un chemin sur
        // quatre, et les trois autres divergeaient. La garder en double la ferait s'exécuter deux fois (sans
        // dégât, mais elle laisserait croire qu'elle est propre à l'Inbox) et surtout elle réapparaîtrait
        // chez le prochain appelant qui la recopie. Le comportement pour l'opérateur est inchangé : son
        // scénario remplace toujours celui en cours.
        const opts = { emitEvents: true, ignoreHumanControl: true };
        return windowOpen
          ? workflowRuntime.executor.startInWindow(tenant, workflowId, wf.graph, contact, opts)
          : workflowRuntime.executor.start(tenant, workflowId, wf.graph, contact, undefined, opts);
      },
      countUnread: (tenant) => inboxStore.countUnread(tenant),
      markConversationRead: (tenant, conversationId) => inboxStore.markConversationRead(tenant, conversationId),
      getTenantPhoneNumberId: (tenant) => repo.getTenantPhoneNumberId(tenant),
      sendReply: async (tenant, phoneNumberId, to, text) => {
        const client = await metaFactory.clientForTenant(tenant, phoneNumberId); // token PAR TENANT (B1), repli global en sommeil
        return (await client.sendText(to, text)).messageId;
      },
      sendTemplateMessage: async (tenant, phoneNumberId, to, tpl) => {
        const client = await metaFactory.clientForTenant(tenant, phoneNumberId); // token PAR TENANT (B1), repli global en sommeil
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
       * Cartes d'un template CAROUSEL, relues chez Meta et visuels re-téléversés pour l'envoi. `null` si le
       * template n'est pas un carousel : l'envoi classique reste strictement inchangé.
       */
      prepareCarousel: async (tenant, name, language) => {
        // MÊME lecture que le worker (résolution nom+langue, repli sur le nom seul, cache court) : c'est
        // `templateVarInfo` de la fabrique partagée. L'API en avait sa propre copie, sans cache.
        const lu = (await workflowRuntime.templateVarInfo(tenant, name, language))?.carousel;
        if (!lu) return null;
        const cards = await workflowRuntime.prepareCarouselMedia(tenant, lu.cards);
        const refus = carouselSendBlocker(cards);
        return refus === null ? { cards } : { refus: `Carousel non envoyable : ${refus}` };
      },
    },
    // Canal ENTRANT depuis le connecteur HubSpot. Même secret partagé que le canal sortant (le connecteur
    // l'appelle SERVICE_SECRET), et même format de signature : on ne crée pas un troisième schéma.
    ...(config.HUBSPOT_SERVICE_SECRET ? {
      hubspotEvents: {
        secret: config.HUBSPOT_SERVICE_SECRET,
        findWaId: async (tenant: string, waId: string) => ((await contactStore.findIdByWaId(tenant, waId)) ? waId : null),
        publish: async (tenantId: string, event: { kind: 'hubspot_deal_stage'; waId: string; pipelineId: string; stageId: string }) => {
          await enfilerEvenementAutomation(queue, { tenantId, event } satisfies AutomationEventJob);
        },
      },
    } : {}),
    stats: {
      getDashboard: (tenant, range) => statsStore.getDashboard(tenant, range),
      getTemplateBreakdown: (tenant, range) => statsStore.getTemplateBreakdown(tenant, range),
      getPricing: async (tenant, range) => {
        const wabaId = await repo.getTenantWabaId(tenant);
        if (!wabaId) return null;
        const { startTs, endTs } = rangeToUnix(range);
        const pricing = await metaFactory.pricingClientForTenant(tenant); // token PAR TENANT (B1), repli global en sommeil
        return pricing.getPricingAnalytics(wabaId, startTs, endTs);
      },
      getCampaignFunnel: (tenant, campaignId) => statsStore.getCampaignFunnel(tenant, campaignId),
      getErrorBreakdown: (tenant, range, templateName) => statsStore.getErrorBreakdown(tenant, range, templateName),
      // Le MÊME journal que l'écran d'exploitation (`/parametres`), avec le code et la plage en filtre. Une
      // seconde requête propre à Analytics existait : elle comptait une population voisine, donc les deux
      // écrans, qui portent le même titre, se seraient contredits chez un client.
      getErrorContacts: (tenant, range, code, filter) => erreursLivraison.lister(tenant, {
        code,
        from: range.from,
        to: range.to,
        ...filter,
        // Une ligne de plus que le plafond : c'est ainsi que la route sait qu'elle tronque, et le dit.
        limit: PLAFOND_CONTACTS_ERREUR + 1,
      }),
      getCostSeries: async (tenant, range, filter) => {
        const [rows, rates] = await Promise.all([
          statsStore.getCostVolume(tenant, range, filter),
          tarifsMeta(tenant, range),
        ]);
        return estimateCostSeries(range.from, range.to, rows, rates);
      },
      /**
       * Le tableau « ce que coûte un engagement » de la page de synthèse (lot E).
       *
       * ⚠️ Les tarifs Meta viennent du MÊME appel que le graphe de coût (`tarifsMeta`) : deux façons de les
       * lire donneraient deux coûts sur deux écrans du même onglet, et le client comparerait. Le calcul,
       * lui, est pur (`estimateCoutParCampagne`) et vit à côté de celui de la série, avec ses règles.
       */
      getCoutParCampagne: async (tenant, range) => {
        const [volumes, rates] = await Promise.all([
          statsStore.getVolumeParCampagne(tenant, range),
          tarifsMeta(tenant, range),
        ]);
        const clics = await statsStore.clicsParCampagne(tenant, [...new Set(volumes.map((v) => v.campaignId))]);
        return estimateCoutParCampagne(volumes, rates, clics);
      },
      /**
       * La fiche d'UNE campagne, ouverte en cliquant sa ligne dans le tableau ci-dessus.
       *
       * 🔴 LES MÊMES TARIFS QUE LE TABLEAU, par le même `tarifsMeta`, et c'est ce qui empêche les deux
       * écrans de se contredire au moment précis où on les met côte à côte : le clic sur une ligne ouvre
       * cette fiche, et deux lectures de tarif différentes y afficheraient deux coûts pour la même campagne.
       *
       * ⚠️ LES TARIFS SONT CEUX DES 30 DERNIERS JOURS, alors que la fiche couvre toute la VIE de la
       * campagne. C'est une approximation ASSUMÉE et non un oubli : Meta rend un tarif PAR PÉRIODE, et
       * demander la période exacte de chaque campagne multiplierait les appels sans rien changer au chiffre
       * (les tarifs bougent de quelques centimes par an). La carte annonce déjà un coût ESTIMÉ qui n'est
       * pas une facture ; c'est la même réserve, pas une nouvelle.
       *
       * `null` -> 404 : la campagne n'est pas dans cet espace. La lecture de la fiche vient AVANT le reste,
       * pour ne pas payer trois requêtes sur un identifiant qui n'existe pas.
       */
      getDetailCoutCampagne: async (tenant, campaignId) => {
        const campagne = await statsStore.ficheCampagne(tenant, campaignId);
        if (campagne === null) return null;
        const [envois, rates, funnel, evenements] = await Promise.all([
          statsStore.envoisDeLaCampagne(tenant, campaignId),
          // Les 30 derniers jours, la fenêtre par défaut du tableau : c'est LUI qui sert de référence,
          // parce que c'est de lui qu'on ouvre cette fiche.
          tarifsMeta(tenant, { from: addDays(todayParis(), -29), to: todayParis() }),
          statsStore.getCampaignFunnel(tenant, campaignId),
          campagne.workflowId ? statsStore.mesuresScenarioParCampagne(tenant, campaignId) : Promise.resolve([]),
        ]);
        /**
         * Les clics de liens tracés, ATTRIBUÉS à cette campagne, fusionnés aux événements de blocs.
         *
         * ⚠️ MÊME MONTAGE que `getWorkflowNodeCounts` juste en dessous (graphe -> blocs template -> liens ->
         * `compteursDeClics`), et c'est délibéré : le node d'un clic ne se déduit que du GRAPHE, et deux
         * façons de faire ce chemin donneraient deux répartitions par bloc sur deux écrans.
         *
         * Best-effort, pour la même raison qu'à côté : une panne de cette lecture retire la colonne des
         * liens, elle ne doit pas emporter le coût ni les réponses, qui sont déjà là.
         */
        let clics: CompteurClic[] = [];
        let clicsAnonymes = 0;
        if (campagne.workflowId) {
          try {
            const wf = await workflowStore.getById(campagne.workflowId, tenant);
            const noeuds = noeudsTemplate(wf?.graph);
            if (noeuds.length > 0) {
              const liens = await trackedLinkStore.listByTemplates(tenant, noeuds.map((n) => n.templateName));
              if (liens.length > 0) {
                const compte = await trackedLinkStore.clicsAttribuesCampagne(tenant, campaignId, liens.map((l) => l.code));
                clics = compteursDeClics(noeuds, liens, compte.attribues);
                clicsAnonymes = compte.anonymes;
              }
            }
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error('clics attribues a la campagne ignores:', err instanceof Error ? err.message : err);
          }
        }
        return assemblerDetailCampagne({
          campagne, envois, rates, funnel, mesures: [...evenements, ...clics], clicsAnonymes,
        });
      },
      /**
       * Mesures d'un scénario : les événements de blocs, PLUS les clics sur les liens tracés des templates
       * qu'il envoie. Les seconds ne peuvent pas vivre dans `workflow_node_events` (elle exige un `wa_id`,
       * or un clic sur un lien statique n'identifie personne) : ils sont donc fusionnés à la LECTURE.
       *
       * Best-effort sur la partie liens : une panne ici retire la mesure de clic, elle ne doit pas emporter
       * les compteurs d'envoi et de lecture qui, eux, sont disponibles.
       */
      getWorkflowNodeCounts: async (tenant, workflowId, range) => {
        const evenements = await nodeEventStore.countByNode(tenant, workflowId, range);
        try {
          const wf = await workflowStore.getById(workflowId, tenant);
          const noeuds = noeudsTemplate(wf?.graph);
          // Les blocs RCS ont leurs propres liens, sur une AUTRE clé (l'adresse, migration 0107) et un autre
          // espace de noms de handle (`lien:i`). Les deux familles se lisent séparément puis se concatènent :
          // les mélanger dans une seule requête reviendrait à joindre deux tables sur rien.
          const liensRcs = liensRcsDesNoeuds(wf?.graph);
          if (noeuds.length === 0 && liensRcs.length === 0) return evenements;

          const codesRcs = liensRcs.length > 0
            ? await trackedLinkStore.codesRcsParDestination(tenant, liensRcs.map((l) => l.destination))
            : new Map<string, string>();
          const liens = noeuds.length > 0
            ? await trackedLinkStore.listByTemplates(tenant, noeuds.map((n) => n.templateName))
            : [];
          const tousLesCodes = [...liens.map((l) => l.code), ...codesRcs.values()];
          if (tousLesCodes.length === 0 && liensRcs.length === 0) return evenements;
          const clics = await trackedLinkStore.countClicks(tenant, tousLesCodes, range);
          return [
            ...evenements,
            ...compteursDeClics(noeuds, liens, clics),
            ...compteursDeClicsRcs(liensRcs, codesRcs, clics),
          ];
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('mesures de clics ignorées:', err instanceof Error ? err.message : err);
          return evenements;
        }
      },
      getConversationSummary: (tenant, range) => conversationStatsStore.getSummary(tenant, range),
      listAnalyzedConversations: (tenant, range, filters) => conversationStatsStore.listAnalyzed(tenant, range, filters),
      getNuageQualitatif: (tenant, range) => conversationStatsStore.getNuageQualitatif(tenant, range),
    },
    workflowReports: {
      listReports: (tenant) => reportStore.list(tenant),
      saveReport: (tenant, input) => reportStore.save(tenant, input),
      removeReport: (tenant, id) => reportStore.remove(tenant, id),
    },
    settings: {
      getSettings: (tenant) => settingsStore.get(tenant),
      // Canal RCS allumé dès qu'un agent est rattaché au tenant : l'interface suit l'état réel du dépôt.
      rcsEnabledFor: (tenant) => workflowRuntime.rcsStack.agents.hasAgent(tenant),
      setMbaEnabled: (tenant, enabled) => settingsStore.setMbaEnabled(tenant, enabled),
      setHubspotListsEnabled: (tenant, enabled) => settingsStore.setHubspotListsEnabled(tenant, enabled),
      setAutoRetryEnabled: (tenant, enabled) => settingsStore.setAutoRetryEnabled(tenant, enabled),
      setControlHandbackSeconds: (tenant, seconds) => settingsStore.setControlHandbackSeconds(tenant, seconds),
      setMbaHandoffMode: (tenant, mode) => settingsStore.setMbaHandoffMode(tenant, mode),
      // Applique le choix chez Meta immédiatement. Mêmes helpers que le balayage horaire, pour que « je viens
      // de choisir » et « l'heure a changé » écrivent exactement la même chose.
      applyMbaHandoffEnabled: (tenant, enabled) => ecrireHandoffEnabled(
        { clientFor: (t) => metaFactory.mbaClientForTenant(t), phoneNumberFor: (t) => repo.getTenantPhoneNumberId(t) },
        tenant,
        enabled,
      ),
      setTimezone: (tenant, tz) => settingsStore.setTimezone(tenant, tz),
      setBusinessHours: (tenant, hours) => settingsStore.setBusinessHours(tenant, hours),
    },
    // Import de listes HubSpot (3e source de campagne) : monté seulement si le canal service est configuré.
    ...(config.HUBSPOT_SERVICE_URL
      ? {
          hubspotImport: {
            // Accès listes = réglage utilisateur + flag pause (F3-b). La pause du toggle Synchronisation pose
            // campaigns_paused (même transaction que hubspot_paused_at), sans écraser hubspot_lists_enabled. La route compose.
            listsAccess: async (tenant: string) => {
              const s = await settingsStore.get(tenant);
              return { enabled: s.hubspotListsEnabled, paused: s.campaignsPaused };
            },
            fetchLists: (tenant: string, query?: string) => fetchHubspotLists({ baseUrl: config.HUBSPOT_SERVICE_URL, secret: config.HUBSPOT_SERVICE_SECRET, transport }, tenant, query),
            importList: (tenant: string, listId: string, listName: string) =>
              importHubspotList({ baseUrl: config.HUBSPOT_SERVICE_URL, secret: config.HUBSPOT_SERVICE_SECRET, transport }, { contacts: contactStore, userFields: fieldStore }, tenant, listId, listName),
          },
          // Étapes de deal : même canal service, mais AUCUN rapport avec le réglage « listes » (cf. la route).
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
      listUsers: (tenant) => userStore.list(tenant),
      setUserRole: (tenant, userId, role) => userStore.setRole(tenant, userId, role),
      setUserDisabled: (tenant, userId, disabled) => userStore.setDisabled(tenant, userId, disabled),
      deleteUser: (tenant, userId) => userStore.deleteUser(tenant, userId),
      createPendingUser: (tenant, email, role) => userStore.createPending(tenant, email, role),
      createInviteToken: (userId) => authTokenStore.create('invite', userId, config.INVITE_TOKEN_TTL_MS),
      // Personnalisation de l'email d'invitation : nom de l'invitant (repli email) + nom de l'espace.
      getInviterName: async (userId) => {
        const u = await userStore.getById(userId);
        return u ? (u.name ?? u.email) : null;
      },
      getWorkspaceName: (tenantId) => userStore.getTenantName(tenantId),
      appUrl: config.APP_URL,
      ...(sendAuthEmail ? { sendEmail: sendAuthEmail } : {}),
    },
    // Configuration de l'agent MBA depuis la console (admin-only). `phoneNumberBelongsToTenant` est le contrôle
    // d'isolation de la PLUPART de ces routes : la surface MBA est indexée par NUMÉRO chez Meta, pas par tenant.
    // ⚠️ `PUT /tenants/:id/mba-activation` fait EXCEPTION, et c'est sa raison d'être : elle résout le numéro
    // elle-même et s'isole par `scopeTenant`. Exiger le numéro de l'appelant est précisément ce qui a fait
    // sauter l'appel à Meta trois fois le 2026-09-10, la dernière parce que le navigateur ne l'avait pas encore.
    mba: {
      clientFor: (tenant) => metaFactory.mbaClientForTenant(tenant),
      phoneNumberBelongsToTenant: (pn, tenant) => repo.phoneNumberBelongsToTenant(pn, tenant),
      fetchUrl: fetchUrlBorne(),
      // 🔴 CE QUI REND LA ROUTE D'ACTIVATION POSSIBLE : le numéro se résout ICI, côté serveur. Le faire
      // côté navigateur est ce qui a produit trois pannes le 2026-09-10, la dernière parce que l'état du
      // compte n'était pas encore arrivé au moment du clic.
      numeroDuTenant: (tenant) => repo.getTenantPhoneNumberId(tenant),
      ecrireDrapeauMba: (tenant, enabled) => settingsStore.setMbaEnabled(tenant, enabled),
    },
    // Agents IA, en lecture : la palette du builder a besoin de la liste pour proposer le bloc.
    agents: {
      listActifs: (tenant) => agentStore.listActifs(tenant),
      listToutes: (tenant) => agentStore.listToutes(tenant),
      complet: (tenant, id) => agentStore.complet(tenant, id),
      create: (tenant, label, mention, modele) => agentStore.create(tenant, label, mention, modele),
      patch: (tenant, id, p) => agentStore.patch(tenant, id, p),
      remove: (tenant, id) => agentStore.remove(tenant, id),
      // Le modèle d'un agent NEUF vient de la configuration serveur, pas du client : il choisira ensuite
      // dans l'écran de réglage. Vide en l'absence de configuration, la colonne l'accepte.
      //
      // 🔴 `AGENT_MODEL` D'ABORD, et `LLM_MODEL` seulement en repli. Le second est le modèle de l'ANALYSE de
      // conversation, servi en DIRECT par Anthropic ; l'agent, lui, passe par le Gateway, dont les
      // identifiants sont préfixés par leur fournisseur. Créer un agent avec l'identifiant de l'analyse lui
      // donne un modèle que le Gateway ne connaît pas, et chaque tour échoue sans que la création n'ait rien
      // signalé.
      modeleParDefaut: config.AGENT_MODEL || config.LLM_MODEL,
      // LECTURE seule : le client voit ce qui lui reste, il ne se recharge pas lui-meme (cf. /ops).
      soldeAgent: (tenant) => credits.solde(tenant),
      // Absente quand le provisionnement est eteint : la creation d'agent se comporte alors comme avant.
      ...(provisionCle ? { assurerCleModele: (tenant: string) => assurerCleGateway(provisionCle, tenant) } : {}),
      consommationAgent: (tenant, agentId, jours) => agentSessions.consommation!(tenant, agentId, jours),
      // Le blocage dur avant activation : il lit la fiche, la connaissance, et les outils actifs AVEC leurs
      // handlers (le COMPTE seul ne peut pas dire QUEL outil manque, et c'est l'absence d'un outil PRECIS,
      // celui qui lit la base, qui a rendu un agent muet en production le 2026-09-08),
      // parce qu un agent active est proposable dans un scenario, donc il finira par ecrire a de vrais clients.
      etatPourLint: async (tenant, agentId) => {
        const fiche = await agentStore.complet(tenant, agentId);
        if (!fiche) return null;
        const [fiches, outils] = await Promise.all([
          knowledgeStore.lister(tenant, agentId),
          toolCatalog.listActifs(tenant, agentId),
        ]);
        return {
          fiche: fiche.contenu,
          fichesConnaissance: fiches.length,
          outilsActifs: outils.length,
          handlersActifs: outils.map(handlerMaison).filter((h) => h !== ''),
        };
      },
      /**
       * LES MODÈLES PROPOSABLES ET LEUR TARIF (2026-09-09).
       *
       * Deux sources, et une seule sort d'ici : la LISTE est la nôtre (`MODELES_CHOISIS`, choisie pour la
       * gestion des outils et pour le français), les PRIX viennent du Gateway en direct. Figer les prix dans
       * le code aurait garanti qu'ils soient faux au premier changement de tarif chez un fournisseur.
       *
       * ⚠️ La clé du Gateway ne quitte JAMAIS le serveur : la console reçoit des identifiants et des euros.
       */
      modelesProposes: () => catalogueModelesCache.lire('catalogue', () => lireCatalogueGateway(fetchGet, config.AI_GATEWAY_API_KEY))
        .then((catalogue) => modelesProposables(catalogue, config.EUR_PER_USD, config.COMMISSION_MODELE_PCT)),
    },
    // L assistant de construction. Il ne peut ecrire NI la mention legale d IA, NI les plafonds, NI le
    // modele, NI le risque ou l activation d un outil : il rend une proposition, le client l applique.
    agentSetup: {
      etatCourant: async (tenant, agentId) => {
        const fiche = await agentStore.complet(tenant, agentId);
        if (!fiche) return null;
        const [outils, fiches, sources] = await Promise.all([
          toolCatalog.listToutes(tenant, agentId),
          knowledgeStore.lister(tenant, agentId),
          // La BIBLIOTHEQUE de l espace : ce qui est declare, branche sur cet agent ou non. Sert a repondre
          // honnetement << vous avez declare votre ERP, il reste a y brancher l appel >> au lieu de
          // << rien n existe >> a un client qui vient justement de le declarer.
          agentSources.lister(tenant),
        ]);
        return {
          label: fiche.label,
          // Le régime d'annonce d'IA : l'entretien pose la question, le diff doit donc pouvoir dire ce qui change.
          mentionIaFrequence: fiche.mentionIaFrequence,
          fiche: fiche.contenu,
          // Les outils MAISON, par leur handler : c est par lui que l assistant les designe.
          outils: outils.filter((o) => o.origin === 'mba')
            .map((o) => ({ handler: String(o.binding.handler ?? ''), description: o.description, nePasUtiliser: o.nePasUtiliser })),
          // Les CONNECTEURS deja declares, par leur nom expose. L assistant peut en reecrire les MOTS, jamais
          // en creer : declarer une source, c est ecrire une adresse reseau et un secret.
          connecteurs: outils.filter((o) => o.origin !== 'mba')
            .map((o) => ({ nom: o.name, titre: o.title, description: o.description, nePasUtiliser: o.nePasUtiliser })),
          titresConnaissance: fiches.map((f) => f.titre),
          sources: sources.map((s) => ({ label: s.label, kind: s.kind, status: s.status })),
        };
      },
      // Les PIECES JOINTES ecrivent des fiches de connaissance, par le MEME store que l onglet Connaissance :
      // ce que le client joint est ensuite relisible et modifiable la-bas, comme une page importee.
      ecrireFichesDocument: (tenant, agentId, nom, fiches) =>
        knowledgeStore.remplacerSource(tenant, agentId, { type: 'document', nom }, fiches),
      // L entretien est TENU PAR LE SERVEUR : c est lui qui rend la conversation persistante entre deux
      // visites de l onglet, et surtout qui rend la sequence des questions deterministe (la couverture
      // cesse d etre une declaration du modele pour devenir un fait).
      entretiens: new PgEntretienStore(pool),
      ...(gateway ? { completer: (i: Parameters<GatewayChatClient['completer']>[0]) => gateway.completer(i) } : {}),
      modele: config.AGENT_SETUP_MODEL || config.LLM_MODEL,
      // Le modele de VISION est distinct : mesure du 2026-08-31, `zai/glm-4.7` (le modele d entretien de la
      // production) refuse une part image en 400. Vide -> les images sont refusees explicitement, les
      // documents continuent de passer.
      modeleVision: config.AGENT_VISION_MODEL,
    },
    // Le BAC A SABLE : parler a son agent depuis la console avant de l activer. Il fait tourner le VRAI
    // cerveau (vrai prompt, vrais outils exposes, VRAIE recherche de connaissance), mais les outils a EFFET
    // sont simules : il n y a ni contact, ni conversation, ni parcours, et poser un tag ecrirait sur une
    // vraie fiche du mini-CRM.
    agentTest: {
      // L HISTORIQUE des essais (14 j). Il ne conditionne rien : sans lui l essai marche comme avant et
      // l ecran n affiche aucune trace.
      essais: new PgTestRunStore(pool),
      // Le modele du bac a sable est celui de la FICHE de l agent, pas une variable d env : le seul
      // prerequis est donc la cle du Gateway. Le lier a LLM_MODEL rendrait /test indisponible le jour ou
      // l analyse de conversation serait desactivee, sans aucun rapport.
      disponible: gateway !== null,
      // 🔴 UN ESSAI CONSOMME POUR DE VRAI : les outils a effet sont simules, l appel de modele ne l est pas.
      // Meme solde, meme garde qu en production, sinon la console offrirait une porte gratuite et illimitee
      // sur un compte prepaye. Le mouvement n a pas de session (un essai n en ouvre aucune) : c est la note
      // qui l explique dans le journal.
      solde: (tenant) => credits.solde(tenant),
      debiter: async (tenant, montant, note) => { await credits.debiter(tenant, montant, { note }); },
      ...(gateway ? {
        cerveau: {
          completer: (i) => gateway.completer(i),
          // Point de lecture PARTAGE avec le tour de production : c est ce qui garantit que le bac a sable
          // montre exactement ce que la production ferait, modele et politiques compris.
          contexte: (tenant, agentId) => lireContexteAgent({ agents: agentStore, outils: toolCatalog }, tenant, agentId),
          // Meme taux qu en production : un essai doit annoncer ce que la conversation couterait vraiment.
          tauxEurParDollar: config.EUR_PER_USD,
          outils: {
            catalogue: toolCatalog,
            // Muet : `agent_tool_calls.session_id` reference une session, et le bac a sable n en ouvre aucune.
            journal: JOURNAL_MUET,
            // Le bac a sable recoit la MEME recherche que la production : il n'a de valeur que s'il rend
            // exactement ce qu'elle rendrait.
            resolveurs: { mba: creerResolveurSimulation({ connaissance: knowledgeStore, ...(rechercheSemantique ? { recherche: rechercheSemantique } : {}) }) },
            // Rien a compter : sans session, il n y a pas de compteur a incrementer. Le plafond d appels du
            // tour est tenu en memoire par la boucle du cerveau.
            compterAppel: async () => {},
          },
          alerter: (m: string) => console.error(`[agent] ${m}`),
        },
      } : {}),
    },
    // Base de connaissance d'un agent : la seule source que l'agent a le droit d'utiliser. `fetchUrl` porte
    // la garde SSRF (le serveur vit dans le reseau Docker du VPS) et le plafond de taille.
    agentKnowledge: {
      lister: (tenant, agentId) => knowledgeStore.lister(tenant, agentId),
      creer: (tenant, agentId, fiche) => knowledgeStore.creer(tenant, agentId, fiche),
      modifier: (tenant, agentId, ficheId, patch) => knowledgeStore.modifier(tenant, agentId, ficheId, patch),
      supprimer: (tenant, agentId, ficheId) => knowledgeStore.supprimer(tenant, agentId, ficheId),
      remplacerSource: (tenant, agentId, source, fiches) => knowledgeStore.remplacerSource(tenant, agentId, source, fiches),
      fetchUrl: fetchUrlBorne(),
    },
    // Outils d'un agent. L'activation et l'autonomie portent le nom de qui les a posees : la migration 0086
    // l'exige en base, et c'est ce qui rend un incident instruisable.
    agentTools: {
      listToutes: (tenant, agentId) => toolCatalog.listToutes(tenant, agentId),
      ajouter: (tenant, agentId, outil) => toolCatalog.ajouter(tenant, agentId, outil),
      // Lot L2 : un outil de connecteur, sur une source du tenant. La source est verifiee ICI (404) plutot
      // que par la cle etrangere, qui leverait en 500.
      ajouterConnecteur: (tenant, agentId, outil) => toolCatalog.ajouterConnecteur(tenant, agentId, outil),
      // La REQUETE est LUE, pas crue sur parole : le risque plancher et le resume de ce qui sera envoye en
      // derivent, et ils doivent decrire l appel REEL.
      requetePourOutil: (tenant, requeteId) => agentRequetes.parId(tenant, requeteId),
      patch: (tenant, agentId, id, p) => toolCatalog.patch(tenant, agentId, id, p),
      activer: (tenant, agentId, id, actif, par) => toolCatalog.activer(tenant, agentId, id, actif, par),
      autonomie: (tenant, agentId, id, autonome, par) => toolCatalog.autonomie(tenant, agentId, id, autonome, par),
      // DÉTACHE de cet agent, ne supprime plus la définition : elle appartient à l'espace (migration 0127).
      detacher: (tenant, agentId, id) => toolCatalog.detacher(tenant, agentId, id),
      rattacher: (tenant, agentId, id) => toolCatalog.rattacher(tenant, agentId, id),
      // Les regles d'arret viennent de la FICHE : c'est d'elles que derive l'enumeration de « terminer ».
      sortiesDeLAgent: async (tenant, agentId) => {
        const fiche = await agentStore.complet(tenant, agentId);
        return fiche ? fiche.contenu.sorties : null;
      },
    },
    // La BIBLIOTHEQUE d outils de l ESPACE (migration 0127) : les definitions, et qui s en sert. Separee des
    // routes d agent parce qu elle ne parle pas du meme objet, et isolee par `scopeTenant` et non par un
    // agent dans l URL : une definition appartient a l espace.
    agentCatalogue: {
      listCatalogue: (tenant) => toolCatalog.listCatalogue(tenant),
      supprimerDefinition: (tenant, id) => toolCatalog.supprimerDefinition(tenant, id),
      // Le numero est resolu ICI, cote serveur : le faire porter au navigateur est ce qui a casse le toggle
      // MBA trois fois le 2026-09-10.
      numeroDuTenant: (tenant) => repo.getTenantPhoneNumberId(tenant),
      rattacherConsommateur: (tenant, cle, id) => toolCatalog.rattacherConsommateur(tenant, cle, id),
      detacherConsommateur: (tenant, cle, id) => toolCatalog.detacherConsommateur(tenant, cle, id),
      activerConsommateur: (tenant, cle, id, actif, par) => toolCatalog.activerConsommateur(tenant, cle, id, actif, par),
    },
    /**
     * Publication du catalogue chez Meta (lot 4).
     *
     * 🔴 LE PLAN EST RECALCULE AU MOMENT D APPLIQUER, jamais transmis par le navigateur : le lui faire
     * porter ouvrirait une fenetre ou Meta a change entre l apercu et le clic.
     */
    mbaPublication: {
      numeroDuTenant: (tenant) => repo.getTenantPhoneNumberId(tenant),
      sources: async (tenant) => (await agentSources.lister(tenant))
        .filter((s) => s.kind === 'http' && s.status === 'active')
        .map((s) => ({
          id: s.id, label: s.label, baseUrl: s.baseUrl, authKind: s.authKind,
          authHeaderName: s.authHeaderName, aAuthentification: s.aAuthentification,
          secretPublie: s.secretPublie,
        })),
      /**
       * Les outils EXPOSES au MBA, avec leur methode et leur chemin.
       *
       * ⚠️ Un outil MAISON (`origin: 'mba'`) n a ni source ni requete : il n est pas publiable chez Meta,
       * qui ne sait appeler que du HTTP. On le filtre ICI plutot que de le laisser produire un geste qui
       * echouerait, ce qui arreterait toute la publication sur un cas parfaitement normal.
       */
      outilsExposes: async (tenant, pn) => {
        const actifs = await toolCatalog.listActifsConsommateur(tenant, consommateurMba(pn));
        const sortie = [];
        for (const o of actifs) {
          if (o.origin !== 'http' || !o.sourceId || !o.requestId) continue;
          const req = await agentRequetes.parId(tenant, o.requestId);
          if (!req) continue;
          sortie.push({
            id: o.id, sourceId: o.sourceId, name: o.name, description: o.description,
            nePasUtiliser: o.nePasUtiliser, methode: req.methode, chemin: req.chemin,
          });
        }
        return sortie;
      },
      etatMeta: async (tenant, pn) => {
        const client = await metaFactory.mbaClientForTenant(tenant);
        const connecteurs = await client.listConnectors(pn);
        const outilsParConnecteur: Record<string, Array<{ id: string; name: string; description?: string }>> = {};
        for (const c of connecteurs) outilsParConnecteur[c.id] = await client.listConnectorTools(pn, c.id);
        return { connecteurs, outilsParConnecteur };
      },
      appliquer: async (tenant, pn, geste, ctx) => {
        const client = await metaFactory.mbaClientForTenant(tenant);
        /**
         * ⚠️ DEUX LECTURES MEMORISEES POUR TOUTE LA PUBLICATION. Sans ce contexte, chaque geste relisait la
         * liste des connecteurs CHEZ META et les sources EN BASE : quarante lectures pour un plan de vingt
         * gestes, dont la moitie sur le reseau.
         *
         * 🔴 LE CACHE DES CONNECTEURS EST INVALIDE des qu on en cree ou supprime un, sinon le geste suivant
         * chercherait un connecteur dans une photo prise AVANT sa creation, et ne le trouverait pas.
         */
        const connecteurs = async (): Promise<Array<{ id: string; name: string }>> => {
          const vu = ctx.get('connecteurs');
          if (vu) return vu as Array<{ id: string; name: string }>;
          const frais = await client.listConnectors(pn);
          ctx.set('connecteurs', frais);
          return frais;
        };
        // Le connecteur se retrouve par son NOM au moment ou on en a besoin : `connecteur_creer` precede
        // toujours `outil_creer` dans le plan, donc il existe. Le porter dans le geste obligerait a le
        // deviner avant sa creation.
        const idDuConnecteur = async (nomSource: string): Promise<string | null> =>
          (await connecteurs()).find((c) => c.name === nomSource)?.id ?? null;
        const sourceParId = async (id: string) => {
          let liste = ctx.get('sources') as Awaited<ReturnType<typeof agentSources.lister>> | undefined;
          if (!liste) { liste = await agentSources.lister(tenant); ctx.set('sources', liste); }
          return liste.find((s) => s.id === id);
        };

        if (geste.type === 'connecteur_creer') {
          const s = await sourceParId(geste.sourceId);
          if (s) {
            await client.createConnector(pn, corpsConnecteurMeta(s));
            ctx.delete('connecteurs'); // il vient d apparaitre : la photo d avant ne le contient pas.
          }
          return;
        }
        if (geste.type === 'connecteur_modifier') {
          const s = await sourceParId(geste.sourceId);
          if (s) await client.updateConnector(pn, geste.connecteurId, corpsConnecteurMeta(s));
          return;
        }
        if (geste.type === 'connecteur_supprimer') {
          await client.deleteConnector(pn, geste.connecteurId);
          ctx.delete('connecteurs');
          return;
        }
        if (geste.type === 'secret_poser') {
          const s = await sourceParId(geste.sourceId);
          const secret = await agentSources.pourAppel(tenant, geste.sourceId);
          const cid = await idDuConnecteur(geste.nom);
          if (s && cid && secret?.authSecret) {
            await client.upsertApiKey(pn, cid, corpsApiKey(
              { authKind: s.authKind, authHeaderName: s.authHeaderName }, secret.authSecret,
            ));
            /**
             * 🔴 MARQUE APRES L ACCUSE DE RECEPTION DE META, jamais avant. Marquer d abord ferait croire un
             * secret publie alors que l appel a echoue, et la publication suivante ne le reposerait plus :
             * le connecteur de Meta resterait sur l ancien jeton pour toujours. Un `upsertApiKey` qui jette
             * remonte au POST, qui s arrete en 409 et dit de relancer.
             *
             * ⚠️ La photo des sources memorisee dans `ctx` devient perimee sur ce champ : elle ne sert plus
             * qu a lire l adresse et le mode d authentification pour les gestes SUIVANTS du meme plan, qui
             * ne relisent pas `secretPublie` (le plan, lui, a ete calcule avant).
             */
            await agentSources.marquerSecretPublie(tenant, geste.sourceId);
          }
          return;
        }
        if (geste.type === 'outil_creer' || geste.type === 'outil_modifier') {
          const s = await sourceParId(geste.sourceId);
          if (!s) return;
          const cid = await idDuConnecteur(s.label);
          if (!cid) return;
          const outils = await toolCatalog.listActifsConsommateur(tenant, consommateurMba(pn));
          const o = outils.find((x) => x.id === geste.outilId);
          if (!o || !o.requestId) return;
          const req = await agentRequetes.parId(tenant, o.requestId);
          if (!req) return;
          const corps = corpsOutilMeta({
            id: o.id, sourceId: s.id, name: o.name, description: o.description,
            nePasUtiliser: o.nePasUtiliser, methode: req.methode, chemin: req.chemin,
          });
          if (geste.type === 'outil_creer') await client.createConnectorTool(pn, cid, corps);
          else await client.updateConnectorTool(pn, cid, geste.outilMetaId, corps);
          return;
        }
        if (geste.type === 'outil_supprimer') {
          const cid = geste.sourceId === ''
            ? null
            : await idDuConnecteur((await sourceParId(geste.sourceId))?.label ?? '');
          // Un outil dont le connecteur part aussi : Meta l emporte avec lui, rien a faire ici.
          if (cid) await client.deleteConnectorTool(pn, cid, geste.outilMetaId);
        }
      },
    },
    // Les SOURCES externes d outils (lot L2) : l adresse de base du systeme du client, son mode d
    // authentification et son secret. Le secret est chiffre par le store, et aucune route ne le rend.
    agentSources: {
      lister: (tenant) => agentSources.lister(tenant),
      parId: (tenant, id) => agentSources.parId(tenant, id),
      creer: (tenant, input) => agentSources.creer(tenant, input),
      patch: (tenant, id, p) => agentSources.patch(tenant, id, p),
      supprimer: (tenant, id) => agentSources.supprimer(tenant, id),
      /**
       * EPROUVER une source : un appel reel, et le resultat ecrit sur la ligne.
       *
       * C est le seul moyen de voir un jeton mort AVANT qu un contact ne le decouvre : un jeton expire ne
       * produit aucune erreur applicative cote client, l agent degrade en silence au milieu d une
       * conversation. On passe par les MEMES gardes que le resolveur (`construireCible`), sinon l epreuve
       * validerait une adresse que l appel refusera.
       */
      eprouver: async (tenant, id, chemin) => {
        const src = await agentSources.pourAppel(tenant, id);
        if (!src) return { ok: false, erreur: 'source introuvable' };
        const cible = construireCible({ baseUrl: src.baseUrl, binding: { methode: 'GET', chemin }, args: {} });
        if (!cible.ok) return { ok: false, erreur: cible.raison };
        /**
         * 🔴 OU CE NOM MENE-T-IL VRAIMENT ? (contre-contre-rapport du 2026-09-03, et le constat etait juste.)
         *
         * `construireCible` lit le TEXTE de l hote : elle refuse `localhost` et les litteraux prives, et elle
         * ne peut RIEN contre `crm.exemple.fr` dont l enregistrement A pointe sur `169.254.169.254` (les
         * metadonnees du fournisseur) ou sur `172.18.x.x` (le reseau Docker du VPS, ou vivent l admin NPM et
         * tous les conteneurs du parc).
         *
         * ⚠️ Ce bouton etait le QUATRIEME chemin de ce genre, et le CLAUDE.md affirmait qu il n y en avait que
         * TROIS et qu ils etaient tous gardes. L inventaire etait faux, pas la regle. La lecon : un inventaire
         * de chemins sensibles ecrit a la main derive des qu on ajoute un bouton. Ce qui l a fait rater ici,
         * c est que les deux boutons « Test » se ressemblent beaucoup et que l AUTRE appelait bien la garde.
         * L inventaire est desormais tenu par un test (`tests/lib-adresse-privee.test.ts`).
         */
        const resolution = await resolutionPublique(cible.url);
        if (!resolution.ok) {
          await agentSources.marquerEpreuve(tenant, id, false, 'adresse non joignable');
          return { ok: false, erreur: 'cette adresse n est pas joignable depuis notre infrastructure' };
        }
        // MEME construction d en-tetes que l appel reel : une epreuve qui authentifierait autrement dirait
        // « ca repond » d une source que les appels ne savent pas authentifier.
        const headers = enTetesAuthSource(src);
        try {
          const res = await fetch(cible.url, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(10_000) });
          const auth = res.status === 401 || res.status === 403;
          const ok = res.ok;
          await agentSources.marquerEpreuve(tenant, id, ok, auth ? 'authentification refusee' : `HTTP ${res.status}`);
          return { ok, httpStatus: res.status, ...(ok ? {} : { erreur: auth ? 'authentification refusee' : `HTTP ${res.status}` }) };
        } catch {
          // Le message d exception n est PAS repasse : il peut porter l URL complete, donc parfois un jeton
          // en parametre de requete sur un systeme mal concu.
          await agentSources.marquerEpreuve(tenant, id, false, 'injoignable');
          return { ok: false, erreur: 'systeme injoignable' };
        }
      },
    },
    // Les REQUETES de connecteur (migration 0105) : un appel mis au point une fois dans la bibliotheque, que
    // l outil d un agent DESIGNE au lieu de le redecrire.
    agentRequetes: {
      lister: (tenant) => agentRequetes.lister(tenant),
      parId: (tenant, id) => agentRequetes.parId(tenant, id),
      creer: (tenant, input) => agentRequetes.creer(tenant, input),
      patch: (tenant, id, p) => agentRequetes.patch(tenant, id, p),
      supprimer: (tenant, id) => agentRequetes.supprimer(tenant, id),
      /**
       * Ce qu il faut pour EPROUVER une requete : l adresse de base et les en-tetes d authentification.
       *
       * ⚠️ `enTetesAuthSource` est le MEME point de passage que l appel reel. Un test qui authentifierait
       * autrement dirait « ca repond » d une source que les appels ne savent pas authentifier, ce qui est
       * exactement la divergence que l audit du 2026-08-18 a payee une centaine de fois.
       */
      sourcePourTest: async (tenant, sourceId) => {
        const src = await agentSources.pourAppel(tenant, sourceId);
        return src ? { baseUrl: src.baseUrl, entetes: enTetesAuthSource(src), status: src.status } : null;
      },
      // Les cles des champs DECLARES : une variable `champ` doit en designer une, sinon la faute de frappe ne
      // se verrait qu a l appel, en pleine conversation.
      clesDeChamps: async (tenant) => (await fieldStore.list(tenant)).map((f) => f.key),
    },
    flows: {
      flowsFor: (tenant) => metaFactory.flowClientForTenant(tenant), // token PAR TENANT (B1), repli global en sommeil
      getWabaId: (tenant) => repo.getTenantWabaId(tenant),
      insertFlow: (tenantId, id, name, screens, ref, mapping, cta) => flowStore.insert({ id, tenantId, name, screens, ref, mapping, ...(cta ? { cta } : {}) }),
      listFlows: (tenant) => flowStore.list(tenant),
      belongsTo: (flowId, tenant) => flowStore.belongsTo(flowId, tenant),
      markPublished: (flowId, tenant) => flowStore.markPublished(flowId, tenant),
      ensureUserField: async (tenant, label, type) => { await ensureField(fieldStore, tenant, label, type); },
      listUserFields: (tenant) => fieldStore.list(tenant),
      ensureOptinField: async (tenant) => { await ensureFieldByKey(fieldStore, tenant, WHATSAPP_OPTIN_FIELD_KEY, WHATSAPP_OPTIN_FIELD_LABEL, 'boolean'); },
      getFlow: (flowId, tenant) => flowStore.getById(flowId, tenant),
      updateFlowRow: (tenant, id, name, screens, ref, mapping, cta) => flowStore.update(id, tenant, { name, screens, ref, mapping, ...(cta ? { cta } : {}) }),
      removeFlowRow: (flowId, tenant) => flowStore.remove(flowId, tenant),
      insertExternalFlow: (tenant, f) => flowStore.insertExternal({ ...f, tenantId: tenant }),
      alignFlowFromMeta: (flowId, tenant, patch) => flowStore.alignFromMeta(flowId, tenant, patch),
    },
    media: { uploadImage: (bytes, mime) => mediaClient.uploadImage(bytes, mime) },
    tags: {
      listTags: (tenant) => tagStore.listDistinct(tenant),
      createTag: (tenant, name) => tagStore.create(tenant, name),
      renameTag: (tenant, from, to) => tagStore.rename(tenant, from, to),
      removeTag: (tenant, tag) => tagStore.remove(tenant, tag),
    },
    fields: {
      listFields: (tenant) => fieldStore.list(tenant),
      tenantCode: (tenant) => resolveTenantCode(pool, tenant),
      createField: (tenant, def) => fieldStore.create(tenant, def),
      updateField: (tenant, key, patch) => fieldStore.updateField(tenant, key, patch),
      deleteField: (tenant, key) => fieldStore.deleteField(tenant, key),
      fieldUsage: (tenant) => contactStore.fieldUsage(tenant),
    },
    contacts: {
      applyEdits: (tenant, id, edits) => contactStore.applyEdits(tenant, id, edits),
      applyEditsMany: (tenant, target, edits) => contactStore.applyEditsMany(tenant, target, edits),
      setBlocked: (tenant, id, bloque, par) => contactStore.setBlocked(tenant, id, bloque, par),
      listBlocked: (tenant) => contactStore.listBlocked(tenant),
      purgeMany: (tenant, ids) => contactStore.purgeMany(tenant, ids),
      contactIdsForTarget: (tenant, target) => contactStore.contactIdsForTarget(tenant, target),
      audit: auditSink,
      listAudit: (tenant, o) => auditStore.list(tenant, o),
      // Le journal des ERREURS de livraison. Separe du journal d actions : celui-ci porte les numeros (sans
      // eux il ne repond a rien), celui-la n en porte jamais (y ecrire un numero annulerait une purge).
      listErreursLivraison: (tenant, f) => erreursLivraison.lister(tenant, f),
      listUserFields: (tenant) => fieldStore.list(tenant),
      // Champ socle absent -> on le crée au premier usage (idempotent). Aucun chemin d'inscription ne les
      // créait, donc un espace neuf refusait « Prénom » alors que l'écran le propose.
      ensureSocleField: async (tenant, key, label, type) => { await ensureFieldByKey(fieldStore, tenant, key, label, type); },
      // Création à la main : MÊME upsert que l'API publique et l'import, avec le pays par défaut du tenant.
      createOneContact: async (tenant, input) => {
        const [r] = await upsertContactsFromApi(tenant, [input], { contacts: contactStore, fields: fieldStore, defaultCountry: config.DEFAULT_COUNTRY as CountryCode });
        return r ? { status: r.status, ...(r.contactId ? { contactId: r.contactId } : {}), ...(r.reason ? { reason: r.reason } : {}) } : { status: 'error', reason: 'aucun résultat' };
      },
      getContactHistory: (tenant, id) => contactHistoryStore.getContactHistory(tenant, id),
      listSendsForExport: (tenant, id) => contactHistoryStore.listSendsForExport(tenant, id),
      // Automations « tag ajouté » (E.2) : l'API ne sait pas démarrer un scénario (c'est le worker qui tient
      // l'exécuteur), elle publie donc un événement par tag posé. Un contact sans identité joignable (ni
      // numéro ni BSUID) n'a rien à déclencher.
      emitTagAdded: async (tenant, contactId, tags) => {
        const waId = await contactStore.waIdOfContact(tenant, contactId);
        if (!waId) return;
        for (const tag of tags) {
          await enfilerEvenementAutomation(queue, { tenantId: tenant, event: { kind: 'tag_added', waId, tag } } satisfies AutomationEventJob);
        }
      },
    },
    embeddedSignup: (() => {
      const esClient = new MetaEmbeddedSignupClient(config.META_APP_ID, config.META_APP_SECRET, config.META_GRAPH_VERSION);
      return {
        configId: config.META_ES_CONFIG_ID,
        appId: config.META_APP_ID,
        graphVersion: config.META_GRAPH_VERSION,
        exchangeCode: (code: string) => esClient.exchangeCode(code),
        getPhone: (pn: string, tok: string) => esClient.getPhone(pn, tok),
        subscribeApp: (waba: string, tok: string) => esClient.subscribeApp(waba, tok),
        register: (pn: string, tok: string, pin: string) => esClient.register(pn, tok, pin),
        verifyWaba: (waba: string, tok: string) => esClient.verifyWaba(waba, tok),
        // Repêchage quand la popup n'annonce pas les identifiants (parcours déjà abouti chez Meta).
        wabasForToken: (tok: string) => esClient.wabasForToken(tok),
        listPhones: (waba: string, tok: string) => esClient.listPhones(waba, tok),
        link: (input: { tenantId: string; wabaId: string; phoneNumberId: string; displayPhoneNumber: string | null; verifiedName: string | null }) => esCredentialsStore.linkTenant(input),
        // Chiffrement au repos ICI (la route ne voit jamais le stockage) : AES-GCM avec ENCRYPTION_KEY. Token ET pin
        // (PIN 2FA du numéro = secret Meta) chiffrés.
        saveCredentials: (waba: string, tenant: string, token: string, pin: string | null) =>
          esCredentialsStore.saveCredentials(waba, tenant, encryptSecret(token, config.ENCRYPTION_KEY), pin === null ? null : encryptSecret(pin, config.ENCRYPTION_KEY)),
      };
    })(),
    account: {
      getPhoneNumber: (tenant) => phoneStatusStore.getPhoneNumber(tenant),
      /**
       * La pastille du numéro (demande de Julien, 2026-09-08).
       *
       * 🔴 RELUE, JAMAIS STOCKÉE : l'URL que Meta rend est signée et expire. En base, elle donnerait une
       * image qui marche quelques heures puis casse, sans que personne ne sache pourquoi.
       *
       * ⚠️ DERRIÈRE UN MICRO-CACHE (`cacheCourt`, la brique du dépôt) : l'Accueil est la page la plus
       * ouverte de la console, et un appel Graph par affichage la ferait dépendre du temps de réponse de
       * Meta pour une décoration. Dix minutes sont très en deçà de la durée de vie de l'URL.
       */
      photoNumero: (tenant, phoneNumberId) => photoNumeroCache.lire(`${tenant}:${phoneNumberId}`, async () => {
        if (!config.META_ACCESS_TOKEN) return null;
        const client = await metaFactory.phoneClientForTenant(tenant);
        return client.photoDeProfil(phoneNumberId);
      }),
      pullStatus: async (phoneNumberId, tenant) => {
        if (!config.META_ACCESS_TOKEN) return null; // pas de token global -> pas de pull live (statut sur le dernier connu)
        try {
          const phoneClientT = await metaFactory.phoneClientForTenant(tenant); // token PAR TENANT (B1), repli global en sommeil
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
      saveStatus: (id, patch) => phoneStatusStore.saveStatus(id, patch),
      setHubspotConnected: (id, tenant, connected) => phoneStatusStore.setHubspotConnected(id, tenant, connected),
      // Rattrapage HubSpot (F3-a) : enfile un seul job hubspot-catchup (le worker liste les marques et re-pousse).
      // NO-OP si le pipeline analyse/push est inerte (mêmes conditions que le worker qui consomme la file).
      enqueueHubspotCatchup: async (tenant) => {
        if (!(config.CONVERSATION_ANALYSIS_ENABLED === 'true' && config.CONNECTOR_PUSH_URL !== '')) return;
        await queue.enqueue('hubspot-catchup', { tenantId: tenant });
      },
      getHubspotPortal: (tenant) => phoneStatusStore.getHubspotPortal(tenant),
      // Déconnexion complète (candidat 2) : appel service signé vers mm-hubspot (unlink + révocation token). Monté
      // seulement si le canal service est configuré (sinon la route répond 503, le front garde son bouton).
      ...(config.HUBSPOT_SERVICE_URL
        ? { disconnectHubspot: (tenant: string) => disconnectHubspot({ baseUrl: config.HUBSPOT_SERVICE_URL, secret: config.HUBSPOT_SERVICE_SECRET, transport }, tenant) }
        : {}),
      // Reflet local (toujours dispo) : coupe hubspot_connected de tous les numéros du tenant après succès connecteur.
      disconnectHubspotTenant: (tenant) => phoneStatusStore.disconnectHubspotTenant(tenant),
    },
    me: { getUser: (userId) => userStore.getById(userId) },
    workflows: {
      createWorkflow: (tenant, name, graph) => workflowStore.insert(tenant, name, graph),
      tenantCode: (tenant) => resolveTenantCode(pool, tenant),
      listWorkflows: (tenant) => workflowStore.list(tenant),
      // Le navigateur reçoit le RÉSUMÉ : plus aucun graphe ne traverse le réseau pour afficher des noms.
      listWorkflowsResume: (tenant) => workflowStore.listResume(tenant),
      getWorkflow: (id, tenant) => workflowStore.getById(id, tenant),
      updateWorkflow: (id, tenant, patch) => workflowStore.update(id, tenant, patch),
      // Bouton « Publier » (lot 7) : le SEUL chemin qui touche le graphe exécuté.
      publishWorkflow: (id, tenant) => workflowStore.publish(id, tenant),
      audit: auditSink,
      deleteWorkflow: (id, tenant) => workflowStore.remove(id, tenant),
      // Déclare les tags des blocs « ajout de tag » dans le référentiel (Contenus > Tags) à la sauvegarde.
      declareTags: async (tenant, tags) => { for (const t of tags) await tagStore.create(tenant, t); },
      // Lien de test (Lot F) : jeton stable posé au 1er clic, + numéro affiché pour construire le lien wa.me.
      ensureTestToken: (id, tenant, token) => workflowStore.ensureTestToken(id, tenant, token),
      getDisplayPhoneNumber: async (tenant) => (await phoneStatusStore.getPhoneNumber(tenant))?.displayPhoneNumber ?? null,
    },
    // Node « Envoi de mail » : boîtes SMTP + modèles (Contenu), et le résolveur qu'invalident les routes
    // d'écriture pour ne jamais garder un transport périmé (hôte/mot de passe changés).
    email: { accounts: emailAccounts, templates: emailTemplates, resolver: emailResolver },
    rcsChannel: {
      etat: (tenant) => workflowRuntime.rcsStack.agents.etatPour(tenant),
      verifier: (apiKey) => verifierCleRcs(fetchGet, apiKey),
      activer: async (tenant, canal, apiKey) => {
        // La clé est chiffrée ICI, jamais stockée en clair. `client_token_enc` reste réservé au jour où un
        // fournisseur signera ses rappels (Google le fait) ; smsmode, lui, ne signe pas.
        //
        // 🔴 Le `webhook_code` EST le secret de l'adresse de rappel : c'est lui, et lui seul, qui dit à quel
        // workspace appartient un appel non signé. Donc 128 bits, comme le code des webhooks entrants, et
        // jamais une valeur courte « puisque ce n'est qu'un identifiant ».
        await workflowRuntime.rcsStack.agents.activer(
          tenant,
          canal,
          encryptSecret(apiKey, config.ENCRYPTION_KEY),
          encryptSecret(randomBytes(24).toString('hex'), config.ENCRYPTION_KEY),
          `rcs-${randomBytes(16).toString('hex')}`,
        );
      },
      desactiver: (tenant) => workflowRuntime.rcsStack.agents.desactiver(tenant),
    },
    /**
     * Rappels smsmode : rapports de livraison et réponses des contacts. C'est ce qui referme la boucle du
     * canal RCS, qui jusqu'ici ne savait qu'émettre.
     *
     * Le tenant vient du CODE de l'URL (`parWebhookCode`), jamais du corps : smsmode ne signe pas ses rappels.
     */
    rcsCallback: {
      parCode: (code) => workflowRuntime.rcsStack.agents.parWebhookCode(code),
      noterRappel: (tenant, corps) => workflowRuntime.rcsStack.agents.noterRappel(tenant, corps),
      onDlr: async (tenant, dlr) => {
        // 1. Le destinataire de campagne, par identifiant de message. Même chemin que les accusés Meta : une
        //    seule échelle de statuts dans le produit, donc un seul écran de résultats à lire.
        if (dlr.status !== null) {
          await recipientStore.updateDeliveryByMessageId(dlr.messageId, dlr.status, dlr.detail, null);
          // 1 bis. La MESURE PAR BLOC (Analytics > Mes tableaux). Le chemin Meta le fait depuis toujours
          //    (webhooks/delivery.ts), pas celui-ci : un bloc RCS n'affichait donc jamais « délivré » ni
          //    « lu », alors que smsmode remonte bien DELIVERED et READ et que l'envoi RCS écrit bien son
          //    identifiant dans workflow_node_events. Best-effort, comme côté Meta : une mesure ne doit pas
          //    faire échouer le traitement d'un rapport de livraison.
          if (dlr.status !== 'sent') {
            try {
              await nodeEventStore.recordStatusForMessage(dlr.messageId, dlr.status);
            } catch (err) {
              // eslint-disable-next-line no-console
              console.error('mesure de bloc RCS (statut) ignorée:', err instanceof Error ? err.message : err);
            }
          }
        }
        // 2. Les DEUX sorties du bloc RCS. C'est ICI, et nulle part ailleurs, qu'elles s'allument : chez
        //    smsmode le sort d'un message ne se sait pas avant l'envoi, il se constate APRÈS, sur un rapport.
        //    Échec définitif -> repli WhatsApp. Remis -> la suite du parcours (sauf si le bloc attend encore
        //    un clic, cf. `rcsDelivered`).
        if (dlr.to !== '') {
          if (dlr.echecDefinitif) await workflowRuntime.executor.rcsUndeliverable(tenant, dlr.to, dlr.messageId);
          else if (dlr.status === 'delivered') await workflowRuntime.executor.rcsDelivered(tenant, dlr.to, dlr.messageId);
        }
      },
      onMo: async (tenant, mo) => {
        // Une position ou un fichier n'ont pas de texte : `apercuMo` en fabrique un LISIBLE plutôt que de
        // laisser une bulle vide et de jeter les coordonnées.
        const apercu = apercuMo(mo);
        // 1. STOP AVANT tout le reste. Continuer d'écrire après un refus fait suspendre l'agent par
        //    l'opérateur, et l'enregistrement de l'opt-out ne doit dépendre d'aucune étape qui pourrait
        //    échouer après lui.
        if (mo.kind === 'text' && estDemandeArret(mo.text)) {
          const marque = await workflowRuntime.rcsStack.optout.markOptedOut(tenant, mo.from);
          if (!marque) {
            // eslint-disable-next-line no-console
            console.error(`STOP RCS reçu de ${mo.from} (${tenant}) sans fiche contact : rien à désabonner`);
          }
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
        // 2 bis. La FICHE CONTACT et les AUTOMATIONS, que le chemin Meta branche depuis toujours et pas
        //    celui-ci. Un client qui écrivait DEVIS en RCS ne déclenchait rien, sans le moindre journal :
        //    l'opérateur croyait son automation cassée. C'est aussi ce qui produisait le « STOP RCS sans
        //    fiche contact » ci-dessus, faute de fiche créée à la première prise de contact.
        //
        //    ⚠️ Le canal part DANS l'événement. Sans lui, le runner conclurait que la fenêtre de service
        //    WhatsApp est ouverte (un entrant vaut preuve, côté Meta) et le scénario déclenché ouvrirait par un
        //    message rapide chez un contact hors fenêtre : refus Meta 131047.
        //
        //    Isolé : ni la fiche ni l'automation ne doivent faire échouer la réception d'un message.
        try {
          const issue = await contactStore.upsertFromInbound(tenant, mo.from, null);
          await enfilerEvenementAutomation(queue, {
            tenantId: tenant,
            event: { kind: 'message', waId: mo.from, body: mo.kind === 'text' ? mo.text : null, isNewContact: issue === 'created', channel: 'rcs' },
          } satisfies AutomationEventJob);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('automations RCS ignorées:', err instanceof Error ? err.message : err);
        }
        // 3. Le parcours. Un bouton tapé porte `btn:<i>` (cf. `normaliserPostbacks`) et choisit sa branche ;
        //    une réponse écrite suit la sortie « envoyé ». Isolé : un scénario qui casse ne doit pas faire
        //    rejouer six fois un rappel dont l'inbox et l'opt-out sont déjà enregistrés.
        try {
          await workflowRuntime.executor.advance(tenant, mo.from, mo.messageId, mo.postbackData, 'rcs');
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('avance de scénario sur réponse RCS ignorée:', err instanceof Error ? err.message : err);
        }
      },
    },
    /**
     * Visuels des messages RCS. Le téléversement rend directement l'URL PUBLIQUE : c'est tout l'intérêt,
     * l'opérateur télécom va chercher l'image lui-même et personne n'a à trouver où l'héberger.
     */
    rcsMedia: {
      list: (tenant) => rcsMediaStore.list(tenant),
      create: async (tenant, input) => {
        const code = newMediaCode();
        const media = await rcsMediaStore.create(tenant, { ...input, code });
        return { media, url: urlImageRcs(adressesApi.racine, code, input.mime) };
      },
      remove: (tenant, id) => rcsMediaStore.remove(tenant, id),
      getByCode: (code) => rcsMediaStore.getByCode(code),
    },
    rcsMessages: {
      list: (tenant) => rcsMessageStore.list(tenant),
      create: (tenant, name, content) => rcsMessageStore.create(tenant, name, content),
      update: (tenant, id, name, content) => rcsMessageStore.update(tenant, id, name, content),
      remove: (tenant, id) => rcsMessageStore.remove(tenant, id),
    },
    // Automations (Lot E) : déclencher un scénario sur un événement (mot-clé, nouveau contact, tag ajouté).
    automations: {
      list: (tenant) => automationStore.list(tenant),
      getById: (id, tenant) => automationStore.getById(id, tenant),
      create: (tenant, input) => automationStore.create(tenant, input),
      update: (id, tenant, patch) => automationStore.update(id, tenant, patch),
      remove: (id, tenant) => automationStore.remove(id, tenant),
      // Un tenant ne peut cibler QUE ses propres scénarios (même garde que la campagne workflow).
      workflowBelongsToTenant: async (wfId, tenant) => (await workflowStore.getById(wfId, tenant)) !== null,
    },
    // Chaine WhatsApp (Channels Me) : publier un post dont le bouton demarre un scenario.
    channelsMe: {
      getConnection: (tenant) => channelsMeConnections.get(tenant),
      getSecrets: (tenant) => channelsMeConnections.getSecrets(tenant),
      upsertConnection: (tenant, c) => channelsMeConnections.upsert(tenant, c),
      markVerified: (tenant) => channelsMeConnections.markVerified(tenant),
      getOrganisation: (cx) => channelsMeClient.getOrganisation(cx),
      listChannels: (cx) => channelsMeClient.listChannels(cx),
      getMessages: (cx) => channelsMeClient.getMessages(cx),
      // 🔴 `m` DOIT ETRE RELAYE ENTIER. Une fleche a un parametre est parfaitement assignable a un contrat
      // qui en declare deux : le second serait avale EN SILENCE, l'image du post disparaitrait sans que le
      // typecheck ne dise rien. Defaut deja paye en production le 2026-09-03.
      createMessage: (cx, m) => channelsMeClient.createMessage(cx, m),
      listLinks: (tenant) => channelsMeLinks.list(tenant),
      createLink: (tenant, l) => channelsMeLinks.create(tenant, l),
      linkById: (tenant, id) => channelsMeLinks.byId(tenant, id),
      // Rattrapage : defait l'automation compagnon quand `createLink` echoue juste apres l'avoir creee
      // (sinon elle reste POSSEDEE, orpheline, invisible et inaccessible depuis l'ecran Automation).
      supprimerAutomationCompagnon: (tenant, automationId) => channelsMeLinks.supprimerAutomationCompagnon(tenant, automationId),
      conversationsParLien: (tenant) => channelsMeLinks.conversationsParLien(tenant),
      listPosts: (tenant) => channelsMePosts.list(tenant),
      createPost: (tenant, p) => channelsMePosts.create(tenant, p),
      // L'automation compagnon du lien. Trois choses se decident ICI et nulle part ailleurs :
      //  - `enabled: false`, parce qu'un lien cree mais jamais publie ne doit rien declencher ;
      //  - `possedePar`, qui met la ligne hors de portee de l'ecran Automation (predicat du store) ;
      //  - `mode: 'contains'`, qui laisse passer un abonne ayant ajoute un mot devant ou derriere la phrase.
      // 🔴 LA MEME NORMALISATION QUE LA CORRESPONDANCE. `normalizeText` est celle qu'applique
      // `matchesTrigger` au corps du message et `keywordsOf` au mot-cle stocke : deux liens que cette
      // fonction rend egaux matcheraient le meme message, donc c'est exactement elle qui doit trancher
      // l'unicite. Une comparaison SQL approchee laisserait passer « Ça m'intéresse » et « ca m interesse ».
      phraseEnConflit: async (tenant, phrase) => {
        const cible = normalizeText(phrase);
        const existantes = await channelsMeLinks.phrasesDesLiens(tenant);
        // 🔴 L'INCLUSION, DANS LES DEUX SENS, PAS L'EGALITE. La comparaison est en mode `contains` : « Je
        // veux le guide » et « Je veux le guide 2026 » sont deux phrases DIFFERENTES, et pourtant un abonne
        // qui appuie sur le second bouton envoie un texte qui contient AUSSI la premiere. Les deux
        // automations matchent, les deux scenarios demarrent, et le second clot le premier : l'abonne voit
        // un parcours commencer puis disparaitre. Sur un post deja publie, c'est sans recours.
        // Ce cas n'existait pas avec le jeton : deux jetons tires ne s'incluent jamais.
        return existantes.some((p) => {
          const n = normalizeText(p);
          return n.includes(cible) || cible.includes(n);
        });
      },
      messagesContenantLaPhrase: (tenant, phrase) => channelsMeLinks.messagesContenantLaPhrase(tenant, phrase),
      creerAutomationCompagnon: (tenant, input) => automationStore.create(tenant, {
        name: input.nom,
        triggerKind: 'keyword',
        // 🔴 `contains` EST CE QUI SAUVE LES POSTS DEJA PUBLIES. Le mot-cle est la PHRASE depuis le
        // 2026-09-07 ; un post distribue avant cette date envoie `phrase (cm-xxxx)`, qui la CONTIENT, donc
        // son bouton continue de declencher. En mode `equals`, tous les posts en circulation seraient morts,
        // sans aucun recours possible.
        triggerConfig: { keywords: [input.motCle], mode: 'contains' },
        conditionGroup: null,
        workflowId: input.workflowId,
        startNodeId: input.startNodeId,
        cooldownSeconds: input.cooldownSeconds,
        enabled: false,
        possedePar: 'channelsme_link',
        maxFiresPerHour: input.maxParHeure,
      }),
      // 🔴 PAR LE STORE DES LIENS, JAMAIS PAR `PgAutomationStore`. Ce dernier exclut de `update`/`remove`
      // toute ligne `possede_par is not null` : ces deux methodes ecrivent leur PROPRE requete sur
      // `automations`, garde miroir `possede_par = 'channelsme_link'` comprise.
      allumerAutomationLien: (tenant, linkId) => channelsMeLinks.allumerAutomation(tenant, linkId),
      eteindreAutomationLien: (tenant, linkId) => channelsMeLinks.eteindreAutomation(tenant, linkId),
      scenarioEtat: async (tenant, wfId) => {
        const wf = await workflowStore.getById(wfId, tenant);
        if (!wf) return 'inconnu';
        // « Aucune version publiee » se lit sur le graphe PUBLIE, le seul que l'executeur lise : un scenario
        // dont il est vide ne demarrerait rien, meme si un brouillon existe a cote.
        return wf.graph.nodes.length > 0 ? 'ok' : 'vide';
      },
      getDisplayPhoneNumber: async (tenant) => (await phoneStatusStore.getPhoneNumber(tenant))?.displayPhoneNumber ?? null,
      // Notification best-effort : `sendTelegram` ne leve jamais et est un no-op si Telegram n'est pas
      // configure. Le jeton d'un lien n'apparait nulle part dans ce message.
      demanderActivation: async ({ tenantId, userId, message }) => {
        await sendTelegram(`[engage-me] demande d’activation Channels Me\nespace ${tenantId}\nutilisateur ${userId ?? 'inconnu'}\n${message.slice(0, 500)}`);
      },
    },
    ops: {
      getTenantOverview: () => opsStore.getTenantOverview(),
      getGlobalDaily: (days) => opsStore.getGlobalDaily(days),
      getQueueLoad: () => opsStore.getQueueLoad(),
      // L'équité : quels GROUPES attendent le plus. Vide = tout le monde est servi.
      getQueueLoadParGroupe: () => opsStore.getQueueLoadParGroupe(),
      getQueueLatence: (h) => opsStore.getQueueLatence(h),
      // Les jobs MORTS et leur rejeu. Deuxième écriture métier de la surface d'exploitation, assumée pour la
      // même raison que le rechargement de solde : rejouer un traitement mort est un geste d'exploitation,
      // cross-espace, qui suppose qu'on ait corrigé la cause de l'échec.
      listerJobsMorts: (limite) => opsStore.listerJobsMorts(limite),
      reenfiler: (nomDeFile, data) => queue.enqueue(nomDeFile, data),
      oublierJobsMorts: (ids) => opsStore.oublierJobsMorts(ids),
      getWorkerHeartbeat: () => heartbeatStore.get(),
      /**
       * L'attente du pool (lot 7). Deux lectures qui ne se remplacent pas : l'état INSTANTANÉ ne peut être
       * que celui de CE process (l'API voit son propre pool en mémoire), et la COURBE vient de la base, seul
       * canal par lequel le worker peut se montrer.
       *
       * ⚠️ `waitingCount` non nul est le vrai signal : ce n'est pas « à combien du plafond on est » qui
       * compte, c'est « quelqu'un attend-il ».
       */
      etatPoolInstantane: () => ({
        process: 'api',
        total: pool.totalCount,
        libres: pool.idleCount,
        enAttente: pool.waitingCount,
        max: config.DB_POOL_MAX,
        maxMsDepuisDemarrage: Math.round(mesureAttentePool.maxDepuisDemarrage),
      }),
      lireAttentesPool: (minutes) => poolAttentesStore.lireDernieresMinutes(minutes),
      // Le solde prepaye d un workspace pour l agent IA. La RECHARGE est la seule ecriture metier de cette
      // surface, et elle est ici parce qu un client ne doit jamais pouvoir crediter son propre compte.
      //
      // ⚠️ L espace est RESOLU d abord, dans les deux sens. En lecture, un espace inconnu rendrait un solde de
      // zero, que l operateur lirait comme « client a sec » et rechargerait. En ecriture, la cle etrangere
      // leverait, donc un 500 remplace par la page d erreur de Cloudflare, sur la seule route qui ecrit de l
      // argent. `getTenantName` est le meme point de resolution que `/ops/observe`.
      soldeAgent: async (tenantId) => {
        if ((await opsStore.getTenantName(tenantId)) === null) return null;
        return {
          soldeMicroEur: await credits.solde(tenantId),
          mouvements: await credits.mouvements(tenantId, 50),
        };
      },
      // ⚠️ Le jour où un espace se supprimera, CECI passe AVANT : sinon le `on delete cascade` emporte notre
      // ligne et la clé survit chez Vercel, identifiant perdu, donc facturable et irrévocable.
      ...(provisionCle ? { revoquerCleModele: (tenantId: string) => revoquerCleGateway(provisionCle, tenantId) } : {}),
      rechargerAgent: async (tenantId, montant, note) => {
        if ((await opsStore.getTenantName(tenantId)) === null) return null;
        const solde = await credits.crediter(tenantId, montant, note);
        // 🔴 LE PLAFOND DE LA CLE SUIT LE RECHARGEMENT, sinon le client paie et reste bloque : son credit
        // monte chez nous, et le Gateway continue de le couper au plafond d avant. C est le seul endroit ou
        // du credit est AJOUTE, donc le seul endroit ou ce rattrapage a lieu d etre.
        // ⚠️ Ne leve pas et n annule rien : le rechargement est deja ecrit, et un tiers indisponible ne doit
        // pas faire echouer un paiement. Le plafond rattrapera au mouvement suivant.
        if (provisionCle) {
          await remonterPlafondApresRecharge(provisionCle, tenantId, montant, (msg, err) => {
            app.log.error({ err, tenantId }, msg);
          });
        }
        return solde;
      },
      /**
       * Session d'OBSERVATION d'un espace client : un jeton de session en LECTURE SEULE.
       *
       * `userId` porte une valeur PARLANTE et non un identifiant d'utilisateur : le porteur n'a pas de
       * compte dans cet espace, et si cette valeur se retrouvait un jour dans une trace, elle doit se lire
       * pour ce qu'elle est. Durée courte (1 h) : une session d'observation n'a pas à survivre à la journée.
       */
      observerTenant: async (tenantId) => {
        const nom = await opsStore.getTenantName(tenantId);
        if (nom === null) return null;
        const token = await signSession(
          { userId: 'ops-observation', tenantId, role: 'admin', impersonated: true },
          config.AUTH_SECRET,
          '1h',
        );
        return { token, tenantName: nom };
      },
    },
    opsToken: config.OPS_TOKEN,
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
    apiKeys: {
      createKey: (tenant, name, scopes) => apiKeyStore.create(tenant, name, scopes),
      listKeys: (tenant) => apiKeyStore.listByTenant(tenant),
      revokeKey: (tenant, id) => apiKeyStore.revoke(tenant, id),
    },
    v1: {
      apiKeys: apiKeyStore,
      contacts: {
        upsertContacts: (tenant, items) => upsertContactsFromApi(tenant, items, { contacts: contactStore, fields: fieldStore }),
      },
      sends: {
        resolveScenario: (tenant, ref) => resolveScenario(tenant, ref, workflowStore),
        // Cible node : le code `nod_` vit dans le graphe -> scan des scénarios du tenant. Le libellé du bloc
        // (ou son code à défaut) sert à nommer la campagne dans la console.
        resolveNode: async (tenant, code) => {
          const r = await resolveNode(tenant, code, workflowStore);
          // Un code `nod_` est unique : resolveNode ne produit jamais 'ambiguous', seulement not_found.
          if (!r.ok) return { ok: false, reason: 'not_found' };
          const node = r.value.graph.nodes.find((n) => n.id === r.value.nodeId);
          const label = String(node?.data.label ?? '').trim() || code;
          // Le TYPE décide si la fenêtre de service WhatsApp s'applique à cette cible (cf. exigeFenetre24h).
          return { ok: true, value: { workflowId: r.value.workflowId, nodeId: r.value.nodeId, label, type: node?.type ?? null } };
        },
        getWindowOpenByWaIds: (tenant, waIds) => inboxStore.getWindowOpenByWaIds(tenant, waIds),
        getTenantPhoneNumberId: (tenant) => repo.getTenantPhoneNumberId(tenant),
        phoneNumberBelongsToTenant: (pn, tenant) => repo.phoneNumberBelongsToTenant(pn, tenant),
        findContactByPhone: async (tenant, phone) => { const c = await contactStore.findByPhone(tenant, phone); return c ? { id: c.id } : null; },
        createContactByPhone: (tenant, phone) => contactStore.upsertByPhoneReturningId({ tenantId: tenant, phoneE164: phone, profileName: null, fields: {}, optInStatus: 'unknown' }),
        listContactsForBuildByIds: (tenant, ids) => repo.listContactsForBuildByIds(tenant, ids),
        createSend: (input, recipients) => repo.createWithRecipients(input, recipients),
        enqueue: (campaignId, tenantId, count, rate) =>
          enqueueCampaignRun(queue, {
            campaignId,
            tenantId,
            pendingCount: count,
            resolvedRatePerMinute: resolveRatePerMinute(rate, config.CAMPAIGN_DEFAULT_RATE_PER_MINUTE),
          }),
        idempotencyClaim: (tenant, key) => idempotencyStore.claim(tenant, key),
        idempotencyComplete: (tenant, key, sendId, response) => idempotencyStore.complete(tenant, key, sendId, response),
        idempotencyRelease: (tenant, key) => idempotencyStore.release(tenant, key),
        getSendDetail: (sendId, tenant) => repo.getCampaignDetail(sendId, tenant),
      },
      /**
       * Serveur MCP (`POST /mcp`) : les MÊMES fonctions que la console, jamais des variantes.
       *
       * Chaque ligne ci-dessous est déjà branchée plus haut pour les routes de l'inbox et du mini-CRM. C'est
       * exactement l'intention : un outil MCP n'est qu'un second appelant. Le jour où une garde change (la
       * fenêtre de 24 h, la prise de fil, le scope tenant), elle change pour les deux d'un coup.
       */
      mcp: {
        listConversations: (tenant, opts) => inboxStore.listConversations(tenant, opts),
        getMessages: (id) => inboxStore.getMessages(id),
        getConversationContext: (id, tenant) => inboxStore.getConversationContext(id, tenant),
        getControlOwner: (tenant, waId) => inboxStore.getControlOwner(tenant, waId),
        getAssignee: (tenant, id) => inboxStore.getAssignee(tenant, id),
        setAssignee: (tenant, id, assignee, par) => inboxStore.setAssignee(tenant, id, assignee, par),
        getTenantPhoneNumberId: (tenant) => repo.getTenantPhoneNumberId(tenant),
        sendReply: async (tenant, phoneNumberId, to, text) => {
          const client = await metaFactory.clientForTenant(tenant, phoneNumberId); // token PAR TENANT (B1)
          return (await client.sendText(to, text)).messageId;
        },
        recordOutbound: (id, body, msgId, origine, type, cat, name, sender, canal) => inboxStore.recordOutbound(id, body, msgId, origine, type, cat, name, sender, canal),
        // ⚠️ `app_human` pour un agent TIERS, et c'est un choix : `ControlOwner` n'a que trois valeurs, et ce
        // qui compte ici est que le scénario cesse d'avancer TOUT SEUL et que MBA cesse de répondre, ce que
        // `app_human` produit exactement. La distinction « qui a parlé » est portée là où elle sert et où
        // elle ne coûte pas de migration du chemin chaud : l'ORIGINE du message (`mcp`, migration 0101).
        takeControl: async (tenant, waId) => { await inboxStore.setControlOwner(tenant, waId, 'app_human'); },
        chercherContacts: (tenant, filtres, limit, offset) => contactStore.query(tenant, filtres, limit, offset),
        contactParTelephone: (tenant, phone) => contactStore.findByPhone(tenant, phone),
        ajouterTags: (tenant, waId, tags) => contactStore.addTagsByPhoneReturningNew(tenant, waId, tags),
        listerMembres: async (tenant) => (await userStore.list(tenant)).map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role })),
      },
    },
  });

  /**
   * L'attente du pool, versée en base une fois par minute (lot 7 du plan post-audit, migration 0109).
   *
   * L'API a SON pool, distinct de celui du worker : deux lignes par minute, jamais agrégées, sinon on perdrait
   * justement l'information qui dit lequel des deux souffre. Un `registreDeTaches` serait démesuré pour une
   * seule minuterie ici ; elle est donc posée à la main, `unref` (elle ne doit pas retenir le process) et
   * arrêtée dans l'arrêt propre.
   */
  const minuteriePoolAttentes = setInterval(() => {
    void viderVersLaBase(poolAttentesStore, mesureAttentePool, 'api', new Date(), (err) => {
      // eslint-disable-next-line no-console
      console.error('pool-attentes: écriture impossible (migration 0109 passée ?):', err instanceof Error ? err.message : err);
    });
  }, 60_000);
  minuteriePoolAttentes.unref?.();

  installGracefulShutdown(async () => {
    clearInterval(minuteriePoolAttentes);
    await app.close();
    await queue.stop();
    await pool.end();
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
