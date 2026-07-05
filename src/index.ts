import { buildServer } from './server';
import { config } from './config';
import { PgBossQueue } from './queue/pgboss';
import { installGracefulShutdown } from './shutdown';

async function main(): Promise<void> {
  const queue = new PgBossQueue(config.DATABASE_URL, config.PGBOSS_SCHEMA);
  await queue.start();

  const app = buildServer({ queue });
  installGracefulShutdown(async () => {
    await app.close();
    await queue.stop();
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
