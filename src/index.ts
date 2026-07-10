import 'dotenv/config';
import { buildServer } from './server';
import { config } from './config';
import { PgBossQueue } from './queue/pgboss';
import { pool } from './db/pool';
import { PgContactStore } from './crm/contact-store.pg';
import { PgUserFieldStore } from './crm/field-store.pg';
import { PgCampaignRepo } from './campaign/store.pg';
import { PgInboxStore } from './inbox/store.pg';
import { PgStatsStore } from './stats/store.pg';
import { PgTenantSettingsStore } from './settings/store.pg';
import { PgUserAuthStore } from './auth/store';
import { PgUserStore } from './user/store.pg';
import { PgFlowStore } from './flow/store.pg';
import { MetaTemplateClient } from './meta/templates';
import { MetaFlowClient } from './meta/flows';
import { MetaPricingClient } from './meta/pricing';
import { MetaClient } from './meta/client';
import { buildTemplateComponents } from './meta/template-components';
import { FetchTransport } from './meta/http';
import { installGracefulShutdown } from './shutdown';
import type { CountryCode } from 'libphonenumber-js';

async function main(): Promise<void> {
  const queue = new PgBossQueue(config.DATABASE_URL, config.PGBOSS_SCHEMA);
  await queue.start();

  const repo = new PgCampaignRepo(pool);
  const contactStore = new PgContactStore(pool);
  const inboxStore = new PgInboxStore(pool);
  const statsStore = new PgStatsStore(pool);
  const settingsStore = new PgTenantSettingsStore(pool);
  const userStore = new PgUserStore(pool);
  const flowStore = new PgFlowStore(pool);
  const transport = new FetchTransport();
  const pricingClient = new MetaPricingClient(config.META_ACCESS_TOKEN, config.META_GRAPH_VERSION);
  const flowClient = new MetaFlowClient(config.META_ACCESS_TOKEN, config.META_GRAPH_VERSION, config.META_FLOW_JSON_VERSION);
  const app = buildServer({
    queue,
    auth: {
      users: new PgUserAuthStore(pool),
      secret: config.AUTH_SECRET,
      // Re-vérif par requête : compte révoqué/supprimé -> 401 immédiat, rôle frais depuis la base.
      getUserState: (userId) => userStore.getAuthState(userId),
    },
    import: {
      contacts: contactStore,
      userFields: new PgUserFieldStore(pool),
      defaultCountry: config.DEFAULT_COUNTRY as CountryCode,
      listContacts: (tenantId, limit, offset) => contactStore.list(tenantId, limit, offset),
    },
    campaigns: {
      repo,
      queue,
      phoneNumberBelongsToTenant: (pn, tenant) => repo.phoneNumberBelongsToTenant(pn, tenant),
      campaignBelongsTo: (id, tenant) => repo.campaignBelongsTo(id, tenant),
      listCampaigns: (tenant) => repo.listCampaignSummaries(tenant),
      getCampaignDetail: (id, tenant) => repo.getCampaignDetail(id, tenant),
      listPhoneNumbers: (tenant) => repo.listPhoneNumbers(tenant),
    },
    templates: {
      templates: new MetaTemplateClient(config.META_ACCESS_TOKEN, config.META_GRAPH_VERSION),
      getWabaId: (tenant) => repo.getTenantWabaId(tenant),
    },
    inbox: {
      listConversations: (tenant) => inboxStore.listConversations(tenant),
      getConversationContext: (id, tenant) => inboxStore.getConversationContext(id, tenant),
      getMessages: (id) => inboxStore.getMessages(id),
      recordOutbound: (id, body, msgId, type, cat, name) => inboxStore.recordOutbound(id, body, msgId, type, cat, name),
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
      getDashboard: (tenant, days) => statsStore.getDashboard(tenant, days),
      getTemplateBreakdown: (tenant, days) => statsStore.getTemplateBreakdown(tenant, days),
      getPricing: async (tenant, days) => {
        const wabaId = await repo.getTenantWabaId(tenant);
        if (!wabaId) return null;
        const endTs = Math.floor(Date.now() / 1000);
        const startTs = endTs - Math.min(Math.max(days, 1), 365) * 24 * 3600;
        return pricingClient.getPricingAnalytics(wabaId, startTs, endTs);
      },
    },
    settings: {
      getSettings: (tenant) => settingsStore.get(tenant),
      setMbaEnabled: (tenant, enabled) => settingsStore.setMbaEnabled(tenant, enabled),
    },
    admin: {
      listUsers: (tenant) => userStore.list(tenant),
      createUser: (tenant, input) => userStore.create(tenant, input),
      setUserRole: (tenant, userId, role) => userStore.setRole(tenant, userId, role),
      setUserDisabled: (tenant, userId, disabled) => userStore.setDisabled(tenant, userId, disabled),
      deleteUser: (tenant, userId) => userStore.deleteUser(tenant, userId),
    },
    flows: {
      flows: flowClient,
      getWabaId: (tenant) => repo.getTenantWabaId(tenant),
      insertFlow: (tenantId, id, name, fields) => flowStore.insert({ id, tenantId, name, fields }),
      listFlows: (tenant) => flowStore.list(tenant),
      belongsTo: (flowId, tenant) => flowStore.belongsTo(flowId, tenant),
      markPublished: (flowId, tenant) => flowStore.markPublished(flowId, tenant),
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
