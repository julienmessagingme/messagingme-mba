import { buildServer } from './server';
import { config } from './config';

const app = buildServer();

app
  .listen({ port: config.PORT, host: '0.0.0.0' })
  .then(() => {
    // eslint-disable-next-line no-console
    console.log(`messagingme-mba api en écoute sur :${config.PORT}`);
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
