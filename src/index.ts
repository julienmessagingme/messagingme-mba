import 'dotenv/config';
import { buildServer } from './server';
import { config } from './config';
import { PgBossQueue } from './queue/pgboss';
import { pool } from './db/pool';
import { PgContactStore } from './crm/contact-store.pg';
import { PgContactHistoryStore } from './crm/contact-history.pg';
import { PgUserFieldStore } from './crm/field-store.pg';
import { PgTagStore } from './crm/tag-store.pg';
import { ensureField, ensureFieldByKey, WHATSAPP_OPTIN_FIELD_KEY, WHATSAPP_OPTIN_FIELD_LABEL } from './crm/fields';
import { PgCampaignRepo } from './campaign/store.pg';
import { PgInboxStore } from './inbox/store.pg';
import { PgStatsStore } from './stats/store.pg';
import { PgConversationStatsStore } from './stats/conversation-stats.pg';
import { estimateCostSeries } from './stats/cost';
import { rangeToUnix } from './stats/range';
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
import { PgWorkflowNodeEventStore } from './workflow/node-events.pg';
import { PgWorkflowReportStore } from './workflow/reports.pg';
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
import { AUTOMATION_EVENT_QUEUE, type AutomationEventJob } from './automation/event-job';
import { PgWorkflowStore } from './workflow/store.pg';
import { resolveTenantCode } from './ids/tenant-code';
import { MetaEmbeddedSignupClient } from './meta/embedded-signup';
import { PgEmbeddedSignupStore } from './account/es-store.pg';
import { encryptSecret, decryptSecret } from './crypto/secretbox';
import { MetaCredentialsResolver } from './meta/credentials';
import { fetchUrlBorne } from './http/mba';
import { MetaClientFactory } from './meta/factory';
import { buildTemplateComponents, carouselSendBlocker } from './meta/template-components';
import { buildWorkflowRuntime } from './workflow/wiring';
import { PgEmailAccountStore } from './email/account-store.pg';
import { PgEmailTemplateStore } from './email/template-store.pg';
import { EmailAccountResolver } from './email/resolver';
import { buildTransport as buildEmailTransport } from './email/smtp';
import { FetchTransport } from './meta/http';
import { installGracefulShutdown } from './shutdown';
import type { CountryCode } from 'libphonenumber-js';

async function main(): Promise<void> {
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
  const contactStore = new PgContactStore(pool);
  const contactHistoryStore = new PgContactHistoryStore(pool);
  const templateHintStore = new PgTemplateHintStore(pool);
  const fieldStore = new PgUserFieldStore(pool);
  const tagStore = new PgTagStore(pool);
  const inboxStore = new PgInboxStore(pool);
  const statsStore = new PgStatsStore(pool);
  // Lecture des agrégats d'analyse de conversation (Pièce 1). `enabled` = état de la feature côté serveur
  // (empty-state différencié). La lecture ne coûte rien ; l'écriture (analyse LLM) est gatée ailleurs.
  const conversationStatsStore = new PgConversationStatsStore(pool, config.CONVERSATION_ANALYSIS_ENABLED === 'true');
  const settingsStore = new PgTenantSettingsStore(pool);
  const userStore = new PgUserStore(pool);
  const authTokenStore = new PgAuthTokenStore(pool);
  const flowStore = new PgFlowStore(pool);
  const apiKeyStore = new PgApiKeyStore(pool);
  const idempotencyStore = new PgApiIdempotencyStore(pool);
  const auditStore = new PgAuditStore(pool);
  const nodeEventStore = new PgWorkflowNodeEventStore(pool);
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
  const automationStore = new PgAutomationStore(pool);
  // Node « Envoi de mail » : boîtes SMTP + modèles (scopés tenant), résolveur de transport à cache par
  // tenant+compte (invalidé par les routes email à chaque écriture d'un compte).
  const emailAccounts = new PgEmailAccountStore(pool);
  const emailTemplates = new PgEmailTemplateStore(pool);
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
  const app = buildServer({
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
      phoneNumberBelongsToTenant: (pn, tenant) => repo.phoneNumberBelongsToTenant(pn, tenant),
      // Garde d'isolation du canal RCS, symétrique de celle du numéro Meta : le partenaire RBM est global,
      // donc c'est CE contrôle qui empêche un tenant de créer une campagne sous la marque d'un autre.
      rcsAgentBelongsToTenant: (agentId, tenant) => workflowRuntime.rcsStack.agents.belongsToTenant(agentId, tenant),
      listRcsAgents: (tenant) => workflowRuntime.rcsStack.agents.listForTenant(tenant),
      campaignBelongsTo: (id, tenant) => repo.campaignBelongsTo(id, tenant),
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
    templates: {
      templatesFor: (tenant) => metaFactory.templateClientForTenant(tenant), // token PAR TENANT (B1), repli global en sommeil
      getWabaId: (tenant) => repo.getTenantWabaId(tenant),
      getPublishedFlow: (tenant, flowId) => flowStore.isPublished(flowId, tenant),
      listActiveCampaignsForTemplate: (tenant, name, language) => repo.listActiveCampaignsForTemplate(tenant, name, language),
      saveParamHints: (tenant, name, language, hints) => templateHintStore.save(tenant, name, language, hints),
      getParamHints: (tenant, name, language) => templateHintStore.get(tenant, name, language),
      removeParamHints: (tenant, name) => templateHintStore.removeByName(tenant, name),
    },
    inbox: {
      listConversations: (tenant) => inboxStore.listConversations(tenant),
      getConversationContext: (id, tenant) => inboxStore.getConversationContext(id, tenant),
      getMessages: (id) => inboxStore.getMessages(id),
      recordOutbound: (id, body, msgId, type, cat, name, sender) => inboxStore.recordOutbound(id, body, msgId, type, cat, name, sender),
      // Un opérateur qui écrit prend le fil : le scénario se gèle sur ce contact, les campagnes le sautent.
      takeControl: async (tenant, waId) => { await inboxStore.setControlOwner(tenant, waId, 'app_human'); },
      getControlOwner: (tenant, waId) => inboxStore.getControlOwner(tenant, waId),
      // Surcharge de reprise d'un fil (C.4) : dit au sweep de handback s'il faut, pour CE fil, le rendre au
      // scénario ou le laisser à l'humain. Ne bascule pas le contrôle par elle-même.
      /**
       * L'opérateur rend la main. Aujourd'hui la conversation repart au scénario.
       *
       * PRÉ-CÂBLAGE MBA : quand l'agent de Meta est actif sur le numéro, c'est ici qu'il faudra appeler
       * `POST https://api.facebook.com/business/whatsapp/phone_numbers/{id}/thread_control` avec
       * `{ messaging_product:'whatsapp', action:'release', to:<waId> }` pour qu'il redevienne le
       * répondeur principal. ⚠️ L'action est bien `release` et non `pass` : la spec dit que seul
       * `release` est implémenté et qu'il rend la conversation à MBA, alors que le guide de démarrage
       * de Meta dit l'inverse. Détail et citations dans docs/MBA-API-REFERENCE.md.
       *
       * Le champ `mbaEnabled` du tenant est le bon interrupteur pour brancher cet appel le jour venu.
       */
      releaseControl: async (tenant, waId) => {
        await inboxStore.setControlOwner(tenant, waId, 'app_workflow');
        return 'app_workflow';
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
        // Un parcours déjà actif sur ce contact est CLOS avant d'en lancer un nouveau. Sans ça, les deux
        // vivraient en parallèle : le contact recevrait les messages des deux, et le plus ancien deviendrait
        // orphelin pour toujours (l'avance ne retrouve qu'un run à la fois, et rien ne nettoie les `waiting`).
        // On tranche dans le sens de l'opérateur : c'est lui qui décide, son scénario remplace l'ancien.
        const clos = await workflowRuntime.runStore.closeActiveByWaId(tenant, waId);
        if (clos > 0) {
          // eslint-disable-next-line no-console
          console.log(`inbox: ${clos} parcours en cours clos avant le lancement manuel de ${workflowId} pour ${waId}`);
        }
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
          await queue.enqueue(AUTOMATION_EVENT_QUEUE, { tenantId, event } satisfies AutomationEventJob);
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
      getCostSeries: async (tenant, range, filter) => {
        const wabaId = await repo.getTenantWabaId(tenant);
        const { startTs, endTs } = rangeToUnix(range);
        const pricingClientT = wabaId ? await metaFactory.pricingClientForTenant(tenant) : null;
        const [rows, pricing] = await Promise.all([
          statsStore.getCostVolume(tenant, range, filter),
          pricingClientT && wabaId ? pricingClientT.getPricingAnalytics(wabaId, startTs, endTs) : Promise.resolve(null),
        ]);
        const rates = {
          marketing: pricing?.byCategory['marketing']?.ratePerMessage ?? null,
          utility: pricing?.byCategory['utility']?.ratePerMessage ?? null,
          currency: pricing?.currency ?? null,
        };
        return estimateCostSeries(range.from, range.to, rows, rates);
      },
      getWorkflowNodeCounts: (tenant, workflowId, range) => nodeEventStore.countByNode(tenant, workflowId, range),
      getConversationSummary: (tenant, range) => conversationStatsStore.getSummary(tenant, range),
      listAnalyzedConversations: (tenant, range, filters) => conversationStatsStore.listAnalyzed(tenant, range, filters),
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
    // d'isolation : la surface MBA est indexée par NUMÉRO, pas par tenant.
    mba: {
      clientFor: (tenant) => metaFactory.mbaClientForTenant(tenant),
      phoneNumberBelongsToTenant: (pn, tenant) => repo.phoneNumberBelongsToTenant(pn, tenant),
      fetchUrl: fetchUrlBorne(),
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
    },
    contacts: {
      applyEdits: (tenant, id, edits) => contactStore.applyEdits(tenant, id, edits),
      applyEditsMany: (tenant, target, edits) => contactStore.applyEditsMany(tenant, target, edits),
      purgeMany: (tenant, ids) => contactStore.purgeMany(tenant, ids),
      contactIdsForTarget: (tenant, target) => contactStore.contactIdsForTarget(tenant, target),
      audit: auditSink,
      listAudit: (tenant, o) => auditStore.list(tenant, o),
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
          await queue.enqueue(AUTOMATION_EVENT_QUEUE, { tenantId: tenant, event: { kind: 'tag_added', waId, tag } } satisfies AutomationEventJob);
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
        await queue.enqueue('hubspot-catchup', { tenantId: tenant }, { singletonKey: `catchup:${tenant}` });
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
      getWorkflow: (id, tenant) => workflowStore.getById(id, tenant),
      updateWorkflow: (id, tenant, patch) => workflowStore.update(id, tenant, patch),
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
    ops: {
      getTenantOverview: () => opsStore.getTenantOverview(),
      getGlobalDaily: (days) => opsStore.getGlobalDaily(days),
      getQueueLoad: () => opsStore.getQueueLoad(),
      getWorkerHeartbeat: () => heartbeatStore.get(),
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
          return { ok: true, value: { workflowId: r.value.workflowId, nodeId: r.value.nodeId, label } };
        },
        getWindowOpenByWaIds: (tenant, waIds) => inboxStore.getWindowOpenByWaIds(tenant, waIds),
        getTenantPhoneNumberId: (tenant) => repo.getTenantPhoneNumberId(tenant),
        phoneNumberBelongsToTenant: (pn, tenant) => repo.phoneNumberBelongsToTenant(pn, tenant),
        findContactByPhone: async (tenant, phone) => { const c = await contactStore.findByPhone(tenant, phone); return c ? { id: c.id } : null; },
        createContactByPhone: (tenant, phone) => contactStore.upsertByPhoneReturningId({ tenantId: tenant, phoneE164: phone, profileName: null, fields: {}, optInStatus: 'unknown' }),
        listContactsForBuildByIds: (tenant, ids) => repo.listContactsForBuildByIds(tenant, ids),
        createSend: (input, recipients) => repo.createWithRecipients(input, recipients),
        enqueue: (campaignId, count, rate) =>
          enqueueCampaignRun(queue, campaignId, count, resolveRatePerMinute(rate, config.CAMPAIGN_DEFAULT_RATE_PER_MINUTE)),
        idempotencyClaim: (tenant, key) => idempotencyStore.claim(tenant, key),
        idempotencyComplete: (tenant, key, sendId, response) => idempotencyStore.complete(tenant, key, sendId, response),
        idempotencyRelease: (tenant, key) => idempotencyStore.release(tenant, key),
        getSendDetail: (sendId, tenant) => repo.getCampaignDetail(sendId, tenant),
      },
    },
  });

  installGracefulShutdown(async () => {
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
