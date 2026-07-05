import { config } from './config';
import { PgBossQueue } from './queue/pgboss';
import { pool } from './db/pool';
import { handleWebhookJob } from './webhooks/handler';
import { PgEventStore } from './webhooks/store';
import {
  PgCampaignRepo,
  PgCampaignStore,
  PgRecipientStore,
  PgFrequencyStore,
  PgQualityProvider,
} from './campaign/store.pg';
import { campaignRunJob } from './campaign/run-job';
import { MetaClient } from './meta/client';
import { FetchTransport } from './meta/http';
import { installGracefulShutdown } from './shutdown';

async function main(): Promise<void> {
  const queue = new PgBossQueue(config.DATABASE_URL, config.PGBOSS_SCHEMA);
  await queue.start();

  // File webhook (Loop 1).
  const eventStore = new PgEventStore(pool);
  await queue.work('webhook', async (data) => {
    await handleWebhookJob(data, eventStore);
  });

  // File campaign-run (Loop 5) : sender MetaClient construit par campagne.
  const repo = new PgCampaignRepo(pool);
  const transport = new FetchTransport();
  await queue.work('campaign-run', async (data) => {
    await campaignRunJob(data, {
      getCampaign: (id) => repo.getCampaign(id),
      senderFor: (campaign) =>
        new MetaClient({
          transport,
          token: config.META_ACCESS_TOKEN,
          phoneNumberId: campaign.phoneNumberId,
          version: config.META_GRAPH_VERSION,
        }),
      recipients: new PgRecipientStore(pool),
      campaigns: new PgCampaignStore(pool),
      frequency: new PgFrequencyStore(pool),
      quality: new PgQualityProvider(pool),
    });
  });

  installGracefulShutdown(async () => {
    await queue.stop();
    await pool.end();
  });

  // eslint-disable-next-line no-console
  console.log('messagingme-mba worker démarré (files: webhook, campaign-run)');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
