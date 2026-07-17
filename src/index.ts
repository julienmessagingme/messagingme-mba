import 'dotenv/config';
import { buildServer } from './server';
import { config } from './config';
import { PgBossQueue } from './queue/pgboss';
import { pool } from './db/pool';
import { PgContactStore } from './crm/contact-store.pg';
import { PgUserFieldStore } from './crm/field-store.pg';
import { PgTagStore } from './crm/tag-store.pg';
import { ensureField } from './crm/fields';
import { PgCampaignRepo } from './campaign/store.pg';
import { PgInboxStore } from './inbox/store.pg';
import { PgStatsStore } from './stats/store.pg';
import { estimateCostSeries } from './stats/cost';
import { rangeToUnix } from './stats/range';
import { ResendClient } from './support/resend';
import { PgTenantSettingsStore } from './settings/store.pg';
import { PgUserAuthStore } from './auth/store';
import { PgUserStore } from './user/store.pg';
import { PgAuthTokenStore } from './auth/token-store.pg';
import { verifyGoogleIdToken } from './auth/google';
import { PgFlowStore } from './flow/store.pg';
import { PgTemplateHintStore } from './crm/template-hints.pg';
import { MetaTemplateClient } from './meta/templates';
import { MetaFlowClient } from './meta/flows';
import { MetaMediaClient } from './meta/media';
import { MetaPricingClient } from './meta/pricing';
import { MetaPhoneNumberClient } from './meta/phone-number';
import { MetaClient } from './meta/client';
import { PgPhoneStatusStore } from './account/store.pg';
import { pullFromInfo, pullFromError } from './account/pull';
import { PgOpsStore } from './ops/store.pg';
import { PgWorkflowStore } from './workflow/store.pg';
import { resolveTenantCode } from './ids/tenant-code';
import { MetaEmbeddedSignupClient } from './meta/embedded-signup';
import { PgEmbeddedSignupStore } from './account/es-store.pg';
import { encryptSecret } from './crypto/secretbox';
import { buildTemplateComponents } from './meta/template-components';
import { FetchTransport } from './meta/http';
import { installGracefulShutdown } from './shutdown';
import type { CountryCode } from 'libphonenumber-js';

async function main(): Promise<void> {
  const queue = new PgBossQueue(config.DATABASE_URL, config.PGBOSS_SCHEMA);
  await queue.start();

  const repo = new PgCampaignRepo(pool);
  const contactStore = new PgContactStore(pool);
  const templateHintStore = new PgTemplateHintStore(pool);
  const fieldStore = new PgUserFieldStore(pool);
  const tagStore = new PgTagStore(pool);
  const inboxStore = new PgInboxStore(pool);
  const statsStore = new PgStatsStore(pool);
  const settingsStore = new PgTenantSettingsStore(pool);
  const userStore = new PgUserStore(pool);
  const authTokenStore = new PgAuthTokenStore(pool);
  const flowStore = new PgFlowStore(pool);
  const phoneStatusStore = new PgPhoneStatusStore(pool);
  const opsStore = new PgOpsStore(pool, config.PGBOSS_SCHEMA);
  const workflowStore = new PgWorkflowStore(pool);
  const phoneClient = new MetaPhoneNumberClient(config.META_ACCESS_TOKEN, config.META_GRAPH_VERSION);
  const transport = new FetchTransport();
  const pricingClient = new MetaPricingClient(config.META_ACCESS_TOKEN, config.META_GRAPH_VERSION);
  const flowClient = new MetaFlowClient(config.META_ACCESS_TOKEN, config.META_GRAPH_VERSION, config.META_FLOW_JSON_VERSION);
  const mediaClient = new MetaMediaClient(config.META_ACCESS_TOKEN, config.META_APP_ID, config.META_GRAPH_VERSION);
  // Envoi d'email auth (liens reset/invitation) : seulement si Resend est configuré, sinon undefined.
  const sendAuthEmail = config.RESEND_API_KEY
    ? async ({ to, subject, text, html }: { to: string; subject: string; text: string; html?: string }) => {
        await new ResendClient(config.RESEND_API_KEY).send({ from: `Messaging Me <${config.SUPPORT_FROM}>`, to, subject, text, ...(html ? { html } : {}) });
      }
    : undefined;
  const app = buildServer({
    queue,
    auth: {
      users: new PgUserAuthStore(pool),
      secret: config.AUTH_SECRET,
      // Re-vérif par requête : compte révoqué/supprimé -> 401 immédiat, rôle frais depuis la base.
      getUserState: (userId) => userStore.getAuthState(userId),
      // Refonte auth : inscription libre, reset/changement de mot de passe.
      createTenantWithAdmin: (name, admin) => userStore.createTenantWithAdmin(name, admin),
      setPassword: (userId, hash) => userStore.setPassword(userId, hash),
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
    },
    campaigns: {
      repo,
      queue,
      phoneNumberBelongsToTenant: (pn, tenant) => repo.phoneNumberBelongsToTenant(pn, tenant),
      campaignBelongsTo: (id, tenant) => repo.campaignBelongsTo(id, tenant),
      getRunSizing: (id) => repo.getRunSizing(id),
      scheduleCampaign: (id, tenant, when) => repo.scheduleCampaign(id, tenant, when),
      cancelSchedule: (id, tenant) => repo.cancelSchedule(id, tenant),
      getWorkflowGraph: async (wfId, tenant) => (await workflowStore.getById(wfId, tenant))?.graph ?? null,
      listCampaigns: (tenant) => repo.listCampaignSummaries(tenant),
      getCampaignDetail: (id, tenant) => repo.getCampaignDetail(id, tenant),
      listPhoneNumbers: (tenant) => repo.listPhoneNumbers(tenant),
    },
    templates: {
      templates: new MetaTemplateClient(config.META_ACCESS_TOKEN, config.META_GRAPH_VERSION),
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
      getTenantPhoneNumberId: (tenant) => repo.getTenantPhoneNumberId(tenant),
      sendReply: async (phoneNumberId, to, text) => {
        const client = new MetaClient({ transport, token: config.META_ACCESS_TOKEN, phoneNumberId, version: config.META_GRAPH_VERSION });
        return (await client.sendText(to, text)).messageId;
      },
      sendTemplateMessage: async (phoneNumberId, to, tpl) => {
        const client = new MetaClient({ transport, token: config.META_ACCESS_TOKEN, phoneNumberId, version: config.META_GRAPH_VERSION });
        const components = buildTemplateComponents({
          bodyParams: tpl.bodyParams,
          ...(tpl.headerMediaUrl ? { headerMediaUrl: tpl.headerMediaUrl } : {}),
          ...(tpl.headerFormat ? { headerFormat: tpl.headerFormat } : {}),
        });
        const spec = { name: tpl.name, language: tpl.language, ...(components.length > 0 ? { components } : {}) };
        return (await client.sendTemplate(to, spec)).messageId;
      },
    },
    stats: {
      getDashboard: (tenant, range) => statsStore.getDashboard(tenant, range),
      getTemplateBreakdown: (tenant, range) => statsStore.getTemplateBreakdown(tenant, range),
      getPricing: async (tenant, range) => {
        const wabaId = await repo.getTenantWabaId(tenant);
        if (!wabaId) return null;
        const { startTs, endTs } = rangeToUnix(range);
        return pricingClient.getPricingAnalytics(wabaId, startTs, endTs);
      },
      getCampaignFunnel: (tenant, campaignId) => statsStore.getCampaignFunnel(tenant, campaignId),
      getErrorBreakdown: (tenant, range, templateName) => statsStore.getErrorBreakdown(tenant, range, templateName),
      getCostSeries: async (tenant, range, filter) => {
        const wabaId = await repo.getTenantWabaId(tenant);
        const { startTs, endTs } = rangeToUnix(range);
        const [rows, pricing] = await Promise.all([
          statsStore.getCostVolume(tenant, range, filter),
          wabaId ? pricingClient.getPricingAnalytics(wabaId, startTs, endTs) : Promise.resolve(null),
        ]);
        const rates = {
          marketing: pricing?.byCategory['marketing']?.ratePerMessage ?? null,
          utility: pricing?.byCategory['utility']?.ratePerMessage ?? null,
        };
        return estimateCostSeries(range.from, range.to, rows, rates);
      },
    },
    settings: {
      getSettings: (tenant) => settingsStore.get(tenant),
      setMbaEnabled: (tenant, enabled) => settingsStore.setMbaEnabled(tenant, enabled),
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
    flows: {
      flows: flowClient,
      getWabaId: (tenant) => repo.getTenantWabaId(tenant),
      insertFlow: (tenantId, id, name, screens, ref, mapping, cta) => flowStore.insert({ id, tenantId, name, screens, ref, mapping, ...(cta ? { cta } : {}) }),
      listFlows: (tenant) => flowStore.list(tenant),
      belongsTo: (flowId, tenant) => flowStore.belongsTo(flowId, tenant),
      markPublished: (flowId, tenant) => flowStore.markPublished(flowId, tenant),
      ensureUserField: async (tenant, label, type) => { await ensureField(fieldStore, tenant, label, type); },
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
      listUserFields: (tenant) => fieldStore.list(tenant),
    },
    embeddedSignup: (() => {
      const esClient = new MetaEmbeddedSignupClient(config.META_APP_ID, config.META_APP_SECRET, config.META_GRAPH_VERSION);
      const esStore = new PgEmbeddedSignupStore(pool);
      return {
        configId: config.META_ES_CONFIG_ID,
        appId: config.META_APP_ID,
        graphVersion: config.META_GRAPH_VERSION,
        exchangeCode: (code: string) => esClient.exchangeCode(code),
        getPhone: (pn: string, tok: string) => esClient.getPhone(pn, tok),
        subscribeApp: (waba: string, tok: string) => esClient.subscribeApp(waba, tok),
        register: (pn: string, tok: string, pin: string) => esClient.register(pn, tok, pin),
        verifyWaba: (waba: string, tok: string) => esClient.verifyWaba(waba, tok),
        link: (input: { tenantId: string; wabaId: string; phoneNumberId: string; displayPhoneNumber: string | null; verifiedName: string | null }) => esStore.linkTenant(input),
        // Chiffrement au repos ICI (la route ne voit jamais le stockage) : AES-GCM avec ENCRYPTION_KEY. Token ET pin
        // (PIN 2FA du numéro = secret Meta) chiffrés.
        saveCredentials: (waba: string, tenant: string, token: string, pin: string | null) =>
          esStore.saveCredentials(waba, tenant, encryptSecret(token, config.ENCRYPTION_KEY), pin === null ? null : encryptSecret(pin, config.ENCRYPTION_KEY)),
      };
    })(),
    account: {
      getPhoneNumber: (tenant) => phoneStatusStore.getPhoneNumber(tenant),
      pullStatus: async (phoneNumberId, tenant) => {
        if (!config.META_ACCESS_TOKEN) return null; // pas de token -> pas de pull live (statut sur le dernier connu)
        try {
          const info = await phoneClient.get(phoneNumberId);
          // Santé WABA : 2e appel Graph, best-effort. Un échec (droits/état) ne casse pas le pull du numéro :
          // on retombe sur le statut du numéro seul (les champs WABA restent sur leur dernier connu via coalesce).
          const wabaId = await repo.getTenantWabaId(tenant);
          const waba = wabaId ? await phoneClient.getWabaHealth(wabaId).catch(() => undefined) : undefined;
          return pullFromInfo(info, waba);
        } catch (err) {
          return pullFromError(err);
        }
      },
      saveStatus: (id, patch) => phoneStatusStore.saveStatus(id, patch),
      setHubspotConnected: (id, tenant, connected) => phoneStatusStore.setHubspotConnected(id, tenant, connected),
      getHubspotPortal: (tenant) => phoneStatusStore.getHubspotPortal(tenant),
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
    },
    ops: {
      getTenantOverview: () => opsStore.getTenantOverview(),
      getGlobalDaily: (days) => opsStore.getGlobalDaily(days),
      getQueueLoad: () => opsStore.getQueueLoad(),
    },
    opsToken: config.OPS_TOKEN,
    support: {
      enabled: !!config.RESEND_API_KEY && !!config.SUPPORT_TO,
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
