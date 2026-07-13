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
import { registerMedia } from './http/media';
import { registerTags } from './http/tags';
import { registerFields } from './http/fields';
import { registerSupport } from './http/support';
import { registerContacts } from './http/contacts';
import { registerAccount } from './http/account';
import { registerMe } from './http/me';
import { registerOps } from './http/ops';
import { registerWorkflows } from './http/workflows';
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
import type { MediaRouteDeps } from './http/media';
import type { TagsRouteDeps } from './http/tags';
import type { FieldsRouteDeps } from './http/fields';
import type { SupportRouteDeps } from './http/support';
import type { ContactsRouteDeps } from './http/contacts';
import type { AccountRouteDeps } from './http/account';
import type { MeRouteDeps } from './http/me';
import type { OpsRouteDeps } from './http/ops';
import type { WorkflowRouteDeps } from './http/workflows';
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
}

/**
 * Construit l'instance Fastify (le bouclier). La file et les stores sont injectés pour
 * rester testable sans DB. Les routes tenant (import/campaigns) EXIGENT l'auth : le tenant
 * est dérivé du JWT, jamais de l'URL.
 */
export function buildServer(deps: ServerDeps): FastifyInstance {
  if ((deps.import || deps.campaigns || deps.admin || deps.flows || deps.templates || deps.support || deps.contacts || deps.account || deps.me || deps.workflows) && !deps.auth) {
    // Ces routes lisent req.auth (userId/tenant) ; sans auth, scopeTenant/forbidNonAdmin dégénèrent.
    throw new Error('buildServer: `auth` requis dès que les routes import/campaigns/admin/flows/templates/support/contacts sont exposées');
  }

  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });

  // Enveloppe d'erreur uniforme { error } et pas de fuite du message interne sur les 5xx.
  app.setErrorHandler((err: FastifyError, _req: FastifyRequest, reply: FastifyReply) => {
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

  // Surface /ops : autorité SÉPARÉE du JWT (secret d'env, comme le webhook). Montée dès que les deps
  // sont fournies ; le guard renvoie 401 si OPS_TOKEN est vide (désactivé) ou incorrect.
  if (deps.ops) registerOps(app, deps.ops, deps.opsToken ?? config.OPS_TOKEN);

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
  if (deps.media) registerMedia(app, deps.media, requireAdmin);
  if (deps.tags) registerTags(app, deps.tags, requireAdmin);
  if (deps.fields) registerFields(app, deps.fields, requireAdmin);
  if (deps.support) registerSupport(app, deps.support, requireAuth);
  if (deps.contacts) registerContacts(app, deps.contacts, requireAdmin);
  if (deps.workflows) registerWorkflows(app, deps.workflows, requireAdmin);
  // Accueil : statut compte réservé aux admins (la page /accueil est admin-only) ; /me ouvert à tout
  // compte authentifié (générique, lit req.auth.userId).
  if (deps.account) registerAccount(app, deps.account, requireAdmin);
  if (deps.me) registerMe(app, deps.me, requireAuth);

  return app;
}
