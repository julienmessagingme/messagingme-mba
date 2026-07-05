import 'dotenv/config';
import { buildServer } from './server';
import { config } from './config';
import { PgBossQueue } from './queue/pgboss';
import { pool } from './db/pool';
import { PgContactStore } from './crm/contact-store.pg';
import { PgUserFieldStore } from './crm/field-store.pg';
import { PgCampaignRepo } from './campaign/store.pg';
import { PgUserAuthStore } from './auth/store';
import { installGracefulShutdown } from './shutdown';
import type { CountryCode } from 'libphonenumber-js';

async function main(): Promise<void> {
  const queue = new PgBossQueue(config.DATABASE_URL, config.PGBOSS_SCHEMA);
  await queue.start();

  const repo = new PgCampaignRepo(pool);
  const contactStore = new PgContactStore(pool);
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
