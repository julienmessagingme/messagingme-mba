import { config } from './config';
import { PgBossQueue } from './queue/pgboss';
import { pool } from './db/pool';
import { handleWebhookJob } from './webhooks/handler';
import { PgEventStore } from './webhooks/store';
import { installGracefulShutdown } from './shutdown';

async function main(): Promise<void> {
  const queue = new PgBossQueue(config.DATABASE_URL, config.PGBOSS_SCHEMA);
  await queue.start();

  const store = new PgEventStore(pool);
  await queue.work('webhook', async (data) => {
    await handleWebhookJob(data, store);
  });

  installGracefulShutdown(async () => {
    await queue.stop();
    await pool.end();
  });

  // eslint-disable-next-line no-console
  console.log('messagingme-mba worker démarré (file: webhook)');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
