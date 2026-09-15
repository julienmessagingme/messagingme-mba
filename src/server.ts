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
import { registerMbaAssistant } from './http/mba-assistant';
import { registerHistorique } from './http/historique';
import type { HistoriqueRouteDeps } from './http/historique';
import type { MbaAssistantDeps } from './http/mba-assistant';
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
import type { Guard, PreHandler } from './auth/middleware';
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
import type { ApiUsageGuard } from './api/usage-guard';
import { GardeUsageMemoire } from './api/usage-guard.memoire';

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
  /** L'assistant conversationnel du Meta Business Agent. Absent -> la route n'existe pas. */
  mbaAssistant?: MbaAssistantDeps;
  /** L'historique des réglages, partagé par le MBA et les agents IA. */
  historique?: HistoriqueRouteDeps;
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
  /** Le bot d'aide de la console : il explique et il emmène, il n'écrit jamais rien. */
  aide?: AideRouteDeps;
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
  /**
   * L'API publique. ⚠️ `usage` EST RETIRÉ DES DEUX DÉPENDANCES DE ROUTES, et c'est ce qui rend le garde
   * d'usage OBLIGATOIRE sans le faire écrire par chaque appelant : le contrat des routes l'exige, et
   * c'est `buildServer` qui l'injecte, une seule fois, comme il injecte déjà les limiteurs de débit.
   * L'appelant (le câblage, les tests) ne peut donc ni l'oublier ni en fournir un second.
   */
  v1?: {
    apiKeys: ApiKeyLookup;
    contacts: Omit<V1ContactsRouteDeps, 'usage'>;
    sends?: Omit<V1SendsRouteDeps, 'usage'>;
    mcp?: DepsMcp;
  };
  /**
   * Le garde d'usage de l'API publique. ABSENT -> une instance MÉMOIRE en OBSERVATION est construite ici.
   *
   * ⚠️ INJECTABLE POUR ÊTRE OBSERVÉ, pas pour être remplacé à la légère : c'est ainsi qu'un test vérifie
   * que les six routes comptent vraiment. Le jour du multi-replica, c'est par ici que passera
   * l'implémentation partagée, sans qu'aucune route ne bouge.
   */
  usage?: ApiUsageGuard;
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
 * CE QUI AUTORISE UN APPEL sur les routes d'un module. Chaque entrée du registre le DÉCLARE.
 *
 * 🔴 UNE UNION, ET SURTOUT PAS UN BOOLÉEN, et c'est le cœur de ce registre. Un `porteDeTenant: false`
 * serait un désengagement SILENCIEUX : on peut l'écrire sans y penser, et rien ne demande de quoi le module
 * se protège À LA PLACE. L'union force l'auteur du 41e module à choisir un mot, donc à répondre à la
 * question. C'est la même propriété que ce registre apporte au reste : rendre l'oubli impossible plutôt que
 * détectable.
 *
 * ⚠️ Il y a SIX classes, pas deux, et le découvrir est déjà un résultat : l'inventaire écrit à la main ne
 * connaissait que « tenant ou pas ».
 */
export type ClasseDAcces =
  /** JWT, ET l'espace de l'URL doit être celui du jeton. C'est `scopeTenant` qui le vérifie, dans chaque route. */
  | 'tenant'
  /** Avant toute session : `/auth/*`. Ses propres plafonds de débit sont posés dans son module. */
  | 'anonyme'
  /**
   * Un code opaque dans l'adresse autorise l'appel : lien tracé (`/r/:code`), rappel du fournisseur RCS
   * (`/rcs/callback/:code`), webhook entrant (`/w/:code`).
   *
   * ⚠️ Le webhook entrant accepte EN PLUS un secret d'en-tête quand le client en a posé un
   * (`x-webhook-secret`, facultatif) : le code reste ce qui autorise, le secret durcit.
   */
  | 'code-url'
  /** La signature de Meta sur le corps de la requête, avec le secret de l'application Meta. */
  | 'signature-meta'
  /**
   * Une signature HMAC entre NOS services, avec un secret partagé (`x-mm-service-signature`) : c'est ainsi
   * que le connecteur HubSpot pousse ses événements.
   *
   * 🔴 DISTINCTE DE `signature-meta`, ET LA REVUE A TROUVÉ QUE JE L'AVAIS CLASSÉE `code-url`. Ce n'est pas
   * un détail de nommage : son adresse ne porte AUCUN code, donc la classe annoncée était vérifiablement
   * fausse, et une justification fausse inscrite ici aurait été recopiée par le prochain lecteur, qui en
   * aurait déduit qu'une adresse devinable suffit à autoriser un appel.
   */
  | 'signature-service'
  /** Le secret d'exploitation, autorité SÉPARÉE du JWT. */
  | 'jeton-ops'
  /** Une clé d'API de client, autorité séparée elle aussi. */
  | 'cle-api';

/** Les gardes que `buildServer` construit une fois et distribue aux modules. */
export interface Gardes {
  /**
   * Tout compte authentifié. `PreHandler` et non `Guard` : c'est UN prehandler, pas une liste, et
   * `registerInbox` en dépend (il la compose lui-même avec sa garde d'effacement). Le déclarer `Guard`
   * ici compilait pour 28 modules sur 29 et échouait sur celui-là, ce qui est exactement le genre d'écart
   * qu'un contrat trop large cache.
   *
   * 🔴 LES TROIS GARDES SONT REQUISES DEPUIS LE LOT 2 (plan 2026-09-14). Elles étaient optionnelles, et un
   * module qui en recevait une absente montait ses routes SANS CONTRÔLE, en silence. Quand
   * l'authentification n'est pas câblée, elles valent un refus, jamais `undefined`.
   */
  readonly auth: PreHandler;
  /** Compte `admin` seulement. Une LISTE (`[auth, role]`), d'où `Guard`. */
  readonly admin: Guard;
  /** `admin` ou `manager` : consulter n'est pas décider (écrans de conformité). */
  readonly encadrement: Guard;
  /** Le second plafond de débit, composé route par route sur les seules routes coûteuses. */
  readonly limiteCouteuse?: PreHandler;
}

/** Une entrée du registre, une fois son type de dépendances effacé (voir `entree`). */
export interface ModuleMonte {
  readonly nom: string;
  readonly acces: ClasseDAcces;
  /** Ses dépendances ont-elles été fournies ? C'est ce qui décide s'il se monte. */
  readonly fourni: boolean;
  readonly monte: (app: FastifyInstance, gardes: Gardes) => void;
}

/**
 * Déclare un module montable. `D` est inféré depuis `deps`, donc `monter` le reçoit NON NUL.
 *
 * 🔴 C'EST CE QUI SUPPRIME LES `deps.x!` ET LES 49 `if (deps.x)` D'UN COUP. Le test de présence vit ICI, en
 * un seul endroit, et la closure capture `D` : un module ne peut plus être monté avec des dépendances
 * absentes, et personne n'a plus à l'écrire. L'entrée rendue a un type UNIFORME, ce qui permet de les
 * ranger dans une seule liste malgré 48 types de dépendances différents.
 *
 * ⚠️ La variance d'arité reste DANS la closure (de 2 à 5 paramètres selon le module, `registerInbox` en
 * prend 5) : elle est ainsi visible au point de montage, au lieu d'être aplatie dans un contrat commun qui
 * aurait forcé 45 signatures à changer.
 *
 * ⚠️ LE TEST EST `!== undefined`, PAS LA VÉRACITÉ, et la nuance est délibérée. Les 49 `if (deps.x)` d'avant
 * montaient sur la véracité : un module dont les dépendances auraient valu `null` ne se montait pas, en
 * silence. Ici il se monterait, et échouerait au montage, ce qui est le bon sens de l'échec (`null` n'est pas
 * « absent », c'est un câblage fautif). Vérifié : aucun appelant du dépôt ne passe une valeur fausse mais
 * définie, donc le changement est inerte aujourd'hui.
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
      if (deps !== undefined) monter(app, deps, gardes);
    },
  };
}

/**
 * LE REGISTRE DES MODULES DE ROUTES. Il remplace 49 `if (deps.x) registerX(...)` et une liste de 40 noms
 * recopiée à la main.
 *
 * 🔴 CE QUI CHANGE VRAIMENT : la couverture du garde-fou d'authentification se DÉRIVE de ce registre. Avant,
 * elle était une seconde liste, écrite à côté des montages, et il fallait penser à l'allonger : elle a déjà
 * couvert 18 modules sur 36 (audit de surface publique du 2026-09-03), les 18 autres se montant sans garde en
 * silence, `scopeTenant` distribuant alors à chacun l'espace qu'il demandait dans l'URL. Mesuré le
 * 2026-09-14 : les 40 noms d'alors étaient exacts, donc il n'y avait pas de trou VIVANT. Le défaut était dans
 * la forme, et il attendait le 41e module.
 *
 * 🔴 ELLE EST EXPORTÉE POUR ÊTRE EXERCÉE, et c'est la moitié qui manquait. Le garde-fou était vérifié par un
 * test qui relisait le TEXTE de ce fichier, avec sa propre copie de la liste : il prouvait une orthographe,
 * pas un comportement, et sa liste pouvait dériver comme l'autre. `tests/scope-tenant.test.ts` monte
 * désormais CHAQUE module tenant, un par un, et vérifie que le serveur refuse de démarrer sans garde.
 *
 * ⚠️ Ce garde-fou et la fermeture de `scopeTenant` (`src/http/scope.ts`) restent les DEUX moitiés du même
 * correctif.
 *
 * ⚠️ L'ORDRE DE CETTE LISTE EST L'ORDRE DE MONTAGE, et il reproduit exactement celui d'avant le registre :
 * les cinq surfaces sans session d'abord (webhook, exploitation, liens tracés, webhooks entrants, rappels
 * RCS), puis les modules gardés. La table de routes produite est identique au caractère, vérifié.
 */
export function modulesDeRoutes(deps: ServerDeps, usageApi: ApiUsageGuard): readonly ModuleMonte[] {
  return [
    // La réception des webhooks Meta : autorité = la signature du corps, vérifiée dans le module.
    entree('receiver', 'signature-meta', deps.queue, (app, queue) => registerReceiver(app, queue, {
      verifyToken: deps.verifyToken ?? config.META_VERIFY_TOKEN,
      appSecret: deps.appSecret ?? config.META_APP_SECRET,
    })),
    // Surface /ops : autorité SÉPARÉE du JWT (secret d'env, comme le webhook). Montée dès que les deps
    // sont fournies ; le guard renvoie 401 si OPS_TOKEN est vide (désactivé) ou incorrect.
    // ⚠️ LE GARDE D'USAGE EST INJECTÉ DANS `/ops` COMME DANS LES ROUTES `/v1` : c'est la même instance, donc
    // l'écran d'exploitation montre exactement ce que les routes ont compté, sans second exemplaire.
    entree('ops', 'jeton-ops', deps.ops, (app, d) => registerOps(app, { ...d, usage: usageApi }, deps.opsToken ?? config.OPS_TOKEN, deps.surveillanceOps)),
    // Redirection des liens tracés : PUBLIQUE, montée ici avec le webhook et /ops, avant les gardes d'auth.
    // Aucune session n'est possible sur cette route (un destinataire clique depuis WhatsApp).
    entree('links', 'code-url', deps.links, (app, d) => registerLinks(app, d)),
    // Réception des webhooks entrants : PUBLIQUE elle aussi, montée ici avant les gardes d'auth. Aucune session
    // n'est possible (l'appelant est un outil tiers, pas un humain).
    entree('webhookEntrant', 'code-url', deps.webhookEntrant, (app, d) => registerWebhookEntrant(app, d)),
    // Rappels du fournisseur RCS : PUBLIQUE aussi, et pour la même raison (l'appelant est smsmode, pas un
    // humain). Ce qui l'autorise est le code opaque de l'URL, pas une session ; voir `registerRcsCallback`.
    entree('rcsCallback', 'code-url', deps.rcsCallback, (app, d) => registerRcsCallback(app, d)),
    entree('auth', 'anonyme', deps.auth, (app, d, g) => registerAuth(app, d, g.auth)),
    entree('import', 'tenant', deps.import, (app, d, g) => registerImport(app, d, g.admin, g.limiteCouteuse)),
    entree('campaigns', 'tenant', deps.campaigns, (app, d, g) => registerCampaigns(app, d, g.admin, g.limiteCouteuse)),
    // Bibliothèque RCS : montée avec `auth` et non `admin`, car la LISTE doit être lisible par un
    // agent (le bloc de scénario et l'assistant de campagne la proposent). Les écritures sont gardées dans les
    // handlers par `forbidNonAdmin`, comme pour les templates.
    entree('rcsMessages', 'tenant', deps.rcsMessages, (app, d, g) => registerRcsMessages(app, d, g.auth)),
    entree('rcsChannel', 'tenant', deps.rcsChannel, (app, d, g) => registerRcsChannel(app, d, g.auth)),
    // Visuels RCS. Monté avec `auth` alors qu'il porte AUSSI une route publique `/m/<code>.<ext>` : les
    // gardes de ce projet sont posées par route (`preHandler`), pas par groupe, donc la route de lecture
    // reste ouverte comme elle doit l'être. C'est l'opérateur télécom qui télécharge l'image, sans session.
    entree('rcsMedia', 'tenant', deps.rcsMedia, (app, d, g) => registerRcsMedia(app, d, g.auth)),
    // Templates : la LISTE (GET) doit rester lisible par l'agent — l'inbox en a besoin pour envoyer
    // un template hors fenêtre 24h (seul moyen de re-contacter). La CRÉATION (POST) reste admin-only
    // via le forbidNonAdmin dans le handler. La page /templates de gestion est masquée à l'agent côté UI.
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
    // ⚠️ `g.admin` COMME LES ÉCRITURES MBA : la conversation ne doit pas être un chemin plus permissif que
    // le formulaire, sinon elle devient un contournement du contrôle d'accès. La route repose la garde
    // elle-même (`forbidNonAdmin`), les deux étant voulues : celle-ci monte, celle-là explique.
    entree('mbaAssistant', 'tenant', deps.mbaAssistant, (app, d, g) => registerMbaAssistant(app, d, g.admin)),
    // ⚠️ ADMIN comme ce qu'il journalise : ce journal porte le CONTENU des éléments supprimés, un accès plus
    // large que les écritures qu'il décrit serait une fuite.
    entree('historique', 'tenant', deps.historique, (app, d, g) => registerHistorique(app, d, g.admin)),
    entree('agentSources', 'tenant', deps.agentSources, (app, d, g) => registerAgentSources(app, d, g.admin)),
    // Reservees aux ADMINS comme les sources : decrire une requete, c est decider ce qu on envoie au systeme
    // d un client, et le bouton Test rend la reponse ENTIERE pour que le client y choisisse ses champs.
    entree('agentRequetes', 'tenant', deps.agentRequetes, (app, d, g) => registerAgentRequetes(app, d, g.admin)),
    entree('agentSetup', 'tenant', deps.agentSetup, (app, d, g) => registerAgentSetup(app, d, g.admin)),
    entree('agentTest', 'tenant', deps.agentTest, (app, d, g) => registerAgentTest(app, d, g.admin)),
    entree('media', 'tenant', deps.media, (app, d, g) => registerMedia(app, d, g.admin)),
    entree('tags', 'tenant', deps.tags, (app, d, g) => registerTags(app, d, g.admin)),
    entree('fields', 'tenant', deps.fields, (app, d, g) => registerFields(app, d, g.admin)),
    entree('support', 'tenant', deps.support, (app, d, g) => registerSupport(app, d, g.auth)),
    entree('aide', 'tenant', deps.aide, (app, d, g) => registerAide(app, d, g.auth)),
    entree('contacts', 'tenant', deps.contacts, (app, d, g) => registerContacts(app, d, g.admin, g.limiteCouteuse)),
    entree('workflows', 'tenant', deps.workflows, (app, d, g) => registerWorkflows(app, d, g.admin)),
    entree('workflowReports', 'tenant', deps.workflowReports, (app, d, g) => registerWorkflowReports(app, d, g.admin)),
    entree('automations', 'tenant', deps.automations, (app, d, g) => registerAutomations(app, d, g.auth)),
    // `auth` et non `admin` : les ecrans de la chaine se LISENT avec un compte agent, et les six
    // ecritures sont fermees dans la route par `forbidNonAdmin`.
    entree('channelsMe', 'tenant', deps.channelsMe, (app, d, g) => registerChannelsMeRoutes(app, d, g.auth)),
    entree('embeddedSignup', 'tenant', deps.embeddedSignup, (app, d, g) => registerEmbeddedSignup(app, d, g.admin)),
    entree('hubspotImport', 'tenant', deps.hubspotImport, (app, d, g) => registerHubspotImport(app, d, g.admin)),
    entree('hubspotInstall', 'tenant', deps.hubspotInstall, (app, d, g) => registerHubspotInstall(app, d, g.admin)),
    entree('hubspotPipelines', 'tenant', deps.hubspotPipelines, (app, d, g) => registerHubspotPipelines(app, d, g.admin)),
    entree('mba', 'tenant', deps.mba, (app, d, g) => registerMba(app, d, g.admin)),
    entree('email', 'tenant', deps.email, (app, d, g) => registerEmailRoutes(app, d, g.admin)),
    entree('apiKeys', 'tenant', deps.apiKeys, (app, d, g) => registerApiKeys(app, d, g.admin)),
    entree('webhooksAdmin', 'tenant', deps.webhooksAdmin, (app, d, g) => registerWebhooksAdmin(app, d, g.admin)),
    /**
     * API publique /v1 et serveur MCP : UNE SEULE entrée pour les trois montages, et c'est délibéré.
     *
     * 🔴 LES TROIS PARTAGENT UNE AUTORITÉ ET UN LIMITEUR, et c'est un invariant, pas une commodité : une
     * seconde instance de limiteur aurait doublé le quota d'une clé selon la porte empruntée, ce qui
     * n'aurait été visible de personne. Les séparer en trois entrées aurait permis de les monter
     * indépendamment, donc de casser ça sans le voir.
     */
    entree('v1', 'cle-api', deps.v1, (app, v1) => {
      const apiLimiter = new RateLimiter(config.API_KEY_RATE_LIMIT_MAX, config.API_KEY_RATE_LIMIT_WINDOW_MS);
      /**
       * 🔴 LE PRÉ-FILTRE : indexé sur l'EMPREINTE du bearer présenté, donc sur une clé choisie par
       * l'APPELANT. Sa table porte le même plafond de 10 000 clés que les limiteurs d'authentification, et
       * pour la même raison : la purge ne retire que les entrées EXPIRÉES, donc sous flot rien n'expire et
       * la table grossirait pendant toute la fenêtre. Au-delà, une empreinte NEUVE est refusée pendant que
       * les porteurs déjà connus continuent d'être servis.
       */
      const apiPrefiltre = new RateLimiter(config.API_KEY_PREFILTRE_MAX, config.API_KEY_RATE_LIMIT_WINDOW_MS, () => Date.now(), 10_000);
      const requireApiKey = makeRequireApiKey(v1.apiKeys, apiLimiter, apiPrefiltre);
      registerV1Contacts(app, { ...v1.contacts, usage: usageApi }, [requireApiKey, requireScope('contacts:write')]);
      if (v1.sends) registerV1Sends(app, { ...v1.sends, usage: usageApi }, [requireApiKey, requireScope('sends:create')]);
      // Serveur MCP : MÊME autorité et MÊME limiteur de débit que /v1. Il partage volontairement le
      // `requireApiKey` déjà construit.
      //
      // Pas de `requireScope` ici : le serveur MCP a DEUX scopes (lecture, écriture) et c'est l'outil appelé
      // qui décide duquel il a besoin. Un `requireScope` à la porte aurait forcé à en choisir un des deux, et
      // donc soit fermé l'écriture, soit ouvert la lecture aux seules clés qui écrivent.
      if (v1.mcp) registerMcp(app, v1.mcp, [requireApiKey], usageApi);
    }),
    // Accueil : statut compte réservé aux admins (la page /accueil est admin-only) ; /me ouvert à tout
    // compte authentifié (générique, lit req.auth.userId).
    entree('account', 'tenant', deps.account, (app, d, g) => registerAccount(app, d, g.admin)),
    entree('me', 'tenant', deps.me, (app, d, g) => registerMe(app, d, g.auth)),
  ];
}

/**
 * Construit l'instance Fastify (le bouclier). La file et les stores sont injectés pour
 * rester testable sans DB. Les routes tenant (import/campaigns) EXIGENT l'auth : le tenant
 * est dérivé du JWT, jamais de l'URL.
 */
export function buildServer(deps: ServerDeps): FastifyInstance {
  /**
   * 🔴 LE GARDE D'USAGE DE L'API PUBLIQUE, UNE SEULE INSTANCE POUR TOUTE LA SURFACE. Il compte le TRAVAIL,
   * là où les limiteurs comptent les requêtes : avec 60 requêtes par minute, une clé fait accepter 30 000
   * contacts ou 3 000 destinataires, donc le débit ne borne pas la charge. Deux instances auraient donné
   * deux moitiés de compteurs selon la porte empruntée, ce qui n'aurait été visible de personne.
   *
   * ⚠️ EN OBSERVATION : construit sans plafond. Les seuils viendront d'une mesure et d'un arbitrage de
   * Julien, jamais d'un plan. Un seuil deviné qui mord est une panne qu'on s'inflige.
   *
   * ⚠️ IL EST CRÉÉ AVANT LE REGISTRE, parce que l'entrée `/ops` et l'entrée `/v1` le capturent toutes les
   * deux : l'écran d'exploitation et les routes publiques doivent regarder LE MÊME compteur.
   */
  const usageApi = deps.usage ?? new GardeUsageMemoire(120, 0, () => Date.now(), config.API_MAX_LOURDES_SIMULTANEES);

  // Le registre vit au niveau du module (`modulesDeRoutes`) pour qu'un test puisse l'exercer sans monter
  // le serveur entier. C'est ce qui remplace le test qui relisait le texte de ce fichier.
  const registre = modulesDeRoutes(deps, usageApi);

  /**
   * 🔴 AUCUNE ROUTE PORTANT `:tenantId` NE SE MONTE SANS AUTHENTIFICATION.
   *
   * La couverture est DÉRIVÉE du registre : tout module déclaré `acces: 'tenant'` y entre, sans que personne
   * ait à l'inscrire ailleurs. C'est la seule différence avec la version d'avant, et c'est toute la valeur du
   * lot : l'oubli n'est plus détectable, il est impossible.
   */
  if (registre.some((m) => m.acces === 'tenant' && m.fourni) && !deps.auth) {
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

  /**
   * 🔴 SANS `deps.auth`, LA GARDE VAUT UN REFUS, JAMAIS `undefined` (lot 2 du plan 2026-09-14).
   *
   * C'est la différence entre « personne ne s'en sert » et « quelqu'un s'en sert et elle ne fait rien ».
   * Avant, ces trois gardes étaient `undefined` quand l'authentification n'était pas câblée, et chaque module
   * de routes les recevait en paramètre OPTIONNEL puis les dégradait en silence (`garde ? { preHandler } :
   * {}`, le motif était dans 45 endroits) : une route montée sans garde était servie SANS AUCUN CONTRÔLE.
   *
   * ⚠️ AUCUN CHEMIN N'Y MÈNE AUJOURD'HUI, et ce n'est pas une raison de s'en passer. Le garde-fou plus haut
   * refuse déjà de démarrer si un module `acces: 'tenant'` est monté sans `deps.auth`, et le seul module non
   * tenant qui prend une garde est `auth` lui-même, qui n'est pas monté dans ce cas. Ce refus est donc
   * inatteignable : il existe pour que l'inatteignabilité cesse de dépendre d'un raisonnement, et pour que
   * le type puisse exiger une garde partout.
   */
  const refuseTout: PreHandler = async (_req, reply) => {
    await reply.code(401).send({ error: 'authentification non configurée' });
  };
  const requireAuth = deps.auth ? makeRequireAuth(deps.auth.secret, deps.auth.getUserState, plafondUtilisateur) : refuseTout;
  // RBAC : tout est réservé aux admins SAUF l'inbox (le seul périmètre de l'agent). La barrière
  // est au preHandler (source de vérité serveur) ; l'UI ne fait que masquer/rediriger en confort.
  const requireAdmin: Guard = [requireAuth, makeRequireRole(['admin'])];
  /**
   * L'ENCADREMENT : `admin` ET `manager`.
   *
   * 🔴 OUVERT AUX ÉCRANS DE CONFORMITÉ LE 2026-09-14, sur décision de Julien. Le rôle `manager` existait
   * depuis la migration 0065 et donnait exactement les accès d'un agent ; le centre de Sécurité a livré la
   * première route qui le nomme, et la revue du chantier a montré qu'elle était INERTE (la console renvoyait
   * tout compte non-admin à l'inbox). Les deux moitiés bougent donc ensemble, ici et dans `web/lib/nav.ts`.
   *
   * ⚠️ CONSULTER N'EST PAS DÉCIDER. Un manager LIT la liste des désabonnés, la politique d'annonce d'IA et
   * les deux journaux ; il ne branche aucun connecteur et ne change aucune politique. Ces écritures-là
   * restent sur `requireAdmin`, et l'écran masque ce qu'il ne peut pas faire.
   */
  const requireEncadrement: Guard = [requireAuth, makeRequireRole(['admin', 'manager'])];

  /**
   * LE MONTAGE, en une seule boucle sur le registre.
   *
   * 🔴 IL N'Y A PLUS DE LISTE D'APPELS À TENIR ICI. Avant, chaque module apparaissait sous la forme
   * `if (deps.x) registerX(app, deps.x, <la bonne garde>)`, et TROIS choses pouvaient s'y perdre sans que
   * rien ne le signale : le module lui-même (simplement oublié, la route n'existe alors pas), sa garde
   * (passée `undefined`, donc dégradée en silence par le module), et son inscription dans la liste de
   * couverture tenant. Les trois vivent désormais dans son entrée de registre, et le type les exige.
   *
   * ⚠️ L'ordre de montage est celui du registre, et il reproduit l'ancien exactement : c'est ce que vérifie
   * l'essai de ce lot (la table de routes, avant contre après).
   */
  const gardes: Gardes = {
    auth: requireAuth,
    admin: requireAdmin,
    encadrement: requireEncadrement,
    limiteCouteuse,
  };
  for (const m of registre) m.monte(app, gardes);

  return app;
}
