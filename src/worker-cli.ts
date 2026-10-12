import './charger-env';
import { demarrerWorker } from './worker';

demarrerWorker().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
