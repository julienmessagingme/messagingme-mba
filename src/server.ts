import Fastify from 'fastify';
import cors from '@fastify/cors';
import type { SurveillanceOps } from './ops/tentatives';
import type { FastifyInstance, FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config';
import { registerReceiver } from './webhooks/receiver';
import { registerImport } from './http/import';
import { registerCampaigns } from './http/campaigns';
import { registerRcsMessages } from './http/rcs-messages';
import { registerRcsChannel } from './http/rcs-channel';
import { registerRcsCallback } from './http/rcs-callback';
import { registerRcsMedia } from './http/rcs-media';
import { registerTemplates } from './http/templates';
import { registerInbox } from './http/inbox';
import { registerHubspotEvents, type HubspotEventRouteDeps } from './http/hubspot-events';
import { registerStats } from './http/stats';
import { registerSettings } from './http/settings';
import { registerUsers } from './http/users';
import { registerFlows } from './http/flows';
import { registerAgents } from './http/agents';
import { registerAgentKnowledge } from './http/agent-knowledge';
import { registerAgentTools } from './http/agent-tools';
import { registerAgentCatalogue } from './http/agent-catalogue';
import { registerMbaPublication } from './http/mba-publication';
import type { MbaPublicationDeps } from './http/mba-publication';
import type { AgentCatalogueRouteDeps } from './http/agent-catalogue';
import { registerAgentSources, type AgentSourcesRouteDeps } from './http/agent-sources';
import { registerAgentRequetes, type AgentRequetesRouteDeps } from './http/agent-requetes';
import { registerAgentSetup } from './http/agent-setup';
import { registerAgentTest } from './http/agent-test';
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
import { registerChannelsMeRoutes, type ChannelsMeRouteDeps } from './http/channels-me';
import { registerEmbeddedSignup } from './http/embedded-signup';
import { registerApiKeys } from './http/api-keys';
import { registerV1Contacts } from './http/v1-contacts';
import { registerV1Sends } from './http/v1-sends';
import { registerMcp } from './http/mcp';
import type { DepsMcp } from './mcp/outils';
import { registerHubspotImport } from './http/hubspot-import';
import { registerHubspotPipelines } from './http/hubspot-pipelines';
import { registerHubspotInstall } from './http/hubspot-install';
import { registerLinks } from './http/links';
import { registerWebhookEntrant } from './http/webhook-entrant';
import type { WebhookEntrantRouteDeps } from './http/webhook-entrant';
import { registerWebhooksAdmin } from './http/webhooks-admin';
import type { WebhooksAdminRouteDeps } from './http/webhooks-admin';
import type { LinksRouteDeps } from './http/links';
import { registerMba } from './http/mba';
import { registerEmailRoutes } from './http/email';
import { registerAuth } from './auth/routes';
import { makeRequireAuth, makeRequireRole, makeLimiteParTenant } from './auth/middleware';
import { makeRequireApiKey, requireScope } from './auth/api-key';
import { RateLimiter } from './auth/rate-limit';
import { MetaApiError } from './meta/errors';
import { FlowJsonInvalidError } from './meta/flows';
import type { AuthRouteDeps } from './auth/routes';
import type { ImportRouteDeps } from './http/import';
import type { CampaignRouteDeps } from './http/campaigns';
import type { RcsMessageRouteDeps } from './http/rcs-messages';
import type { RcsChannelRouteDeps } from './http/rcs-channel';
import type { RcsCallbackRouteDeps } from './http/rcs-callback';
import type { RcsMediaRouteDeps } from './http/rcs-media';
import type { TemplateRouteDeps } from './http/templates';
import type { InboxRouteDeps } from './http/inbox';
import type { StatsRouteDeps } from './http/stats';
import type { SettingsRouteDeps } from './http/settings';
import type { UsersRouteDeps } from './http/users';
import type { FlowRouteDeps } from './http/flows';
import type { AgentsRouteDeps } from './http/agents';
import type { AgentKnowledgeRouteDeps } from './http/agent-knowledge';
import type { AgentToolsRouteDeps } from './http/agent-tools';
import type { AgentSetupRouteDeps } from './http/agent-setup';
import type { AgentTestRouteDeps } from './http/agent-test';
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
import { ENTETES_SECURITE_API } from './http/entetes-securite';

export interface ServerDeps {
  /**
   * Origines autorisées à appeler cette API depuis un navigateur. Vide ou absent -> AUCUN en-tête CORS n'est
   * posé, ce qui est le comportement d'avant la bascule et le bon défaut : le front servi par le même hôte
   * n'en a aucun besoin.
   */
  corsOrigins?: readonly string[];
  /**
   * Surveillance des refus sur `/ops`. Absente -> un 401 part sans laisser de trace, ce qui est le
   * comportement d'avant. Câblée par `src/index.ts` quand Telegram est configuré.
   */
  surveillanceOps?: SurveillanceOps;
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
  /**
   * Plafonds de débit des routes authentifiées, en appels par minute. Absents -> les valeurs de `config`
   * (`RATE_LIMIT_USER_PAR_MINUTE`, `RATE_LIMIT_COUTEUX_PAR_MINUTE`). 0 désactive le plafond concerné.
   * Injectables pour que les tests puissent viser un plafond bas sans dépendre de l'environnement.
   */
  plafonds?: { utilisateurParMinute?: number; couteuxParMinute?: number };
  /** Routes CRM/import (enregistrées seulement si fournies -> tests DB-free du receiver). */
  import?: ImportRouteDeps;
  /** Routes campagnes (enregistrées seulement si fournies). */
  campaigns?: CampaignRouteDeps;
  /** Bibliothèque de messages RCS (Contenu). Lecture ouverte au tenant, écritures admin-only. */
  rcsMessages?: RcsMessageRouteDeps;
  /** Activation du canal RCS d'un workspace (page d'accueil). Écritures admin-only. */
  rcsChannel?: RcsChannelRouteDeps;
  /** Rappels smsmode du canal RCS (livraison + réponses). PUBLIQUE : le code d'URL porte le workspace. */
  rcsCallback?: RcsCallbackRouteDeps;
  /** Visuels des messages RCS : téléversement admin, et service PUBLIC du fichier (`/m/<code>.jpg`). */
  rcsMedia?: RcsMediaRouteDeps;
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
  /** Agents IA du workspace, EN LECTURE : la palette du builder en a besoin pour proposer le bloc. */
  agents?: AgentsRouteDeps;
  agentKnowledge?: AgentKnowledgeRouteDeps;
  agentTools?: AgentToolsRouteDeps;
  /** La BIBLIOTHÈQUE d'outils de l'espace (migration 0127) : les définitions, et qui s'en sert. */
  agentCatalogue?: AgentCatalogueRouteDeps;
  /** Publication du catalogue d'outils chez Meta : l'aperçu, puis l'exécution. */
  mbaPublication?: MbaPublicationDeps;
  agentSources?: AgentSourcesRouteDeps;
  agentRequetes?: AgentRequetesRouteDeps;
  agentSetup?: AgentSetupRouteDeps;
  agentTest?: AgentTestRouteDeps;
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
  v1?: { apiKeys: ApiKeyLookup; contacts: V1ContactsRouteDeps; sends?: V1SendsRouteDeps; mcp?: DepsMcp };
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
  /**
   * Redirection PUBLIQUE des liens tracés (`GET /r/:code`). Aucune authentification : c'est un destinataire
   * WhatsApp qui l'ouvre. Le tenant vient du code retrouvé en base, jamais de l'URL.
   */
  links?: LinksRouteDeps;
  /**
   * Réception PUBLIQUE des webhooks entrants (`POST /w/:code`). Aucune authentification : c'est un outil
   * tiers qui poste. Le tenant vient du code retrouvé en base, jamais du corps.
   */
  webhookEntrant?: WebhookEntrantRouteDeps;
  /** Gestion des webhooks entrants (écran Tools > Webhooks) — réservé aux admins. */
  webhooksAdmin?: WebhooksAdminRouteDeps;
  /** Chaine WhatsApp (Channels Me) : lecture ouverte aux comptes authentifies, ECRITURES admin-only (garde dans la route). */
  channelsMe?: ChannelsMeRouteDeps;
}

/**
 * Construit l'instance Fastify (le bouclier). La file et les stores sont injectés pour
 * rester testable sans DB. Les routes tenant (import/campaigns) EXIGENT l'auth : le tenant
 * est dérivé du JWT, jamais de l'URL.
 */
export function buildServer(deps: ServerDeps): FastifyInstance {
  /**
   * 🔴 AUCUNE ROUTE PORTANT `:tenantId` NE SE MONTE SANS AUTHENTIFICATION. La liste couvrait 18 modules sur
   * 36 (audit de surface publique du 2026-09-03) : les 18 autres se seraient montés sans garde, en silence,
   * et `scopeTenant` aurait alors distribué à chacun l'espace qu'il demandait dans l'URL.
   *
   * ⚠️ Ce garde-fou et la fermeture de `scopeTenant` (`src/http/scope.ts`) sont les DEUX moitiés du même
   * correctif, et il faut les deux. Sans le garde-fou, l'oubli passe au démarrage et se voit en 403 partout,
   * c'est-à-dire trop tard. Sans la fermeture, le garde-fou ne couvre que les modules qu'on a pensé à y
   * inscrire, et il faudra y penser encore au 37e. `tests/scope-tenant.test.ts` garde la liste complète.
   */
  const modulesTenant = [
    deps.import, deps.campaigns, deps.admin, deps.flows, deps.templates, deps.support, deps.contacts,
    deps.account, deps.me, deps.workflows, deps.embeddedSignup, deps.apiKeys, deps.hubspotImport,
    deps.hubspotInstall, deps.hubspotPipelines, deps.mba, deps.email, deps.webhooksAdmin, deps.agentCatalogue, deps.mbaPublication,
    deps.inbox, deps.stats, deps.settings, deps.rcsMessages, deps.rcsChannel, deps.rcsMedia, deps.media,
    deps.tags, deps.fields, deps.workflowReports, deps.automations, deps.agents, deps.agentKnowledge,
    deps.agentTools, deps.agentSources, deps.agentRequetes, deps.agentSetup, deps.agentTest,
    deps.channelsMe,
  ];
  if (modulesTenant.some((m) => m !== undefined) && !deps.auth) {
    // Ces routes lisent req.auth (userId/tenant) ; sans auth, scopeTenant refuse tout et le service est mort
    // en silence. Mieux vaut refuser de démarrer que servir 403 sur tout un espace.
    throw new Error('buildServer: `auth` est requis dès qu’un module exposant des routes `:tenantId` est monté');
  }

  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });

  /**
   * 🔴 LE CORS, ET SES DEUX RÈGLES NON NÉGOCIABLES (préparation de la bascule Vercel, 2026-09-03).
   *
   * Il n'existe QUE parce que le front part sur son propre nom : tant que le navigateur appelait la même
   * origine, le CORS n'avait aucun rôle. Il n'est donc posé QUE si une origine est explicitement inscrite,
   * et il est absent sinon. Une porte qu'on n'ouvre pas est une porte qu'on n'a pas à surveiller.
   *
   * 1. LISTE BLANCHE, jamais `*`. Le refus de l'étoile est dans `src/config.ts`, au chargement, parce qu'un
   *    réglage qui ouvre tout doit échouer au démarrage et pas se découvrir en lisant les logs.
   * 2. AUCUN `credentials`. La session de cette console voyage dans un en-tête `Authorization`, jamais dans
   *    un cookie : il n'y a donc AUCUN CSRF possible aujourd'hui. Activer les credentials en créerait un de
   *    toutes pièces, pour un besoin qui n'existe pas. C'est le piège classique de cette migration.
   *
   * `x-ops-token` est dans les en-têtes autorisés parce que l'écran d'exploitation le pose lui-même : sans
   * lui, la requête préalable du navigateur échouerait et `/ops` serait muet depuis le nouveau front.
   */
  /**
   * Les en-têtes de sécurité, sur CHAQUE réponse.
   *
   * `onSend` est le DERNIER point du cycle avant que la réponse parte : il couvre donc toute réponse quelle
   * que soit ce qui l'a produite, y compris celles qu'un hook antérieur rend directement sans jamais
   * atteindre la route (un refus de plafond de débit, un préalable CORS).
   *
   * ⚠️ MESURÉ, ET PLUS MODESTE QUE PRÉVU : j'avais écrit ici que `onRequest` manquerait les réponses
   * d'erreur. C'est FAUX pour la 404, vérifié par mutation le 2026-09-10 (le test passe avec les deux).
   * Fastify exécute bien ses hooks de requête sur le chemin « route introuvable ». `onSend` reste le choix
   * juste parce qu'il est en aval de tout, mais ce n'est pas lui qui répare la 404 : elle n'était pas
   * cassée. Le test, lui, garde ce qui compte vraiment, à savoir que les en-têtes sont là sur une erreur.
   */
  app.addHook('onSend', async (_req, reply, payload) => {
    for (const [nom, valeur] of Object.entries(ENTETES_SECURITE_API)) reply.header(nom, valeur);
    return payload;
  });

  const origines = deps.corsOrigins?.map((o) => o.trim()).filter((o) => o !== '') ?? [];
  if (origines.length > 0) {
    void app.register(cors, {
      origin: origines,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['authorization', 'content-type', 'x-ops-token'],
      // 🔴 Les en-têtes de plafond de débit, sans quoi la console NE PEUT PAS LES LIRE. Cross-origin, un
      // navigateur ne laisse JavaScript voir qu'une courte liste d'en-têtes sûrs ; `retry-after` et les
      // `x-ratelimit-*` n'en font pas partie. Ils partiraient bien sur le réseau, seraient visibles dans
      // l'onglet Réseau, et resteraient invisibles au code : « on sait qu'on est bloqué, jamais pour
      // combien de temps ». C'est un défaut qu'on impute au front alors qu'il vient d'ici.
      exposedHeaders: ['retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'],
      credentials: false,
      maxAge: 600,
    });
  }

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
    // Corps trop gros : Fastify répond « Request body is too large », en anglais et sans dire quoi faire.
    // C'est le mur que rencontre un opérateur qui importe un gros CSV (AUDIT-SCALE-2026-08-25.md, R9) : le
    // message doit être en français, et surtout dire l'issue (couper le fichier), pas seulement le refus.
    if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(413).send({ error: 'Fichier trop volumineux pour un seul envoi. Découpe-le en plusieurs fichiers plus petits et recommence.' });
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
  if (deps.ops) registerOps(app, deps.ops, deps.opsToken ?? config.OPS_TOKEN, deps.surveillanceOps);

  // Redirection des liens tracés : PUBLIQUE, montée ici avec le webhook et /ops, avant les gardes d'auth.
  // Aucune session n'est possible sur cette route (un destinataire clique depuis WhatsApp).
  if (deps.links) registerLinks(app, deps.links);

  // Réception des webhooks entrants : PUBLIQUE elle aussi, montée ici avant les gardes d'auth. Aucune session
  // n'est possible (l'appelant est un outil tiers, pas un humain).
  if (deps.webhookEntrant) registerWebhookEntrant(app, deps.webhookEntrant);

  // Rappels du fournisseur RCS : PUBLIQUE aussi, et pour la même raison (l'appelant est smsmode, pas un
  // humain). Ce qui l'autorise est le code opaque de l'URL, pas une session ; voir `registerRcsCallback`.
  if (deps.rcsCallback) registerRcsCallback(app, deps.rcsCallback);

  /**
   * LES DEUX PLAFONDS DE DÉBIT DES ROUTES AUTHENTIFIÉES.
   *
   * Le général est passé à `makeRequireAuth`, donc les 36 modules gardés en héritent d'un coup et un module
   * ajouté demain l'aura sans que personne y pense : c'est la même propriété que le garde-fou `scopeTenant`
   * ci-dessus. Le second est composé route par route sur les seules routes coûteuses.
   *
   * ⚠️ Les deux limiteurs sont LOCAUX AU PROCESS, comme tous ceux de ce dépôt. Le plafond annoncé est celui
   * d'UNE instance : `AUDIT-ARCHITECTURE-AUTOSCALING-2026-09-03.md` les nomme parmi les trois adhérences à
   * lever avant de passer à plusieurs replicas. Les porter en base coûterait une écriture Postgres par
   * requête, ce qui irait contre le but même de la garde.
   *
   * Un maximum à 0 rend le limiteur `undefined`, donc absent : c'est la trappe de secours si le calibrage se
   * révèle mauvais en production (cf. `config.ts`).
   */
  // ⚠️ AUCUN plafond de clés (4e argument laissé à son défaut), contrairement aux limiteurs de `/auth/*` et
  // de `/w/:code`. La règle de `rate-limit.ts` est « poser un plafond dès que la clé est choisie par
  // l'APPELANT » : ici elle vient d'un JWT VÉRIFIÉ, donc elle n'est pas libre, et un plafond ferait refuser
  // un utilisateur NEUF quand la table est pleine, c'est-à-dire punir un client légitime pour la charge des
  // autres. La fenêtre d'une minute suffit à borner la table : les entrées expirent et `prune` les retire.
  const parMinute = (max: number): RateLimiter | undefined =>
    max > 0 ? new RateLimiter(max, 60_000) : undefined;
  const plafondUtilisateur = parMinute(deps.plafonds?.utilisateurParMinute ?? config.RATE_LIMIT_USER_PAR_MINUTE);
  const limiteurCouteux = parMinute(deps.plafonds?.couteuxParMinute ?? config.RATE_LIMIT_COUTEUX_PAR_MINUTE);
  const limiteCouteuse = limiteurCouteux
    ? makeLimiteParTenant(limiteurCouteux, 'trop d’opérations lourdes sur cet espace, patientez une minute')
    : undefined;

  const requireAuth = deps.auth ? makeRequireAuth(deps.auth.secret, deps.auth.getUserState, plafondUtilisateur) : undefined;
  // RBAC : tout est réservé aux admins SAUF l'inbox (le seul périmètre de l'agent). La barrière
  // est au preHandler (source de vérité serveur) ; l'UI ne fait que masquer/rediriger en confort.
  const requireAdmin = requireAuth ? [requireAuth, makeRequireRole(['admin'])] : undefined;
  if (deps.auth) registerAuth(app, deps.auth, requireAuth);
  if (deps.import) registerImport(app, deps.import, requireAdmin, limiteCouteuse);
  if (deps.campaigns) registerCampaigns(app, deps.campaigns, requireAdmin, limiteCouteuse);
  // Bibliothèque RCS : montée avec `requireAuth` et non `requireAdmin`, car la LISTE doit être lisible par un
  // agent (le bloc de scénario et l'assistant de campagne la proposent). Les écritures sont gardées dans les
  // handlers par `forbidNonAdmin`, comme pour les templates.
  if (deps.rcsMessages) registerRcsMessages(app, deps.rcsMessages, requireAuth);
  if (deps.rcsChannel) registerRcsChannel(app, deps.rcsChannel, requireAuth);
  // Visuels RCS. Monté ICI (avec `requireAuth`) alors qu'il porte AUSSI une route publique `/m/<code>.<ext>` :
  // les gardes de ce projet sont posées par route (`preHandler`), pas par groupe, donc la route de lecture
  // reste ouverte comme elle doit l'être. C'est l'opérateur télécom qui télécharge l'image, sans session.
  if (deps.rcsMedia) registerRcsMedia(app, deps.rcsMedia, requireAuth);
  // Templates : la LISTE (GET) doit rester lisible par l'agent — l'inbox en a besoin pour envoyer
  // un template hors fenêtre 24h (seul moyen de re-contacter). La CRÉATION (POST) reste admin-only
  // via le forbidNonAdmin dans le handler. La page /templates de gestion est masquée à l'agent côté UI.
  if (deps.templates) registerTemplates(app, deps.templates, requireAuth);
  // Deux gardes : l'inbox est ouverte a tout compte authentifie, mais l'effacement du contenu d'une
  // conversation est reserve aux administrateurs. Un operateur repond aux clients, il n'efface pas des traces.
  if (deps.inbox) registerInbox(app, deps.inbox, requireAuth, requireAdmin, limiteCouteuse);
  if (deps.hubspotEvents) registerHubspotEvents(app, deps.hubspotEvents);
  if (deps.stats) registerStats(app, deps.stats, requireAdmin);
  if (deps.settings) registerSettings(app, deps.settings, requireAdmin);
  if (deps.admin) registerUsers(app, deps.admin, requireAdmin);
  if (deps.flows) registerFlows(app, deps.flows, requireAdmin);
  if (deps.agents) registerAgents(app, deps.agents, requireAdmin);
  if (deps.agentKnowledge) registerAgentKnowledge(app, deps.agentKnowledge, requireAdmin);
  if (deps.agentTools) registerAgentTools(app, deps.agentTools, requireAdmin);
  if (deps.agentCatalogue) registerAgentCatalogue(app, deps.agentCatalogue, requireAdmin);
  if (deps.mbaPublication) registerMbaPublication(app, deps.mbaPublication, requireAdmin);
  if (deps.agentSources) registerAgentSources(app, deps.agentSources, requireAdmin);
  // Reservees aux ADMINS comme les sources : decrire une requete, c est decider ce qu on envoie au systeme
  // d un client, et le bouton Test rend la reponse ENTIERE pour que le client y choisisse ses champs.
  if (deps.agentRequetes) registerAgentRequetes(app, deps.agentRequetes, requireAdmin);
  if (deps.agentSetup) registerAgentSetup(app, deps.agentSetup, requireAdmin);
  if (deps.agentTest) registerAgentTest(app, deps.agentTest, requireAdmin);
  if (deps.media) registerMedia(app, deps.media, requireAdmin);
  if (deps.tags) registerTags(app, deps.tags, requireAdmin);
  if (deps.fields) registerFields(app, deps.fields, requireAdmin);
  if (deps.support) registerSupport(app, deps.support, requireAuth);
  if (deps.contacts) registerContacts(app, deps.contacts, requireAdmin, limiteCouteuse);
  if (deps.workflows) registerWorkflows(app, deps.workflows, requireAdmin);
  if (deps.workflowReports) registerWorkflowReports(app, deps.workflowReports, requireAdmin);
  if (deps.automations) registerAutomations(app, deps.automations, requireAuth);
  // requireAuth et non requireAdmin : les ecrans de la chaine se LISENT avec un compte agent, et les six
  // ecritures sont fermees dans la route par `forbidNonAdmin`.
  if (deps.channelsMe) registerChannelsMeRoutes(app, deps.channelsMe, requireAuth);
  if (deps.embeddedSignup) registerEmbeddedSignup(app, deps.embeddedSignup, requireAdmin);
  if (deps.hubspotImport) registerHubspotImport(app, deps.hubspotImport, requireAdmin);
  if (deps.hubspotInstall) registerHubspotInstall(app, deps.hubspotInstall, requireAdmin);
  if (deps.hubspotPipelines) registerHubspotPipelines(app, deps.hubspotPipelines, requireAdmin);
  if (deps.mba) registerMba(app, deps.mba, requireAdmin);
  if (deps.email) registerEmailRoutes(app, deps.email, requireAdmin);
  if (deps.apiKeys) registerApiKeys(app, deps.apiKeys, requireAdmin);
  if (deps.webhooksAdmin) registerWebhooksAdmin(app, deps.webhooksAdmin, requireAdmin);
  // API publique /v1 : autorité SÉPARÉE (clé d'API), montée comme /ops. Le rate limiter est un SINGLETON
  // (partagé entre requêtes). Chaque route compose [requireApiKey, requireScope('<scope>')].
  if (deps.v1) {
    const apiLimiter = new RateLimiter(config.API_KEY_RATE_LIMIT_MAX, config.API_KEY_RATE_LIMIT_WINDOW_MS);
    const requireApiKey = makeRequireApiKey(deps.v1.apiKeys, apiLimiter);
    registerV1Contacts(app, deps.v1.contacts, [requireApiKey, requireScope('contacts:write')]);
    if (deps.v1.sends) registerV1Sends(app, deps.v1.sends, [requireApiKey, requireScope('sends:create')]);
    // Serveur MCP : MÊME autorité et MÊME limiteur de débit que /v1. Il partage volontairement le
    // `requireApiKey` déjà construit : une seconde instance de limiteur aurait doublé le quota d'une clé
    // selon la porte empruntée, ce qui n'aurait été visible de personne.
    //
    // Pas de `requireScope` ici : le serveur MCP a DEUX scopes (lecture, écriture) et c'est l'outil appelé
    // qui décide duquel il a besoin. Un `requireScope` à la porte aurait forcé à en choisir un des deux, et
    // donc soit fermé l'écriture, soit ouvert la lecture aux seules clés qui écrivent.
    if (deps.v1.mcp) registerMcp(app, deps.v1.mcp, [requireApiKey]);
  }
  // Accueil : statut compte réservé aux admins (la page /accueil est admin-only) ; /me ouvert à tout
  // compte authentifié (générique, lit req.auth.userId).
  if (deps.account) registerAccount(app, deps.account, requireAdmin);
  if (deps.me) registerMe(app, deps.me, requireAuth);

  return app;
}
