import 'dotenv/config';
import { buildServer } from './server';
import { config } from './config';
import { PgBossQueue } from './queue/pgboss';
import { pool } from './db/pool';
import { PgContactStore } from './crm/contact-store.pg';
import { PgUserFieldStore } from './crm/field-store.pg';
import { PgCampaignRepo } from './campaign/store.pg';
import { PgInboxStore } from './inbox/store.pg';
import { PgUserAuthStore } from './auth/store';
import { MetaTemplateClient } from './meta/templates';
import { MetaClient } from './meta/client';
import { FetchTransport } from './meta/http';
import { installGracefulShutdown } from './shutdown';
import type { CountryCode } from 'libphonenumber-js';

async function main(): Promise<void> {
  const queue = new PgBossQueue(config.DATABASE_URL, config.PGBOSS_SCHEMA);
  await queue.start();

  const repo = new PgCampaignRepo(pool);
  const contactStore = new PgContactStore(pool);
  const inboxStore = new PgInboxStore(pool);
  const transport = new FetchTransport();
  const app = buildServer({
    queue,
    auth: { users: new PgUserAuthStore(pool), secret: config.AUTH_SECRET },
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
      recordOutbound: (id, body, msgId, type) => inboxStore.recordOutbound(id, body, msgId, type),
      getTenantPhoneNumberId: (tenant) => repo.getTenantPhoneNumberId(tenant),
      sendReply: async (phoneNumberId, to, text) => {
        const client = new MetaClient({ transport, token: config.META_ACCESS_TOKEN, phoneNumberId, version: config.META_GRAPH_VERSION });
        return (await client.sendText(to, text)).messageId;
      },
      sendTemplateMessage: async (phoneNumberId, to, tpl) => {
        const client = new MetaClient({ transport, token: config.META_ACCESS_TOKEN, phoneNumberId, version: config.META_GRAPH_VERSION });
        const components: unknown[] = [];
        if (tpl.headerImageUrl) {
          components.push({ type: 'header', parameters: [{ type: 'image', image: { link: tpl.headerImageUrl } }] });
        }
        if (tpl.bodyParams.length > 0) {
          components.push({ type: 'body', parameters: tpl.bodyParams.map((v) => ({ type: 'text', text: v })) });
        }
        const spec = { name: tpl.name, language: tpl.language, ...(components.length > 0 ? { components } : {}) };
        return (await client.sendTemplate(to, spec)).messageId;
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
