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
import { registerUsers } from './http/users';
import { registerFlows } from './http/flows';
import { registerAuth } from './auth/routes';
import { makeRequireAuth, makeRequireRole } from './auth/middleware';
import { MetaApiError } from './meta/errors';
import { FlowJsonInvalidError } from './meta/flows';
import type { AuthRouteDeps } from './auth/routes';
import type { ImportRouteDeps } from './http/import';
import type { CampaignRouteDeps } from './http/campaigns';
import type { TemplateRouteDeps } from './http/templates';
import type { InboxRouteDeps } from './http/inbox';
import type { StatsRouteDeps } from './http/stats';
import type { SettingsRouteDeps } from './http/settings';
import type { UsersRouteDeps } from './http/users';
import type { FlowRouteDeps } from './http/flows';
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
  /** Gestion des comptes (onglet Admin) — réservé aux admins. */
  admin?: UsersRouteDeps;
  /** WhatsApp Flows (constructeur de formulaire) — réservé aux admins. */
  flows?: FlowRouteDeps;
}

/**
 * Construit l'instance Fastify (le bouclier). La file et les stores sont injectés pour
 * rester testable sans DB. Les routes tenant (import/campaigns) EXIGENT l'auth : le tenant
 * est dérivé du JWT, jamais de l'URL.
 */
export function buildServer(deps: ServerDeps): FastifyInstance {
  if ((deps.import || deps.campaigns || deps.admin || deps.flows) && !deps.auth) {
    throw new Error('buildServer: `auth` requis dès que les routes import/campaigns/admin/flows sont exposées');
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
    // flow_json refusé par Meta à la création : 422 + les erreurs de validation (pas un 500 opaque).
    if (err instanceof FlowJsonInvalidError) {
      return reply.code(422).send({ error: err.message.slice(0, 200) });
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

  const requireAuth = deps.auth ? makeRequireAuth(deps.auth.secret, deps.auth.getUserState) : undefined;
  // RBAC : tout est réservé aux admins SAUF l'inbox (le seul périmètre de l'agent). La barrière
  // est au preHandler (source de vérité serveur) ; l'UI ne fait que masquer/rediriger en confort.
  const requireAdmin = requireAuth ? [requireAuth, makeRequireRole(['admin'])] : undefined;
  if (deps.auth) registerAuth(app, deps.auth);
  if (deps.import) registerImport(app, deps.import, requireAdmin);
  if (deps.campaigns) registerCampaigns(app, deps.campaigns, requireAdmin);
  // Templates : la LISTE (GET) doit rester lisible par l'agent — l'inbox en a besoin pour envoyer
  // un template hors fenêtre 24h (seul moyen de re-contacter). La CRÉATION (POST) reste admin-only
  // via le forbidNonAdmin dans le handler. La page /templates de gestion est masquée à l'agent côté UI.
  if (deps.templates) registerTemplates(app, deps.templates, requireAuth);
  if (deps.inbox) registerInbox(app, deps.inbox, requireAuth);
  if (deps.stats) registerStats(app, deps.stats, requireAdmin);
  if (deps.settings) registerSettings(app, deps.settings, requireAdmin);
  if (deps.admin) registerUsers(app, deps.admin, requireAdmin);
  if (deps.flows) registerFlows(app, deps.flows, requireAdmin);

  return app;
}
