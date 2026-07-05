import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { config } from './config';
import { registerReceiver } from './webhooks/receiver';
import type { Queue } from './queue/queue';

export interface ServerDeps {
  queue: Queue;
  /** Défaut : config.META_VERIFY_TOKEN. Injectable en test. */
  verifyToken?: string;
  /** Défaut : config.META_APP_SECRET. Injectable en test. */
  appSecret?: string;
}

/**
 * Construit l'instance Fastify (le bouclier). La file est injectée pour
 * rester testable sans DB (FakeQueue en unit, PgBossQueue en prod).
 */
export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/health', async () => ({
    ok: true,
    service: 'messagingme-mba',
    ts: Date.now(),
  }));

  registerReceiver(app, deps.queue, {
    verifyToken: deps.verifyToken ?? config.META_VERIFY_TOKEN,
    appSecret: deps.appSecret ?? config.META_APP_SECRET,
  });

  return app;
}
