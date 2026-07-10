import Fastify from 'fastify';
import type { FastifyInstance, FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config';
import { registerReceiver } from './webhooks/receiver';
import { registerImport } from './http/import';
import { registerCampaigns } from './http/campaigns';
import { registerTemplates } from './http/templates';
import { registerInbox } from './http/inbox';
import { registerStats } from './http/stats';
import { registerSettings } from './http/settings';
import { registerAuth } from './auth/routes';
import { makeRequireAuth } from './auth/middleware';
import { MetaApiError } from './meta/errors';
import type { AuthRouteDeps } from './auth/routes';
import type { ImportRouteDeps } from './http/import';
import type { CampaignRouteDeps } from './http/campaigns';
import type { TemplateRouteDeps } from './http/templates';
import type { InboxRouteDeps } from './http/inbox';
import type { StatsRouteDeps } from './http/stats';
import type { SettingsRouteDeps } from './http/settings';
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
  /** Routes inbox (conversations + réponse). */
  inbox?: InboxRouteDeps;
  /** Stats du dashboard (séries 1 pt/jour). */
  stats?: StatsRouteDeps;
  /** Réglages tenant (toggle MBA). */
  settings?: SettingsRouteDeps;
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
    // Erreur remontée de l'API Meta (token expiré, template invalide...) -> 422 + message clair.
    // 422 (4xx) et non 502 : Cloudflare/NPM remplacent les 5xx de l'origine par leur propre page
    // « error code: 502 », ce qui masque le message Meta utile. Un 4xx passe tel quel avec le body.
    if (err instanceof MetaApiError) {
      // Message Meta tronqué (évite d'exposer un blob verbeux / des détails de trace).
      const detail = err.message.replace(/\s+/g, ' ').trim().slice(0, 200);
      return reply.code(422).send({ error: `Meta: ${detail}` });
    }
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
  if (deps.inbox) registerInbox(app, deps.inbox, requireAuth);
  if (deps.stats) registerStats(app, deps.stats, requireAuth);
  if (deps.settings) registerSettings(app, deps.settings, requireAuth);

  return app;
}
