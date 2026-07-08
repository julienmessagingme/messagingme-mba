import Fastify from 'fastify';
import type { FastifyInstance, FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config';
import { registerReceiver } from './webhooks/receiver';
import { registerImport } from './http/import';
import { registerCampaigns } from './http/campaigns';
import { registerTemplates } from './http/templates';
import { registerAuth } from './auth/routes';
import { makeRequireAuth } from './auth/middleware';
import type { AuthRouteDeps } from './auth/routes';
import type { ImportRouteDeps } from './http/import';
import type { CampaignRouteDeps } from './http/campaigns';
import type { TemplateRouteDeps } from './http/templates';
import type { Queue } from './queue/queue';

export interface ServerDeps {
  queue: Queue;
  /** Défaut : config.META_VERIFY_TOKEN. Injectable en test. */
  verifyToken?: string;
  /** Défaut : config.META_APP_SECRET. Injectable en test. */
  appSecret?: string;
  /** Auth (login + secret JWT). OBLIGATOIRE si `import` ou `campaigns` sont exposés. */
  auth?: AuthRouteDeps;
  /** Routes CRM/import (enregistrées seulement si fournies -> tests DB-free du receiver). */
  import?: ImportRouteDeps;
  /** Routes campagnes (enregistrées seulement si fournies). */
  campaigns?: CampaignRouteDeps;
  /** Routes templates (liste + création via l'API Meta). */
  templates?: TemplateRouteDeps;
}

/**
 * Construit l'instance Fastify (le bouclier). La file et les stores sont injectés pour
 * rester testable sans DB. Les routes tenant (import/campaigns) EXIGENT l'auth : le tenant
 * est dérivé du JWT, jamais de l'URL.
 */
export function buildServer(deps: ServerDeps): FastifyInstance {
  if ((deps.import || deps.campaigns) && !deps.auth) {
    throw new Error('buildServer: `auth` requis dès que les routes import/campaigns sont exposées');
  }

  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });

  // Enveloppe d'erreur uniforme { error } et pas de fuite du message interne sur les 5xx.
  app.setErrorHandler((err: FastifyError, _req: FastifyRequest, reply: FastifyReply) => {
    const code = err.statusCode ?? 500;
    reply.code(code).send({ error: code < 500 ? err.message : 'Internal Server Error' });
  });

  app.get('/health', async () => ({
    ok: true,
    service: 'messagingme-mba',
    ts: Date.now(),
  }));

  registerReceiver(app, deps.queue, {
    verifyToken: deps.verifyToken ?? config.META_VERIFY_TOKEN,
    appSecret: deps.appSecret ?? config.META_APP_SECRET,
  });

  const requireAuth = deps.auth ? makeRequireAuth(deps.auth.secret) : undefined;
  if (deps.auth) registerAuth(app, deps.auth);
  if (deps.import) registerImport(app, deps.import, requireAuth);
  if (deps.campaigns) registerCampaigns(app, deps.campaigns, requireAuth);
  if (deps.templates) registerTemplates(app, deps.templates, requireAuth);

  return app;
}
