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
import { registerIntegrationBatch } from './http/integration-batch';
import { registerSalesforce } from './http/salesforce';
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
import { registerMbaOutils } from './http/mba-outils';
import { registerMbaAssistant } from './http/mba-assistant';
import { registerHistorique } from './http/historique';
import type { HistoriqueRouteDeps } from './http/historique';
import type { MbaAssistantDeps } from './http/mba-assistant';
import type { MbaPublicationDeps } from './http/mba-publication';
import type { MbaOutilsDeps } from './http/mba-outils';
import { registerPubs, type PubsRouteDeps } from './http/pubs';
import type { AgentCatalogueRouteDeps } from './http/agent-catalogue';
import { registerAgentSources, type AgentSourcesRouteDeps } from './http/agent-sources';
import { registerAgentMcp, type AgentMcpRouteDeps } from './http/agent-mcp';
import { registerAgentRequetes, type AgentRequetesRouteDeps } from './http/agent-requetes';
import { registerAgentSetup } from './http/agent-setup';
import { registerAgentTest } from './http/agent-test';
import { registerMedia } from './http/media';
import { registerTags } from './http/tags';
import { registerFields } from './http/fields';
import { registerSupport } from './http/support';
import { registerAide, type AideRouteDeps } from './http/aide';
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
import { registerV1Catalogues } from './http/v1-catalogues';
import type { V1CataloguesRouteDeps } from './http/v1-catalogues';
import { registerV1Messages } from './http/v1-messages';
import type { V1MessagesRouteDeps } from './http/v1-messages';
import { registerV1MessagesRcs } from './http/v1-messages-rcs';
import type { V1MessagesRcsRouteDeps } from './http/v1-messages-rcs';
import { registerMcp } from './http/mcp';
import { registerMbaRelais, type MbaRelaisDeps } from './http/mba-relais';
import { DROIT_RELAIS } from './mba/cle-relais';
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
import { makeRequireAuth, makeRequireRole, makeLimiteParTenant, makeRequireOps } from './auth/middleware';
import type { Guard, PreHandler } from './auth/middleware';
import { monterAvecEtapeEspace } from './http/scope';
import { makeRequireApiKey, requireScope } from './auth/api-key';
import { RateLimiter } from './auth/rate-limit';
import { PlafondEspace, ReglagesPlafondEnCache, SANS_REGLAGE, type PlafondApiStore } from './auth/plafond-espace';
import { registerOpsPlafondApi } from './http/ops-plafond-api';
import { MetaApiError } from './meta/errors';
import { FlowJsonInvalidError } from './meta/flows';
import type { AuthRouteDeps } from './auth/routes';
import type { ImportRouteDeps } from './http/import';
import type { CampaignRouteDeps } from './http/campaigns';
import type { RcsMessageRouteDeps } from './http/rcs-messages';
import type { RcsChannelRouteDeps } from './http/rcs-channel';
import type { IntegrationBatchRouteDeps } from './http/integration-batch';
import type { SalesforceRouteDeps } from './http/salesforce';
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
import type { ApiUsageGuard } from './api/usage-guard';
import { GardeUsage } from './api/usage-guard.compteur';
import { memoireDesPleines, type CompteurDebit } from './db/debit';
import { CompteurDebitMemoire } from './db/debit.memoire';
import { PlafondPartage } from './auth/plafond-partage';
import { journaliser } from './lib/journal';

export interface ServerDeps {
  /**
   * Origines autorisées à appeler cette API depuis un navigateur. Vide ou absent -> aucun en-tête CORS, le
   * bon défaut : le front servi par le même hôte n'en a aucun besoin.
   */
  corsOrigins?: readonly string[];
  /**
   * Surveillance des refus sur `/ops`. Absente -> un 401 part sans laisser de trace. Câblée par
   * `src/index.ts` quand Telegram est configuré.
   */
  surveillanceOps?: SurveillanceOps;
  queue: Queue;
  /** Sonde de readiness (DB joignable ?). Optionnelle pour garder buildServer sans DB : absente (tests) ->
   *  /health répond 200 inconditionnel ; fournie (prod) -> /health = readiness (503 si elle rejette). */
  checkReadiness?: () => Promise<void>;
  /** Défaut : config.META_VERIFY_TOKEN. Injectable en test. */
  verifyToken?: string;
  /** Défaut : config.META_APP_SECRET. Injectable en test. */
  appSecret?: string;
  /** Auth (login + secret JWT). Obligatoire dès qu'un module à routes `:tenantId` est exposé. */
  auth?: AuthRouteDeps;
  /**
   * Plafonds de débit des routes authentifiées, en appels par minute. Absents -> les valeurs de `config`
   * (`RATE_LIMIT_USER_PAR_MINUTE`, `RATE_LIMIT_COUTEUX_PAR_MINUTE`). 0 désactive le plafond concerné.
   * Injectables pour que les tests visent un plafond bas sans dépendre de l'environnement.
   * `apiParMinute` et `apiParHeure` : les défauts du plafond de l'API par espace (`API_PLAFOND_*`).
   */
  plafonds?: { utilisateurParMinute?: number; couteuxParMinute?: number; apiParMinute?: number; apiParHeure?: number };
  /**
   * Le réglage du plafond de l'API par espace. Ici plutôt que dans `v1` ou `ops` parce qu'il sert deux
   * consommateurs : le limiteur de `/v1` et `/mcp` le lit (à travers un cache court), la route
   * `/ops/plafond-api/:tenantId` l'écrit et vide ce même cache. Absent -> tous les espaces au défaut de la
   * configuration, et la route n'est pas montée.
   */
  plafondApi?: PlafondApiStore;
  /**
   * Le compteur des plafonds de débit PARTAGÉ par toutes les copies de l'API (`PgCompteurDebit`, migration 0186) :
   * l'API publique par espace, les opérations coûteuses, les tentatives de connexion et l'usage de `/ops/usage` y
   * comptent, donc un plafond est tenu au total et pas une fois par copie. `buildServer` le fait précéder de la
   * mémoire des fenêtres pleines de CETTE copie (`memoireDesPleines`).
   * 🔴 Absent -> un compteur en mémoire, celui d'une copie seule : c'est ce que veulent les tests, jamais la
   * production (`src/index.ts` le passe, tenu par `tests/debit-cablage.test.ts`).
   */
  debit?: CompteurDebit;
  /** Routes CRM/import (enregistrées seulement si fournies -> tests DB-free du receiver). */
  import?: ImportRouteDeps;
  /** Routes campagnes (enregistrées seulement si fournies). */
  campaigns?: CampaignRouteDeps;
  /** Bibliothèque de messages RCS (Contenu). Lecture ouverte au tenant, écritures admin-only. */
  rcsMessages?: RcsMessageRouteDeps;
  /** Activation du canal RCS d'un workspace (page d'accueil). Écritures admin-only. */
  rcsChannel?: RcsChannelRouteDeps;
  /** Paramètres > Intégrations > Batch : l'outil qui reçoit les signaux. Admin, lecture comprise. */
  integrationBatch?: IntegrationBatchRouteDeps;
  /**
   * Paramètres > Intégrations > Salesforce : l'interrupteur, la connexion de l'org, ses réglages. Admin,
   * lecture comprise. Monté seulement quand la clé d'app Salesforce est posée sur l'instance.
   */
  salesforce?: SalesforceRouteDeps;
  /** Rappels smsmode du canal RCS (livraison + réponses). Publique : le code d'URL porte le workspace. */
  rcsCallback?: RcsCallbackRouteDeps;
  /** Visuels des messages RCS : téléversement admin, et service public du fichier (`/m/<code>.jpg`). */
  rcsMedia?: RcsMediaRouteDeps;
  /** Routes templates (liste + création via l'API Meta). */
  templates?: TemplateRouteDeps;
  /** Routes inbox (conversations + réponse). */
  inbox?: InboxRouteDeps;
  /** Canal entrant depuis le connecteur HubSpot (changement d'étape d'un deal). Fourni si le secret partagé
   *  est configuré. Signé, pas authentifié par jeton utilisateur : l'appelant est un service, pas un humain. */
  hubspotEvents?: HubspotEventRouteDeps;
  /** Stats du dashboard (séries 1 pt/jour). */
  stats?: StatsRouteDeps;
  /** Réglages tenant (toggle MBA). */
  settings?: SettingsRouteDeps;
  /** Gestion des comptes (onglet Admin), réservé aux admins. */
  admin?: UsersRouteDeps;
  /** Tableaux enregistrés d'Analytics > Mes tableaux, réservé aux admins. */
  workflowReports?: WorkflowReportsRouteDeps;
  /** Agents IA du workspace, en lecture : la palette du builder en a besoin pour proposer le bloc. */
  agents?: AgentsRouteDeps;
  agentKnowledge?: AgentKnowledgeRouteDeps;
  agentTools?: AgentToolsRouteDeps;
  /** La bibliothèque d'outils de l'espace : les définitions, et qui s'en sert. */
  agentCatalogue?: AgentCatalogueRouteDeps;
  /** Publication du catalogue d'outils chez Meta : l'aperçu, puis l'exécution. */
  mbaPublication?: MbaPublicationDeps;
  /** L'onglet « Outils » de l'agent de Meta. */
  mbaOutils?: MbaOutilsDeps;
  /**
   * La connexion publicitaire d'un espace. Absente -> routes non montées, et l'écran lit le 404 comme « pas
   * encore configuré », ce qu'il est.
   */
  pubs?: PubsRouteDeps;
  /** L'assistant conversationnel du Meta Business Agent. Absent -> la route n'existe pas. */
  mbaAssistant?: MbaAssistantDeps;
  /** L'historique des réglages, partagé par le MBA et les agents IA. */
  historique?: HistoriqueRouteDeps;
  agentSources?: AgentSourcesRouteDeps;
  agentMcp?: AgentMcpRouteDeps;
  agentRequetes?: AgentRequetesRouteDeps;
  agentSetup?: AgentSetupRouteDeps;
  agentTest?: AgentTestRouteDeps;
  /** WhatsApp Flows (constructeur de formulaire), réservé aux admins. */
  flows?: FlowRouteDeps;
  /** Upload d'image (headers de cartes carousel), réservé aux admins. */
  media?: MediaRouteDeps;
  /** Gestion des tags (menu Contenu), réservé aux admins. */
  tags?: TagsRouteDeps;
  /** Gestion des user fields (menu Contenu), réservé aux admins. */
  fields?: FieldsRouteDeps;
  /** Formulaire de support (envoi email via Resend), tout compte authentifié. */
  support?: SupportRouteDeps;
  /** Le bot d'aide de la console : il explique et il emmène, il n'écrit jamais rien. */
  aide?: AideRouteDeps;
  /** Édition d'un contact (fields/tags depuis la fiche), réservé aux admins. */
  contacts?: ContactsRouteDeps;
  /** Statut du compte WhatsApp (page Accueil : numéro + pastille), réservé aux admins. */
  account?: AccountRouteDeps;
  /** Profil de l'utilisateur courant (Accueil : « Bonjour {prénom} »), tout compte authentifié. */
  me?: MeRouteDeps;
  /**
   * Surface d'exploitation cross-tenant `/ops`, protégée par la session d'exploitation nominative
   * (`makeRequireOps`), jamais par une session d'espace. Son autorité (secret, second facteur, `opsEmails`) est
   * celle de `auth` : sans `auth`, `/ops` refuse tout.
   */
  ops?: OpsRouteDeps;
  /** Bot builder (workflows), réservé aux admins. */
  workflows?: WorkflowRouteDeps;
  /** Automations : lecture ouverte aux comptes authentifiés, écritures admin-only (garde dans la route). */
  automations?: AutomationRouteDeps;
  /** Embedded Signup Meta (connexion du numéro, Tech Provider), réservé aux admins. */
  embeddedSignup?: EmbeddedSignupRouteDeps;
  /** CRUD des clés d'API (console admin, JWT), réservé aux admins. */
  apiKeys?: ApiKeysRouteDeps;
  /**
   * L'API publique /v1 (clé d'API, autorité séparée du JWT, comme /ops). `usage` est retiré des dépendances
   * de chaque module : c'est `buildServer` qui injecte le garde d'usage, une seule fois, comme les limiteurs
   * de débit. L'appelant ne peut donc ni l'oublier ni en fournir un second.
   */
  v1?: {
    apiKeys: ApiKeyLookup;
    contacts: Omit<V1ContactsRouteDeps, 'usage'>;
    sends?: Omit<V1SendsRouteDeps, 'usage'>;
    /** Les trois catalogues (`GET /v1/templates`, `/v1/scenarios`, `/v1/rcs-messages`). */
    catalogues?: Omit<V1CataloguesRouteDeps, 'usage'>;
    /** Un simple texte dans la fenêtre de 24 h (`POST /v1/messages/whatsapp`). */
    messages?: Omit<V1MessagesRouteDeps, 'usage'>;
    /** Un simple texte en RCS à une fiche (`POST /v1/messages/rcs`). */
    messagesRcs?: Omit<V1MessagesRcsRouteDeps, 'usage'>;
    mcp?: DepsMcp;
    /** Le relais du Meta Business Agent : même autorité et même limiteur que /v1. */
    mbaRelais?: MbaRelaisDeps;
  };
  /**
   * Le garde d'usage de l'API publique. Absent -> une instance mémoire en observation est construite ici.
   * Injectable pour être observé (un test vérifie que les routes comptent vraiment) ; le jour du
   * multi-replica, l'implémentation partagée passera par ici sans qu'aucune route ne bouge.
   */
  usage?: ApiUsageGuard;
  /** Import de listes HubSpot (3e source de campagne), réservé aux admins. */
  hubspotImport?: HubspotImportRouteDeps;
  /** Émission du lien d'install/re-consentement HubSpot signé, réservé aux admins. */
  hubspotInstall?: HubspotInstallRouteDeps;
  /** Étapes de deal du portail HubSpot (menu de l'écran Automation), réservé aux admins. */
  hubspotPipelines?: HubspotPipelinesRouteDeps;
  /** Configuration de l'agent MBA (connaissance, personnalité, réglages), réservé aux admins. */
  mba?: MbaRouteDeps;
  /** Node « Envoi de mail » (boîtes SMTP + modèles), réservé aux admins, comme workflows. */
  email?: EmailRoutesDeps;
  /**
   * Redirection publique des liens tracés (`GET /r/:code`). Aucune authentification : c'est un destinataire
   * WhatsApp qui l'ouvre. Le tenant vient du code retrouvé en base, jamais de l'URL.
   */
  links?: LinksRouteDeps;
  /**
   * Réception publique des webhooks entrants (`POST /w/:code`). Aucune authentification : c'est un outil
   * tiers qui poste. Le tenant vient du code retrouvé en base, jamais du corps.
   */
  webhookEntrant?: WebhookEntrantRouteDeps;
  /** Gestion des webhooks entrants (écran Tools > Webhooks), réservé aux admins. */
  webhooksAdmin?: WebhooksAdminRouteDeps;
  /** Chaîne WhatsApp (Channels Me) : lecture ouverte aux comptes authentifiés, écritures admin-only (garde
   *  dans la route). */
  channelsMe?: ChannelsMeRouteDeps;
}

/**
 * Ce qui autorise un appel sur les routes d'un module ; chaque entrée du registre le déclare.
 * Une union et pas un booléen : un `porteDeTenant: false` serait un désengagement silencieux, alors que
 * l'union force l'auteur d'un module à nommer ce qui le protège à la place.
 */
export type ClasseDAcces =
  /**
   * JWT, ET l'espace de l'URL doit être celui du jeton. C'est `scopeTenant` qui le vérifie, par l'étape
   * `etapeEspace` que `entree` pose sur chaque route `:tenantId` du module (`src/http/scope.ts`).
   */
  | 'tenant'
  /** Avant toute session : `/auth/*`. Ses propres plafonds de débit sont posés dans son module. */
  | 'anonyme'
  /**
   * Un code opaque dans l'adresse autorise l'appel : lien tracé (`/r/:code`), rappel du fournisseur RCS
   * (`/rcs/callback/:code`), webhook entrant (`/w/:code`). Le webhook entrant accepte en plus un secret
   * d'en-tête facultatif (`x-webhook-secret`) : le code autorise, le secret durcit.
   */
  | 'code-url'
  /** La signature de Meta sur le corps de la requête, avec le secret de l'application Meta. */
  | 'signature-meta'
  /**
   * Une signature HMAC entre nos services, avec un secret partagé (`x-mm-service-signature`) : c'est ainsi
   * que le connecteur HubSpot pousse ses événements. Pas `code-url` : son adresse ne porte aucun code, et une
   * adresse devinable ne suffit pas à autoriser un appel.
   */
  | 'signature-service'
  /**
   * La session d'exploitation nominative (`makeRequireOps`) : une adresse de `OPS_EMAILS`, son second facteur
   * vérifié, relus à chaque requête. Autorité séparée de la session d'espace, et délibérément cross-espace.
   */
  | 'session-ops'
  /** Une clé d'API de client, autorité séparée elle aussi. */
  | 'cle-api';

/** Les gardes que `buildServer` construit une fois et distribue aux modules. */
export interface Gardes {
  /**
   * Tout compte authentifié. `PreHandler` et non `Guard` : c'est un seul prehandler, pas une liste, et
   * `registerInbox` le compose lui-même avec sa garde d'effacement.
   * 🔴 Les trois gardes sont requises : un module qui recevrait une garde absente monterait ses routes sans
   * contrôle. Sans authentification câblée, elles valent un refus, jamais `undefined`.
   */
  readonly auth: PreHandler;
  /** Compte `admin` seulement. Une liste (`[auth, role]`), d'où `Guard`. */
  readonly admin: Guard;
  /** `admin` ou `manager` : consulter n'est pas décider (écrans de conformité). */
  readonly encadrement: Guard;
  /** La session d'exploitation, pour les modules `session-ops`. Sans `auth`, elle refuse tout. */
  readonly ops: PreHandler;
  /** Le second plafond de débit, composé route par route sur les seules routes coûteuses. */
  readonly limiteCouteuse?: PreHandler;
}

/**
 * « Aucun plafond », nommé. `limiteCouteuse` vaut `undefined` quand `RATE_LIMIT_COUTEUX_PAR_MINUTE` est à 0
 * (plafond coupé délibérément). Un module qui exige son plafond par le type reçoit alors cette garde, qui
 * laisse passer et le dit, là où un paramètre optionnel laisserait croire à un oubli.
 */
const SANS_PLAFOND: PreHandler = async () => {};

/** Une entrée du registre, une fois son type de dépendances effacé (voir `entree`). */
export interface ModuleMonte {
  readonly nom: string;
  readonly acces: ClasseDAcces;
  /** Ses dépendances ont-elles été fournies ? C'est ce qui décide s'il se monte. */
  readonly fourni: boolean;
  readonly monte: (app: FastifyInstance, gardes: Gardes) => void;
}

/**
 * Déclare un module montable. `D` est inféré depuis `deps`, donc `monter` le reçoit non nul : le test de
 * présence vit ici, une seule fois, et un module ne peut pas être monté avec des dépendances absentes.
 * L'entrée rendue a un type uniforme, pour ranger tous les modules dans une seule liste.
 * Le test est `!== undefined`, pas la véracité : un module dont les dépendances valent `null` se monte et
 * échoue au montage (un câblage fautif), au lieu de disparaître en silence.
 *
 * 🔴 C'est ici que le contrôle d'espace se pose : un module déclaré `acces: 'tenant'` est monté par
 * `monterAvecEtapeEspace`, qui ajoute `etapeEspace` à la fin de la chaîne de chacune de ses routes
 * `:tenantId`. La déclaration décide du contrôle, donc un module ajouté demain le reçoit sans y penser, et
 * tout appelant de `monte` (serveur, `tests/scope-tenant.test.ts`, auto-attaque) l'obtient par le même
 * chemin. Les modules `session-ops` portent aussi des `:tenantId` et n'y passent pas : leur autorité n'est
 * pas une session d'espace.
 */
function entree<D>(
  nom: string,
  acces: ClasseDAcces,
  deps: D | undefined,
  monter: (app: FastifyInstance, deps: D, gardes: Gardes) => void,
): ModuleMonte {
  return {
    nom,
    acces,
    fourni: deps !== undefined,
    monte: (app, gardes) => {
      if (deps === undefined) return;
      if (acces === 'tenant') monterAvecEtapeEspace(app, () => monter(app, deps, gardes));
      else monter(app, deps, gardes);
    },
  };
}

/**
 * Le registre des modules de routes, exporté pour être exercé.
 *
 * 🔴 La couverture du garde-fou d'authentification se dérive de ce registre (`acces: 'tenant'`), et non
 * d'une seconde liste à tenir à la main. `tests/scope-tenant.test.ts` monte chaque module tenant un par un
 * et vérifie que le serveur refuse de démarrer sans garde. Ce garde-fou et la fermeture de `scopeTenant`
 * (`src/http/scope.ts`) sont les deux moitiés du même contrôle.
 *
 * L'ordre de cette liste est l'ordre de montage : les surfaces sans session d'abord, puis les modules gardés.
 */
export function modulesDeRoutes(
  deps: ServerDeps,
  usageApi: ApiUsageGuard,
  /**
   * Le compteur de débit partagé, construit une fois par `buildServer` : le plafond de l'API par espace et ceux de
   * la connexion y comptent. Reçu en paramètre et non lu dans `deps` : le script d'auto-attaque déduit les modules
   * des clés que ce registre lit, et `debit` n'en monte aucun. Le défaut sert qui exerce le registre sans serveur.
   */
  debit: CompteurDebit = new CompteurDebitMemoire(),
): readonly ModuleMonte[] {
  /**
   * Un seul cache de réglages du plafond de l'API pour ses deux consommateurs : le limiteur de `/v1` le lit,
   * la route d'exploitation y pose ce qu'elle vient d'écrire. Avec deux instances, un plafond relevé ne
   * prendrait effet qu'à l'expiration du cache, sans que rien ne le dise.
   * `deps.plafondApi` est lu ici parce que le script d'auto-attaque déduit les modules des clés que ce
   * registre lit en construisant sa liste. Les défauts (`deps.plafonds`) se lisent dans les closures.
   */
  const sourcePlafond = deps.plafondApi;
  const reglagesPlafond = new ReglagesPlafondEnCache(sourcePlafond ? (t) => sourcePlafond.lire(t) : async () => SANS_REGLAGE);
  const defautsPlafond = () => ({
    minute: deps.plafonds?.apiParMinute ?? config.API_PLAFOND_MINUTE,
    heure: deps.plafonds?.apiParHeure ?? config.API_PLAFOND_HEURE,
  });
  return [
    // La réception des webhooks Meta : autorité = la signature du corps, vérifiée dans le module.
    entree('receiver', 'signature-meta', deps.queue, (app, queue) => registerReceiver(app, queue, {
      verifyToken: deps.verifyToken ?? config.META_VERIFY_TOKEN,
      appSecret: deps.appSecret ?? config.META_APP_SECRET,
    })),
    // Surface /ops : autorité séparée de la session d'espace (`g.ops`, la session d'exploitation nominative). Le
    // garde d'usage injecté est la même instance que celle de `/v1` : l'écran d'exploitation montre exactement
    // ce que les routes ont compté.
    entree('ops', 'session-ops', deps.ops, (app, d, g) => registerOps(app, { ...d, usage: usageApi }, g.ops)),
    // Le réglage du plafond de l'API d'un espace : même autorité que `/ops`, dans un module à part.
    entree('plafondApi', 'session-ops', deps.plafondApi, (app, d, g) => registerOpsPlafondApi(
      app, { store: d, reglages: reglagesPlafond, defauts: defautsPlafond() }, g.ops,
    )),
    // Redirection des liens tracés : publique (un destinataire clique depuis WhatsApp, sans session), montée
    // avant les gardes d'auth.
    entree('links', 'code-url', deps.links, (app, d) => registerLinks(app, d)),
    // Réception des webhooks entrants : publique aussi (l'appelant est un outil tiers), montée avant les gardes.
    entree('webhookEntrant', 'code-url', deps.webhookEntrant, (app, d) => registerWebhookEntrant(app, d)),
    // Rappels du fournisseur RCS : publique aussi (l'appelant est smsmode), autorisée par le code opaque de
    // l'URL. Son plafond par code ne compte que des codes existants (pris après la lecture en base), donc
    // aucun plafond de clés : il rouvrirait l'éviction d'un vrai code par des codes inventés.
    entree('rcsCallback', 'code-url', deps.rcsCallback, (app, d) =>
      registerRcsCallback(app, d, new RateLimiter(config.RCS_CALLBACK_PAR_MINUTE, 60_000),
        new RateLimiter(config.CODES_INCONNUS_PAR_MINUTE, 60_000))),
    entree('auth', 'anonyme', deps.auth, (app, d, g) => registerAuth(app, d, g.auth, debit)),
    entree('import', 'tenant', deps.import, (app, d, g) => registerImport(app, d, g.admin, g.limiteCouteuse)),
    entree('campaigns', 'tenant', deps.campaigns, (app, d, g) => registerCampaigns(app, d, g.admin, g.limiteCouteuse)),
    // Bibliothèque RCS : montée avec `auth` et non `admin`, car la liste doit être lisible par un agent (bloc
    // de scénario, assistant de campagne). Les écritures sont gardées dans les handlers par `forbidNonAdmin`.
    entree('rcsMessages', 'tenant', deps.rcsMessages, (app, d, g) => registerRcsMessages(app, d, g.auth)),
    entree('rcsChannel', 'tenant', deps.rcsChannel, (app, d, g) => registerRcsChannel(app, d, g.auth)),
    entree('integrationBatch', 'tenant', deps.integrationBatch, (app, d, g) => registerIntegrationBatch(app, d, g.admin)),
    entree('salesforce', 'tenant', deps.salesforce, (app, d, g) => registerSalesforce(app, d, g.admin, g.limiteCouteuse)),
    // Visuels RCS : monté avec `auth` alors qu'il porte aussi une route publique `/m/<code>.<ext>`. Les gardes
    // sont posées par route (`preHandler`), donc la lecture reste ouverte : l'opérateur télécom télécharge
    // l'image sans session.
    entree('rcsMedia', 'tenant', deps.rcsMedia, (app, d, g) => registerRcsMedia(app, d, g.auth)),
    // Templates : la liste (GET) reste lisible par l'agent, l'inbox en a besoin pour envoyer un template hors
    // fenêtre 24 h. La création (POST) reste admin-only via `forbidNonAdmin` dans le handler.
    entree('templates', 'tenant', deps.templates, (app, d, g) => registerTemplates(app, d, g.auth)),
    // Deux gardes : l'inbox est ouverte a tout compte authentifie, mais l'effacement du contenu d'une
    // conversation est reserve aux administrateurs. Un operateur repond aux clients, il n'efface pas des traces.
    entree('inbox', 'tenant', deps.inbox, (app, d, g) => registerInbox(app, d, g.auth, g.admin, g.limiteCouteuse)),
    entree('hubspotEvents', 'signature-service', deps.hubspotEvents, (app, d) => registerHubspotEvents(app, d)),
    entree('stats', 'tenant', deps.stats, (app, d, g) => registerStats(app, d, g.admin)),
    entree('settings', 'tenant', deps.settings, (app, d, g) => registerSettings(app, d, g.admin, g.encadrement)),
    entree('admin', 'tenant', deps.admin, (app, d, g) => registerUsers(app, d, g.admin)),
    entree('flows', 'tenant', deps.flows, (app, d, g) => registerFlows(app, d, g.admin)),
    entree('agents', 'tenant', deps.agents, (app, d, g) => registerAgents(app, d, g.admin)),
    entree('agentKnowledge', 'tenant', deps.agentKnowledge, (app, d, g) => registerAgentKnowledge(app, d, g.admin, g.limiteCouteuse)),
    entree('agentTools', 'tenant', deps.agentTools, (app, d, g) => registerAgentTools(app, d, g.admin)),
    entree('agentCatalogue', 'tenant', deps.agentCatalogue, (app, d, g) => registerAgentCatalogue(app, d, g.admin)),
    entree('mbaPublication', 'tenant', deps.mbaPublication, (app, d, g) => registerMbaPublication(app, d, g.admin)),
    entree('mbaOutils', 'tenant', deps.mbaOutils, (app, d, g) => registerMbaOutils(app, d, g.admin)),
    // Publicités : sous `g.auth` et non `g.admin`, car la lecture de l'état est ouverte à tout membre (aucun
    // secret) ; les trois écritures sont gardées dans les handlers par `forbidNonAdmin`.
    entree('pubs', 'tenant', deps.pubs, (app, d, g) => registerPubs(app, d, g.auth, g.limiteCouteuse ?? SANS_PLAFOND)),
    // `g.admin` comme les écritures MBA : la conversation ne doit pas être un chemin plus permissif que le
    // formulaire. La route repose aussi `forbidNonAdmin` : celle-ci monte, celle-là explique.
    entree('mbaAssistant', 'tenant', deps.mbaAssistant, (app, d, g) => registerMbaAssistant(app, d, g.admin)),
    // Admin comme ce qu'il journalise : ce journal porte le contenu des éléments supprimés.
    entree('historique', 'tenant', deps.historique, (app, d, g) => registerHistorique(app, d, g.admin)),
    entree('agentSources', 'tenant', deps.agentSources, (app, d, g) => registerAgentSources(app, d, g.admin)),
    entree('agentMcp', 'tenant', deps.agentMcp, (app, d, g) => registerAgentMcp(app, d, g.admin, g.limiteCouteuse)),
    // Réservées aux admins comme les sources : décrire une requête, c'est décider ce qu'on envoie au système
    // d'un client, et le bouton Test rend la réponse entière.
    entree('agentRequetes', 'tenant', deps.agentRequetes, (app, d, g) => registerAgentRequetes(app, d, g.admin)),
    entree('agentSetup', 'tenant', deps.agentSetup, (app, d, g) => registerAgentSetup(app, d, g.admin)),
    entree('agentTest', 'tenant', deps.agentTest, (app, d, g) => registerAgentTest(app, d, g.admin)),
    entree('media', 'tenant', deps.media, (app, d, g) => registerMedia(app, d, g.admin)),
    entree('tags', 'tenant', deps.tags, (app, d, g) => registerTags(app, d, g.admin)),
    entree('fields', 'tenant', deps.fields, (app, d, g) => registerFields(app, d, g.admin)),
    entree('support', 'tenant', deps.support, (app, d, g) => registerSupport(app, d, g.auth)),
    entree('aide', 'tenant', deps.aide, (app, d, g) => registerAide(app, d, g.auth)),
    entree('contacts', 'tenant', deps.contacts, (app, d, g) => registerContacts(app, d, g.admin, g.encadrement, g.limiteCouteuse)),
    entree('workflows', 'tenant', deps.workflows, (app, d, g) => registerWorkflows(app, d, g.admin)),
    entree('workflowReports', 'tenant', deps.workflowReports, (app, d, g) => registerWorkflowReports(app, d, g.admin)),
    entree('automations', 'tenant', deps.automations, (app, d, g) => registerAutomations(app, d, g.auth)),
    // `auth` et non `admin` : les écrans de la chaîne se lisent avec un compte agent, et les six
    // ecritures sont fermees dans la route par `forbidNonAdmin`.
    entree('channelsMe', 'tenant', deps.channelsMe, (app, d, g) => registerChannelsMeRoutes(app, d, g.auth)),
    entree('embeddedSignup', 'tenant', deps.embeddedSignup, (app, d, g) => registerEmbeddedSignup(app, d, g.admin, g.limiteCouteuse)),
    entree('hubspotImport', 'tenant', deps.hubspotImport, (app, d, g) => registerHubspotImport(app, d, g.admin)),
    entree('hubspotInstall', 'tenant', deps.hubspotInstall, (app, d, g) => registerHubspotInstall(app, d, g.admin)),
    entree('hubspotPipelines', 'tenant', deps.hubspotPipelines, (app, d, g) => registerHubspotPipelines(app, d, g.admin)),
    entree('mba', 'tenant', deps.mba, (app, d, g) => registerMba(app, d, g.admin)),
    entree('email', 'tenant', deps.email, (app, d, g) => registerEmailRoutes(app, d, g.admin)),
    entree('apiKeys', 'tenant', deps.apiKeys, (app, d, g) => registerApiKeys(app, d, g.admin)),
    entree('webhooksAdmin', 'tenant', deps.webhooksAdmin, (app, d, g) => registerWebhooksAdmin(app, d, g.admin)),
    /**
     * API publique /v1 et serveur MCP : une seule entrée pour tous leurs montages, parce qu'ils partagent
     * une autorité et un limiteur. Une seconde instance doublerait le quota d'un espace selon la porte
     * empruntée, sans que personne le voie.
     */
    entree('v1', 'cle-api', deps.v1, (app, v1) => {
      /**
       * Le plafond de l'espace, commun à toutes ses clés, `/v1` et `/mcp` confondus, minute et heure, indexé
       * sur l'espace d'une clé résolue (`api-key.ts`), compté dans le compteur PARTAGÉ par les copies de l'API.
       * Le compteur par clé ne sert qu'au relais du Meta Business Agent, hors du plafond de l'espace : un
       * intégrateur qui charge l'API ne doit pas couper les outils de l'agent de Meta. Il reste en mémoire, par
       * copie, délibérément (`documentation.md`, les plafonds). Aucun des deux n'a besoin d'un plafond de clés
       * (clés résolues seulement).
       */
      const plafondEspace = new PlafondEspace(defautsPlafond(), reglagesPlafond, debit);
      const apiLimiter = new RateLimiter(config.API_KEY_RATE_LIMIT_MAX, config.API_KEY_RATE_LIMIT_WINDOW_MS);
      /**
       * Le pré-filtre : budget global des lookups spéculatifs. Sa clé est une constante
       * (`CLE_BUDGET_SPECULATIF`), donc sa table ne porte qu'une entrée : pas de plafond de clés.
       */
      const apiPrefiltre = new RateLimiter(config.API_KEY_PREFILTRE_MAX, config.API_KEY_RATE_LIMIT_WINDOW_MS);
      const requireApiKey = makeRequireApiKey(v1.apiKeys, { espace: plafondEspace, relais: apiLimiter }, apiPrefiltre);
      // Deux droits, et une clé ne porte que ceux qu'on lui a donnés : lire une fiche (numéro, consentement,
      // joignabilité) n'est pas le droit d'en écrire une, ni l'inverse.
      registerV1Contacts(app, { ...v1.contacts, usage: usageApi }, {
        ecrire: [requireApiKey, requireScope('contacts:write')],
        lire: [requireApiKey, requireScope('contacts:read')],
      });
      if (v1.sends) registerV1Sends(app, { ...v1.sends, usage: usageApi }, [requireApiKey, requireScope('sends:create')]);
      // Les catalogues : même droit que les envois, qu'ils servent à construire, et même `requireApiKey`, donc
      // même plafond d'espace. Un droit neuf obligerait chaque intégrateur à refabriquer sa clé pour lire ce
      // qu'il a déjà le droit d'envoyer.
      if (v1.catalogues) registerV1Catalogues(app, { ...v1.catalogues, usage: usageApi }, [requireApiKey, requireScope('sends:create')]);
      // Même droit que les envois, élargissement assumé : les droits d'une clé ne s'éditent pas après sa
      // création. Le détail est dans `v1-messages.ts`.
      if (v1.messages) registerV1Messages(app, { ...v1.messages, usage: usageApi }, [requireApiKey, requireScope('sends:create')]);
      // Même droit, même limiteur et même garde que le message WhatsApp : le même geste sur un autre canal.
      if (v1.messagesRcs) registerV1MessagesRcs(app, { ...v1.messagesRcs, usage: usageApi }, [requireApiKey, requireScope('sends:create')]);
      // Serveur MCP : même `requireApiKey` que /v1, donc ses appels comptent dans le plafond de l'espace. Pas
      // de `requireScope` à la porte : il a deux droits (lecture, écriture) et c'est l'outil appelé qui décide
      // duquel il a besoin.
      if (v1.mcp) registerMcp(app, v1.mcp, [requireApiKey], usageApi);
      // Le relais du Meta Business Agent : le même `requireApiKey`, qui reconnaît sa clé à son droit et la
      // compte par clé, hors du plafond de l'espace. Ce droit, seule la publication l'attribue (`DROIT_RELAIS`,
      // absent de `VALID_API_SCOPES`) : la même constante que celle qui crée la clé, un littéral recopié ici
      // enverrait tous les appels en 403 le jour où l'un des deux change.
      if (v1.mbaRelais) registerMbaRelais(app, v1.mbaRelais, [requireApiKey, requireScope(DROIT_RELAIS)]);
    }),
    // Accueil : statut compte réservé aux admins (la page /accueil est admin-only) ; /me ouvert à tout
    // compte authentifié (générique, lit req.auth.userId).
    entree('account', 'tenant', deps.account, (app, d, g) => registerAccount(app, d, g.admin)),
    entree('me', 'tenant', deps.me, (app, d, g) => registerMe(app, d, g.auth)),
  ];
}

/**
 * Le corps d'une réponse 5xx : opaque, rien de l'erreur interne n'en sort. Exporté pour
 * `tests/corps-opaque-parite.test.ts`, qui le tient égal à ce que la console reconnaît (`web/lib/http.ts`).
 */
export const CORPS_OPAQUE_5XX = 'Internal Server Error';

/**
 * Construit l'instance Fastify. La file et les stores sont injectés pour rester testable sans DB. Les routes
 * tenant exigent l'auth : le tenant est dérivé du JWT, jamais de l'URL.
 */
export function buildServer(deps: ServerDeps): FastifyInstance {
  /**
   * Une seule instance du garde d'usage pour toute la surface publique. Il compte le travail, là où les
   * limiteurs comptent les requêtes (à 60 requêtes par minute, une clé fait accepter 30 000 contacts). Deux
   * instances donneraient deux moitiés de compteurs selon la porte. Créé avant le registre, parce que `/ops`
   * et `/v1` le capturent : l'écran d'exploitation et les routes doivent regarder le même compteur.
   * En observation : construit sans plafond, les seuils viendront d'une mesure. Il compte dans le compteur partagé,
   * sauf ses places d'opérations lourdes, qui protègent le pool de CETTE copie.
   *
   * 🔴 Le compteur de débit : UNE instance pour tout le serveur, précédée de la mémoire des fenêtres pleines de
   * cette copie (sans elle, chaque refus coûterait une écriture en base, et une boucle d'appels refusés ferait
   * tomber le pool avec elle).
   */
  const debit = memoireDesPleines(deps.debit ?? new CompteurDebitMemoire());
  const usageApi = deps.usage ?? new GardeUsage(debit, { maxLourdesSimultanees: config.API_MAX_LOURDES_SIMULTANEES });

  // Le registre vit au niveau du module (`modulesDeRoutes`) pour qu'un test puisse l'exercer sans monter le
  // serveur entier.
  const registre = modulesDeRoutes(deps, usageApi, debit);

  /**
   * 🔴 Aucune route portant `:tenantId` ne se monte sans authentification. La couverture est dérivée du
   * registre : tout module déclaré `acces: 'tenant'` y entre sans être inscrit ailleurs.
   */
  if (registre.some((m) => m.acces === 'tenant' && m.fourni) && !deps.auth) {
    // Ces routes lisent req.auth (userId/tenant) ; sans auth, scopeTenant refuse tout et le service est mort
    // en silence. Mieux vaut refuser de démarrer que servir 403 sur tout un espace.
    throw new Error('buildServer: `auth` est requis dès qu’un module exposant des routes `:tenantId` est monté');
  }

  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });

  /**
   * Les en-têtes de sécurité, sur chaque réponse. `onSend` est le dernier point du cycle avant l'envoi : il
   * couvre toute réponse, y compris celles qu'un hook antérieur rend directement (refus de plafond de débit,
   * préalable CORS).
   */
  app.addHook('onSend', async (_req, reply, payload) => {
    for (const [nom, valeur] of Object.entries(ENTETES_SECURITE_API)) reply.header(nom, valeur);
    return payload;
  });

  /**
   * 🔴 Le CORS n'est posé que si une origine est inscrite. Liste blanche, jamais `*` (refusé au chargement
   * dans `src/config.ts`), et aucun `credentials` : la session voyage dans un en-tête `Authorization`, jamais
   * dans un cookie, donc aucun CSRF possible ; les credentials en créeraient un. La session d'exploitation
   * voyage dans le même en-tête `Authorization` : aucun en-tête propre à `/ops` n'est autorisé.
   */
  const origines = deps.corsOrigins?.map((o) => o.trim()).filter((o) => o !== '') ?? [];
  if (origines.length > 0) {
    void app.register(cors, {
      origin: origines,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['authorization', 'content-type'],
      // Les en-têtes de plafond de débit : cross-origin, un navigateur ne laisse JavaScript voir qu'une courte
      // liste d'en-têtes sûrs, dont `retry-after` et `x-ratelimit-*` ne font pas partie. Sans cette liste, la
      // console saurait qu'elle est bloquée, jamais pour combien de temps.
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
      // Préférer le message utilisateur de Meta (`error_user_msg`) au générique « Invalid parameter » :
      // ex. suppression d'un exemple de template -> « Les exemples de modèles ne peuvent pas être supprimés ».
      const friendly = err.userMessage ?? err.message;
      const detail = friendly.replace(/\s+/g, ' ').trim().slice(0, 200);
      return reply.code(422).send({ error: `Meta: ${detail}` });
    }
    // flow_json refusé par Meta à la création : 422 + les erreurs de validation (pas un 500 opaque).
    if (err instanceof FlowJsonInvalidError) {
      return reply.code(422).send({ error: err.message.slice(0, 200) });
    }
    // Corps trop gros : Fastify répond en anglais sans dire quoi faire. Un opérateur qui importe un gros CSV
    // doit lire l'issue (couper le fichier), pas seulement le refus.
    if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(413).send({ error: 'Fichier trop volumineux pour un seul envoi. Découpe-le en plusieurs fichiers plus petits et recommence.' });
    }
    const code = err.statusCode ?? 500;
    // Journaliser avant de masquer : le corps des 5xx reste opaque (pas de fuite d'interne), mais l'exception
    // doit laisser une trace côté serveur. `journaliser` et non `req.log` : Fastify est construit en
    // `logger: false`, donc `req.log` est un no-op. Il porte la cause (le `ENOTFOUND` d'un `fetch failed`).
    if (code >= 500) {
      journaliser('error', 'unhandled_route_error', { method: req.method, url: req.url, tenantId: req.auth?.tenantId ?? null, err });
    }
    // Ce texte a un lecteur : la console le reconnaît et le remplace par une phrase traduite
    // (`OPAQUE_DU_SERVEUR`, `web/lib/http.ts`). Les deux se tiennent par `tests/corps-opaque-parite.test.ts`.
    reply.code(code).send({ error: code < 500 ? err.message : CORPS_OPAQUE_5XX });
  });

  // Liveness : le process répond (event loop non bloquée). Zéro DB, zéro dépendance : cible d'un healthcheck.
  // Ne jamais y toucher la DB, sinon il devient une seconde readiness et perd son sens.
  app.get('/live', async () => ({ ok: true }));

  // Readiness : la DB est-elle joignable ? 503 si non, pour un monitoring externe. On catche et on répond 503
  // dans le handler : un throw serait converti en 500 par setErrorHandler. Sans checkReadiness (tests sans
  // DB), 200 inconditionnel.
  app.get('/health', async (_req, reply) => {
    if (!deps.checkReadiness) return { ok: true, service: 'messagingme-mba', ts: Date.now() };
    try {
      await deps.checkReadiness();
      return { ok: true, service: 'messagingme-mba', ts: Date.now() };
    } catch {
      return reply.code(503).send({ ok: false, service: 'messagingme-mba', ts: Date.now() });
    }
  });

  /**
   * Les deux plafonds de débit des routes authentifiées. Le général est passé à `makeRequireAuth`, donc tout
   * module gardé en hérite ; le second est composé route par route sur les seules routes coûteuses. Un maximum
   * à 0 rend le limiteur absent : c'est la trappe de secours si le calibrage se révèle mauvais (cf. `config.ts`).
   *
   * 🔴 Le général reste LOCAL À LA COPIE, délibérément : c'est le plafond le plus fréquent (chaque requête de la
   * console), le porter en base coûterait une écriture Postgres par requête, et ce qu'il borne (un compte qui
   * martèle) reste borné à N fois 300 par minute avec N copies. Le coûteux, lui, compte dans le compteur PARTAGÉ :
   * c'est la charge d'un espace sur la base qu'il borne, et N copies la multipliaient. Base muette : il laisse
   * passer (`PlafondPartage`, la route elle-même a besoin de la base).
   */
  // Aucun plafond de clés (4e argument à son défaut) : la clé vient d'un JWT vérifié, pas de l'appelant, et
  // un plafond ferait refuser un utilisateur neuf quand la table est pleine. Les entrées expirent en une
  // minute et `prune` les retire.
  const utilisateurParMinute = deps.plafonds?.utilisateurParMinute ?? config.RATE_LIMIT_USER_PAR_MINUTE;
  const plafondUtilisateur = utilisateurParMinute > 0 ? new RateLimiter(utilisateurParMinute, 60_000) : undefined;
  const couteuxParMinute = deps.plafonds?.couteuxParMinute ?? config.RATE_LIMIT_COUTEUX_PAR_MINUTE;
  const limiteCouteuse = couteuxParMinute > 0
    ? makeLimiteParTenant(
      new PlafondPartage(debit, { nom: 'couteux', max: couteuxParMinute, dureeMs: 60_000, siLaBaseEchoue: 'laisser-passer' }),
      'trop d’opérations lourdes sur cet espace, patientez une minute',
    )
    : undefined;

  /**
   * 🔴 Sans `deps.auth`, la garde vaut un refus, jamais `undefined` : une route montée sans garde serait
   * servie sans aucun contrôle. Aucun chemin n'y mène aujourd'hui (le garde-fou plus haut refuse de
   * démarrer) ; ce refus existe pour que le type puisse exiger une garde partout.
   */
  const refuseTout: PreHandler = async (_req, reply) => {
    await reply.code(401).send({ error: 'authentification non configurée' });
  };
  const requireAuth = deps.auth ? makeRequireAuth(deps.auth.secret, deps.auth.getUserState, plafondUtilisateur) : refuseTout;
  // RBAC : la barrière est au preHandler (source de vérité serveur) ; l'UI ne fait que masquer ou
  // rediriger, par confort.
  const requireAdmin: Guard = [requireAuth, makeRequireRole(['admin'])];
  /**
   * L'encadrement : `admin` et `manager`, pour les écrans de conformité. Consulter n'est pas décider : un
   * manager lit la liste des désabonnés, la politique d'annonce d'IA et les journaux, mais les écritures
   * restent sur `requireAdmin`. Cette ouverture bouge avec `web/lib/nav.ts`.
   */
  const requireEncadrement: Guard = [requireAuth, makeRequireRole(['admin', 'manager'])];

  /**
   * Le montage, en une seule boucle sur le registre : le module, sa garde et sa couverture tenant vivent dans
   * son entrée, et le type les exige. L'ordre de montage est celui du registre.
   */
  const gardes: Gardes = {
    auth: requireAuth,
    admin: requireAdmin,
    encadrement: requireEncadrement,
    // Une seule instance pour `/ops` et le réglage du plafond de l'API. Sans `deps.auth`, elle refuse tout.
    ops: makeRequireOps(deps.auth, deps.surveillanceOps),
    limiteCouteuse,
  };
  for (const m of registre) m.monte(app, gardes);

  return app;
}
