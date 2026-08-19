import Fastify from 'fastify';
import type { FastifyInstance, FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config';
import { registerReceiver } from './webhooks/receiver';
import { registerImport } from './http/import';
import { registerCampaigns } from './http/campaigns';
import { registerTemplates } from './http/templates';
import { registerInbox } from './http/inbox';
import { registerHubspotEvents, type HubspotEventRouteDeps } from './http/hubspot-events';
import { registerStats } from './http/stats';
import { registerSettings } from './http/settings';
import { registerUsers } from './http/users';
import { registerFlows } from './http/flows';
import { registerMedia } from './http/media';
import { registerTags } from './http/tags';
import { registerFields } from './http/fields';
import { registerSupport } from './http/support';
import { registerContacts } from './http/contacts';
import { registerWorkflowReports } from './http/workflow-reports';
import type { WorkflowReportsRouteDeps } from './http/workflow-reports';
import { registerAccount } from './http/account';
import { registerMe } from './http/me';
import { registerOps } from './http/ops';
import { registerWorkflows } from './http/workflows';
import { registerAutomations } from './http/automations';
import { registerEmbeddedSignup } from './http/embedded-signup';
import { registerApiKeys } from './http/api-keys';
import { registerV1Contacts } from './http/v1-contacts';
import { registerV1Sends } from './http/v1-sends';
import { registerHubspotImport } from './http/hubspot-import';
import { registerHubspotPipelines } from './http/hubspot-pipelines';
import { registerHubspotInstall } from './http/hubspot-install';
import { registerMba } from './http/mba';
import { registerEmailRoutes } from './http/email';
import { registerAuth } from './auth/routes';
import { makeRequireAuth, makeRequireRole } from './auth/middleware';
import { makeRequireApiKey, requireScope } from './auth/api-key';
import { RateLimiter } from './auth/rate-limit';
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
import type { MediaRouteDeps } from './http/media';
import type { TagsRouteDeps } from './http/tags';
import type { FieldsRouteDeps } from './http/fields';
import type { SupportRouteDeps } from './http/support';
import type { ContactsRouteDeps } from './http/contacts';
import type { AccountRouteDeps } from './http/account';
import type { MeRouteDeps } from './http/me';
import type { OpsRouteDeps } from './http/ops';
import type { WorkflowRouteDeps } from './http/workflows';
import type { AutomationRouteDeps } from './http/automations';
import type { EmbeddedSignupRouteDeps } from './http/embedded-signup';
import type { ApiKeysRouteDeps } from './http/api-keys';
import type { V1ContactsRouteDeps } from './http/v1-contacts';
import type { V1SendsRouteDeps } from './http/v1-sends';
import type { HubspotImportRouteDeps } from './http/hubspot-import';
import type { HubspotPipelinesRouteDeps } from './http/hubspot-pipelines';
import type { HubspotInstallRouteDeps } from './http/hubspot-install';
import type { MbaRouteDeps } from './http/mba';
import type { EmailRoutesDeps } from './http/email';
import type { ApiKeyLookup } from './auth/api-key-store.pg';
import type { Queue } from './queue/queue';

export interface ServerDeps {
  queue: Queue;
  /** Sonde de readiness (DB joignable ?). OPTIONNEL pour préserver le design DB-free de buildServer : absent
   *  (tests) -> /health répond 200 inconditionnel. Fourni (prod) -> /health = readiness (503 si rejette). */
  checkReadiness?: () => Promise<void>;
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
  /** Canal ENTRANT depuis le connecteur HubSpot (changement d'étape d'un deal). Fourni si le secret partagé
   *  est configuré. Signé, PAS authentifié par jeton utilisateur : l'appelant est un service, pas un humain. */
  hubspotEvents?: HubspotEventRouteDeps;
  /** Stats du dashboard (séries 1 pt/jour). */
  stats?: StatsRouteDeps;
  /** Réglages tenant (toggle MBA). */
  settings?: SettingsRouteDeps;
  /** Gestion des comptes (onglet Admin) — réservé aux admins. */
  admin?: UsersRouteDeps;
  /** Tableaux enregistrés d'Analytics > Mes tableaux — réservé aux admins. */
  workflowReports?: WorkflowReportsRouteDeps;
  /** WhatsApp Flows (constructeur de formulaire) — réservé aux admins. */
  flows?: FlowRouteDeps;
  /** Upload d'image (headers de cartes carousel) — réservé aux admins. */
  media?: MediaRouteDeps;
  /** Gestion des tags (menu Contenu) — réservé aux admins. */
  tags?: TagsRouteDeps;
  /** Gestion des user fields (menu Contenu) — réservé aux admins. */
  fields?: FieldsRouteDeps;
  /** Formulaire de support (envoi email via Resend) — tout compte authentifié. */
  support?: SupportRouteDeps;
  /** Édition d'un contact (fields/tags depuis la fiche) — réservé aux admins. */
  contacts?: ContactsRouteDeps;
  /** Statut du compte WhatsApp (page Accueil : numéro + pastille) — réservé aux admins. */
  account?: AccountRouteDeps;
  /** Profil de l'utilisateur courant (Accueil : « Bonjour {prénom} ») — tout compte authentifié. */
  me?: MeRouteDeps;
  /** Surface d'exploitation cross-tenant `/ops` (lecture seule) — protégée par OPS_TOKEN, pas le JWT. */
  ops?: OpsRouteDeps;
  /** Secret de `/ops`. Défaut : config.OPS_TOKEN. Vide -> /ops répond 401. Injectable en test. */
  opsToken?: string;
  /** Bot builder (workflows) — réservé aux admins. */
  workflows?: WorkflowRouteDeps;
  /** Automations (Lot E) : lecture ouverte aux comptes authentifiés, ÉCRITURES admin-only (garde dans la route). */
  automations?: AutomationRouteDeps;
  /** Embedded Signup Meta (connexion du numéro, Tech Provider) — réservé aux admins. */
  embeddedSignup?: EmbeddedSignupRouteDeps;
  /** CRUD des clés d'API (console admin, JWT) — réservé aux admins. */
  apiKeys?: ApiKeysRouteDeps;
  /** API publique /v1 (authentifiée par clé d'API, autorité SÉPARÉE du JWT, comme /ops). */
  v1?: { apiKeys: ApiKeyLookup; contacts: V1ContactsRouteDeps; sends?: V1SendsRouteDeps };
  /** Import de listes HubSpot (3e source de campagne) — réservé aux admins. */
  hubspotImport?: HubspotImportRouteDeps;
  /** Émission du lien d'install/re-consentement HubSpot signé — réservé aux admins. */
  hubspotInstall?: HubspotInstallRouteDeps;
  /** Étapes de deal du portail HubSpot (menu de l'écran Automation) — réservé aux admins. */
  hubspotPipelines?: HubspotPipelinesRouteDeps;
  /** Configuration de l'agent MBA (connaissance, personnalité, réglages) — réservé aux admins. */
  mba?: MbaRouteDeps;
  /** Node « Envoi de mail » (boîtes SMTP + modèles) — réservé aux admins, comme workflows. */
  email?: EmailRoutesDeps;
}

/**
 * Construit l'instance Fastify (le bouclier). La file et les stores sont injectés pour
 * rester testable sans DB. Les routes tenant (import/campaigns) EXIGENT l'auth : le tenant
 * est dérivé du JWT, jamais de l'URL.
 */
export function buildServer(deps: ServerDeps): FastifyInstance {
  if ((deps.import || deps.campaigns || deps.admin || deps.flows || deps.templates || deps.support || deps.contacts || deps.account || deps.me || deps.workflows || deps.embeddedSignup || deps.apiKeys || deps.hubspotImport || deps.hubspotInstall || deps.hubspotPipelines || deps.mba || deps.email) && !deps.auth) {
    // Ces routes lisent req.auth (userId/tenant) ; sans auth, scopeTenant/forbidNonAdmin dégénèrent.
    throw new Error('buildServer: `auth` requis dès que les routes import/campaigns/admin/flows/templates/support/contacts sont exposées');
  }

  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });

  // Enveloppe d'erreur uniforme { error } et pas de fuite du message interne sur les 5xx.
  app.setErrorHandler((err: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    // Erreur remontée de l'API Meta (token expiré, template invalide...) -> 422 + message clair.
    // 422 (4xx) et non 502 : Cloudflare/NPM remplacent les 5xx de l'origine par leur propre page
    // « error code: 502 », ce qui masque le message Meta utile. Un 4xx passe tel quel avec le body.
    if (err instanceof MetaApiError) {
      // Préférer le message UTILISATEUR de Meta (`error_user_msg`) au générique « Invalid parameter » :
      // ex. suppression d'un exemple de template -> « Les exemples de modèles ne peuvent pas être supprimés ».
      const friendly = err.userMessage ?? err.message;
      const detail = friendly.replace(/\s+/g, ' ').trim().slice(0, 200);
      return reply.code(422).send({ error: `Meta: ${detail}` });
    }
    // flow_json refusé par Meta à la création : 422 + les erreurs de validation (pas un 500 opaque).
    if (err instanceof FlowJsonInvalidError) {
      return reply.code(422).send({ error: err.message.slice(0, 200) });
    }
    const code = err.statusCode ?? 500;
    // JOURNALISER AVANT DE MASQUER. Le corps renvoyé au client reste volontairement opaque sur les 5xx (pas
    // de fuite d'interne), mais l'exception doit laisser une trace exploitable côté serveur : sans ça, une
    // saturation du pool, une erreur SQL ou un bug de sérialisation produisaient un « Internal Server Error »
    // dont il ne restait RIEN nulle part, et on ne pouvait que constater le symptôme depuis le navigateur.
    // `console.error` et non `req.log` : Fastify est construit en `logger: false`, donc `req.log` est un no-op.
    if (code >= 500) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({
        lvl: 'error',
        msg: 'unhandled_route_error',
        method: req.method,
        url: req.url,
        tenant: req.auth?.tenantId ?? null,
        err: err.message,
        stack: err.stack,
      }));
    }
    reply.code(code).send({ error: code < 500 ? err.message : 'Internal Server Error' });
  });

  // LIVENESS : le process répond (event loop non bloqué). Zéro DB, zéro dep -> cible d'un healthcheck/restart.
  // Ne JAMAIS y toucher la DB, sinon il devient une 2e readiness et perd son sens (« process vivant » ≠ « DB joignable »).
  app.get('/live', async () => ({ ok: true }));

  // READINESS : la DB est-elle joignable ? 503 si non (pool saturé / pooler injoignable), pour un monitoring externe.
  // On CATCHE et on `reply.code(503)` DANS le handler : un throw serait converti en 500 par setErrorHandler ci-dessus.
  // Sans checkReadiness (tests DB-free), on conserve le 200 inconditionnel d'avant (contrat de test préservé).
  app.get('/health', async (_req, reply) => {
    if (!deps.checkReadiness) return { ok: true, service: 'messagingme-mba', ts: Date.now() };
    try {
      await deps.checkReadiness();
      return { ok: true, service: 'messagingme-mba', ts: Date.now() };
    } catch {
      return reply.code(503).send({ ok: false, service: 'messagingme-mba', ts: Date.now() });
    }
  });

  registerReceiver(app, deps.queue, {
    verifyToken: deps.verifyToken ?? config.META_VERIFY_TOKEN,
    appSecret: deps.appSecret ?? config.META_APP_SECRET,
  });

  // Surface /ops : autorité SÉPARÉE du JWT (secret d'env, comme le webhook). Montée dès que les deps
  // sont fournies ; le guard renvoie 401 si OPS_TOKEN est vide (désactivé) ou incorrect.
  if (deps.ops) registerOps(app, deps.ops, deps.opsToken ?? config.OPS_TOKEN);

  const requireAuth = deps.auth ? makeRequireAuth(deps.auth.secret, deps.auth.getUserState) : undefined;
  // RBAC : tout est réservé aux admins SAUF l'inbox (le seul périmètre de l'agent). La barrière
  // est au preHandler (source de vérité serveur) ; l'UI ne fait que masquer/rediriger en confort.
  const requireAdmin = requireAuth ? [requireAuth, makeRequireRole(['admin'])] : undefined;
  if (deps.auth) registerAuth(app, deps.auth, requireAuth);
  if (deps.import) registerImport(app, deps.import, requireAdmin);
  if (deps.campaigns) registerCampaigns(app, deps.campaigns, requireAdmin);
  // Templates : la LISTE (GET) doit rester lisible par l'agent — l'inbox en a besoin pour envoyer
  // un template hors fenêtre 24h (seul moyen de re-contacter). La CRÉATION (POST) reste admin-only
  // via le forbidNonAdmin dans le handler. La page /templates de gestion est masquée à l'agent côté UI.
  if (deps.templates) registerTemplates(app, deps.templates, requireAuth);
  if (deps.inbox) registerInbox(app, deps.inbox, requireAuth);
  if (deps.hubspotEvents) registerHubspotEvents(app, deps.hubspotEvents);
  if (deps.stats) registerStats(app, deps.stats, requireAdmin);
  if (deps.settings) registerSettings(app, deps.settings, requireAdmin);
  if (deps.admin) registerUsers(app, deps.admin, requireAdmin);
  if (deps.flows) registerFlows(app, deps.flows, requireAdmin);
  if (deps.media) registerMedia(app, deps.media, requireAdmin);
  if (deps.tags) registerTags(app, deps.tags, requireAdmin);
  if (deps.fields) registerFields(app, deps.fields, requireAdmin);
  if (deps.support) registerSupport(app, deps.support, requireAuth);
  if (deps.contacts) registerContacts(app, deps.contacts, requireAdmin);
  if (deps.workflows) registerWorkflows(app, deps.workflows, requireAdmin);
  if (deps.workflowReports) registerWorkflowReports(app, deps.workflowReports, requireAdmin);
  if (deps.automations) registerAutomations(app, deps.automations, requireAuth);
  if (deps.embeddedSignup) registerEmbeddedSignup(app, deps.embeddedSignup, requireAdmin);
  if (deps.hubspotImport) registerHubspotImport(app, deps.hubspotImport, requireAdmin);
  if (deps.hubspotInstall) registerHubspotInstall(app, deps.hubspotInstall, requireAdmin);
  if (deps.hubspotPipelines) registerHubspotPipelines(app, deps.hubspotPipelines, requireAdmin);
  if (deps.mba) registerMba(app, deps.mba, requireAdmin);
  if (deps.email) registerEmailRoutes(app, deps.email, requireAdmin);
  if (deps.apiKeys) registerApiKeys(app, deps.apiKeys, requireAdmin);
  // API publique /v1 : autorité SÉPARÉE (clé d'API), montée comme /ops. Le rate limiter est un SINGLETON
  // (partagé entre requêtes). Chaque route compose [requireApiKey, requireScope('<scope>')].
  if (deps.v1) {
    const apiLimiter = new RateLimiter(config.API_KEY_RATE_LIMIT_MAX, config.API_KEY_RATE_LIMIT_WINDOW_MS);
    const requireApiKey = makeRequireApiKey(deps.v1.apiKeys, apiLimiter);
    registerV1Contacts(app, deps.v1.contacts, [requireApiKey, requireScope('contacts:write')]);
    if (deps.v1.sends) registerV1Sends(app, deps.v1.sends, [requireApiKey, requireScope('sends:create')]);
  }
  // Accueil : statut compte réservé aux admins (la page /accueil est admin-only) ; /me ouvert à tout
  // compte authentifié (générique, lit req.auth.userId).
  if (deps.account) registerAccount(app, deps.account, requireAdmin);
  if (deps.me) registerMe(app, deps.me, requireAuth);

  return app;
}
