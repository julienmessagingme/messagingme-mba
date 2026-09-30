import { setTimeout as dormir } from 'node:timers/promises';
import type { Pool } from 'pg';
import type { Config } from './config';
import type { Queue } from './queue/queue';
import { cacheCourt } from './lib/cache-court';
import { FetchTransport } from './meta/http';
import { PgCampaignRepo, PgRecipientStore } from './campaign/store.pg';
import { PgIntegrationBatchStore } from './signaux/integration-batch.pg';
import { creerEmetteur, annoncerAussiAuxSignaux, DUREE_CACHE_ESPACES_ACTIFS_MS } from './signaux/emetteur';
import { FILE_SIGNAUX_BATCH } from './signaux/batch';
import { creerAnnonceOptOut, FILE_POUSSEE_OPTOUT } from './crm/poussee-optout';
import { PgContactStore } from './crm/contact-store.pg';
import { PgUserFieldStore } from './crm/field-store.pg';
import { PgInboxStore } from './inbox/store.pg';
import { PgTenantSettingsStore } from './settings/store.pg';
import { PgFlowStore } from './flow/store.pg';
import { PgApiIdempotencyStore } from './api/idempotency-store.pg';
import { PgAuditStore } from './audit/store.pg';
import { PgErreursLivraisonStore } from './ops/erreurs-livraison.pg';
import { PgEchecsMessagesStore } from './delivery/echecs-messages.pg';
import { PgPoolAttentesStore } from './ops/pool-attentes.pg';
import { PgWorkflowNodeEventStore } from './workflow/node-events.pg';
import { PgTrackedLinkStore } from './links/tracked-links.pg';
import { PgWebhookStore } from './webhook-entrant/store.pg';
import { PgPhoneStatusStore } from './account/store.pg';
import { PgNumeroDelieStore } from './account/numero-delie.pg';
import { creerGardeNumeroDelie } from './meta/numero-delie';
import { PgOpsStore } from './ops/store.pg';
import { PgWorkerHeartbeatStore } from './ops/heartbeat-store.pg';
import { PgWorkflowStore } from './workflow/store.pg';
import { PgAutomationStore } from './automation/store.pg';
import { PgAgentStore } from './agent/agent-store.pg';
import { PgKnowledgeStore } from './agent/knowledge.pg';
import { creerRechercheSemantique } from './agent/recherche';
import { PgToolCatalog, PgJournalAppels } from './agent/catalog.pg';
import { PgCreditStore } from './agent/credits.pg';
import { PgSourceStore } from './agent/sources.pg';
import { PgRequeteStore } from './agent/requetes.pg';
import { PgTestRunStore } from './agent/test-runs.pg';
import { PgDepotAide } from './aide/fiches.pg';
import { PgEmailAccountStore } from './email/account-store.pg';
import { PgEmailTemplateStore } from './email/template-store.pg';
import { EmailAccountResolver } from './email/resolver';
import { buildTransport as buildEmailTransport } from './email/smtp';
import { creerNumeroDeLEspace } from './meta/numero-espace';
import { PgEmbeddedSignupStore } from './account/es-store.pg';
import { MetaCredentialsResolver } from './meta/credentials';
import { MetaClientFactory } from './meta/factory';
import { arbitreDeDebit } from './meta/arbitre-debit';
import { arbitreDeDebitPartage, depsPorteDebitPg } from './meta/arbitre-debit-partage';
import { decryptSecret, encryptSecret } from './crypto/secretbox';
import { PgCleGatewayStore } from './agent/cles-gateway.pg';
import { journaliser } from './lib/journal';
import { PgPubConnexionStore } from './pubs/connexion.pg';
import { PgPublicitesStore } from './pubs/publicites.pg';
import { MetaPubsClient } from './meta/pubs';
import { MetaPubsCreationClient } from './meta/pubs-creation';
import { buildWorkflowRuntime } from './workflow/wiring';
import { PgWorkflowRunStore } from './workflow/run-store.pg';
import { creerControleDuFil } from './inbox/fil';
import { creerListeDeLAgent } from './mba/liste';
import { PgListeStore } from './mba/liste.pg';
import { PgVerrousCourts } from './db/verrous-courts.pg';
import { PgCompteurDebit } from './db/debit.pg';
import { PgSignauxStore } from './signaux/store.pg';

/**
 * Ce que le socle lit de la configuration qu'on lui passe. Les autres réglages restent aux racines qui les consomment ;
 * `buildWorkflowRuntime` et la recherche sémantique lisent en plus la configuration globale du processus.
 */
export type ConfigSocle = Pick<Config,
  | 'DRY_RUN' | 'PGBOSS_SCHEMA' | 'ENCRYPTION_KEY' | 'META_ACCESS_TOKEN' | 'META_APP_ID' | 'META_APP_SECRET'
  | 'META_GRAPH_VERSION' | 'META_MM_LITE' | 'PHONE_RATE_PER_MINUTE_MAX' | 'RCS_PROVIDER' | 'CREDIT_OFFERT_MICRO_EUR'
>;

export interface DepsSocle {
  /**
   * Le pool applicatif du processus. Reçu, jamais importé : chaque processus a le sien, dimensionné pour lui
   * (`src/db/pool.ts`, `DB_POOL_MAX` est compté par processus).
   */
  pool: Pool;
  /**
   * La file du processus, déjà construite : l'API empile sans superviser, le worker supervise et écoute les
   * notifications. Le socle ne fait qu'y enfiler.
   */
  queue: Pick<Queue, 'enqueue'>;
  config: ConfigSocle;
}

/**
 * Le socle commun aux deux processus : ce que l'API (`src/index.ts`) et le worker (`src/worker.ts`) doivent
 * construire à l'identique, écrit une fois. Un second exemplaire divergerait sans erreur, et le jour où il
 * diverge c'est un invariant qui tombe d'un seul côté (un opt-out écrit par le worker qui ne serait plus annoncé,
 * un envoi de l'API qui échapperait au frein du numéro).
 *
 * 🔴 Appelé UNE fois par racine. Chaque cache qu'il porte (WABA et numéro de l'espace, garde du numéro délié, jetons
 * Meta, transports SMTP, espaces branchés sur un outil, caches du runtime de scénario) est donc PAR PROCESSUS, jamais
 * partagé entre l'API et le worker, et borné par un délai court. L'appeler deux fois dans un processus doublerait
 * ces caches et rendrait leurs invalidations inopérantes pour l'autre exemplaire (« Délier » ne viderait pas la
 * garde qui refuse les envois).
 *
 * Ce qui n'existe que dans un processus reste dans sa racine, et ce qui s'y construit différemment aussi : la file
 * elle-même, le dépôt des statistiques de conversation (l'affichage de l'API lit l'état de la fonction, le worker
 * n'écrit que des agrégats) et le client de modèle (`GatewayChatClient`), qui lit la clé par espace du socle. Rien ici ne fait d'entrée-sortie à la construction :
 * l'ordre d'appel dans une racine ne change donc que l'ordre des déclarations.
 */
export function construireSocle({ pool, queue, config }: DepsSocle) {
  /**
   * DRY_RUN : aucun appel Meta. Il gouverne le runtime de scénario, donc l'Inbox de l'API autant que le worker :
   * sans lui, un déploiement déclaré DRY_RUN enverrait pour de vrai depuis l'Inbox.
   */
  const dryRun = config.DRY_RUN === 'true';
  const transport = new FetchTransport();

  const repo = new PgCampaignRepo(pool);
  // Les statuts de livraison : le worker applique ceux de Meta, l'API les rappels du fournisseur RCS (le worker
  // n'expose aucune route publique).
  const recipientStore = new PgRecipientStore(pool);

  /**
   * Les signaux : ce que la console remonte vers l'outil d'un client. Les deux processus en émettent (le worker :
   * accusés, réponses, STOP, analyses ; l'API : rappels RCS, clics sur un lien suivi, désabonnements écrits depuis
   * la console ou l'API publique). L'émetteur ne connaît aucun outil : chaque adaptateur est une destination, sa
   * file et ses espaces actifs lus à travers un cache court. L'API invalide ce cache à l'enregistrement du réglage
   * (d'où `espacesBatch` rendu) ; le worker rattrape un branchement en une minute au plus.
   */
  const integrationBatch = new PgIntegrationBatchStore(pool);
  const espacesBatch = cacheCourt<ReadonlySet<string>>(DUREE_CACHE_ESPACES_ACTIFS_MS);
  const emetteur = creerEmetteur({
    destinations: [{ file: FILE_SIGNAUX_BATCH, espacesActifs: () => espacesBatch.lire('actifs', () => integrationBatch.espacesActifs()) }],
    queue,
    // eslint-disable-next-line no-console
    log: (m) => console.warn(m),
  });
  /**
   * 🔴 L'annonce d'un opt-out, posée sur le dépôt lui-même : elle couvre par construction toutes ses méthodes
   * capables d'écrire `opted_out` (liste dérivée par `tests/optout-poussee.test.ts`), au lieu d'être recopiée sur
   * chaque appelant. Et elle est posée ICI, pour les deux processus : le STOP d'un message entrant est écrit par le
   * worker, la fiche, l'action en masse et l'API publique par l'API. Sans elle d'un côté, le chemin le plus
   * important, celui où la personne elle-même refuse, serait muet. Elle n'appelle rien, elle enfile ; l'appel au
   * connecteur vit dans le worker. Gardé par `tests/socle.test.ts`, qui écrit un opt-out par ce dépôt.
   */
  const contactStore = new PgContactStore(
    pool,
    annoncerAussiAuxSignaux(
      creerAnnonceOptOut({
        enfiler: (job, opts) => queue.enqueue(FILE_POUSSEE_OPTOUT, job, opts),
        // eslint-disable-next-line no-console
        log: (m) => console.warn(m),
      }),
      emetteur,
    ),
  );
  // Les définitions de champs : l'API les écrit (import, API publique), le worker déclare les champs « Pub » la
  // première fois qu'un contact arrive par une publicité (sans définition, la valeur serait invisible du CRM).
  const fieldStore = new PgUserFieldStore(pool);
  const inboxStore = new PgInboxStore(pool);
  const settingsStore = new PgTenantSettingsStore(pool);
  const flowStore = new PgFlowStore(pool);
  const idempotencyStore = new PgApiIdempotencyStore(pool);
  const auditStore = new PgAuditStore(pool);
  // Le journal des erreurs : l'API le lit (exploitation, statistiques), le worker y écrit les échecs d'avance de
  // scénario, qui sinon disparaîtraient dans un `console.error`.
  const erreursLivraison = new PgErreursLivraisonStore(pool);
  // Les échecs des messages libres : écrits par les deux files d'accusés du worker et par le rapport de smsmode
  // reçu par l'API, purgés par le balayage de rétention.
  const echecsMessages = new PgEchecsMessagesStore(pool);
  const poolAttentesStore = new PgPoolAttentesStore(pool);
  const nodeEventStore = new PgWorkflowNodeEventStore(pool);
  const trackedLinkStore = new PgTrackedLinkStore(pool);
  const webhookStore = new PgWebhookStore(pool);
  /**
   * Les verrous courts (`src/db/verrous-courts.ts`) : ce qui ne doit arriver qu'une fois pour toutes les copies de
   * l'API (anti-rejeu des envois de l'agent de Meta, publication du relais). L'API les prend, le worker purge les
   * clés échues : aucun cache, donc rien qui diffère d'un processus à l'autre.
   */
  const verrousCourts = new PgVerrousCourts(pool);
  /**
   * Le compteur des plafonds de débit (`src/db/debit.ts`, migration 0186) : ce qui doit être tenu au TOTAL de toutes
   * les copies de l'API (l'API publique par espace, les opérations coûteuses, la connexion, l'usage de `/ops`). L'API
   * compte, le worker efface les fenêtres échues. Aucun cache ici : la mémoire des fenêtres pleines, propre à une
   * copie, est posée par `buildServer`.
   */
  const compteurDebit = new PgCompteurDebit(pool);
  const phoneStatusStore = new PgPhoneStatusStore(pool);
  const opsStore = new PgOpsStore(pool, config.PGBOSS_SCHEMA);
  const heartbeatStore = new PgWorkerHeartbeatStore(pool);
  const workflowStore = new PgWorkflowStore(pool);
  const automationStore = new PgAutomationStore(pool);

  // Les dépôts des agents. Le worker ne s'en sert que si la clé du Gateway est posée, l'API sans condition : ce ne
  // sont que des enveloppes autour du pool, les construire ne coûte rien.
  const agentStore = new PgAgentStore(pool);
  const knowledgeStore = new PgKnowledgeStore(pool);
  /**
   * Une seule fabrique pour l'agent, le bac à sable et le balayage qui vectorise : plusieurs constructions seraient
   * autant d'occasions de câbler un modèle ou un seuil différent. `null` sans clé du Gateway.
   */
  const rechercheSemantique = creerRechercheSemantique();
  const toolCatalog = new PgToolCatalog(pool);
  const journalAppels = new PgJournalAppels(pool);
  const credits = new PgCreditStore(pool);
  const agentSources = new PgSourceStore(pool);
  // Les requêtes de connecteur : un appel mis au point une fois dans la bibliothèque de l'espace, que l'outil d'un
  // agent, un bloc de scénario ou la poussée d'un opt-out désigne au lieu de le redécrire.
  const agentRequetes = new PgRequeteStore(pool);
  // Ce que la dernière analyse dit d'un contact, pour les variables de connecteur `CLES_ANALYSE`. Les QUATRE câblages
  // de `creerAppelConnecteur` (scénario, agent IA, poussée d'un opt-out, relais du MBA) le reçoivent.
  const lecturesAnalyse = new PgSignauxStore(pool);
  const essaisStore = new PgTestRunStore(pool);
  // Les fiches du mode d'emploi de la console : l'API y cherche, le worker les vectorise.
  const depotAide = new PgDepotAide(pool);

  /**
   * Node « Envoi de mail » : boîtes SMTP et modèles (scopés tenant), résolveur de transport à cache par
   * tenant+compte. Les routes e-mail de l'API l'invalident à chaque écriture d'un compte, et le runtime de scénario
   * reçoit la MÊME instance, pour que l'invalidation vaille aussi pour lui. Elle ne traverse pas jusqu'au worker :
   * un compte modifié y garde son ancien transport jusqu'à l'expiration du cache (cinq minutes).
   */
  const emailAccounts = new PgEmailAccountStore(pool);
  const emailTemplates = new PgEmailTemplateStore(pool);
  const emailResolver = new EmailAccountResolver({
    comptes: emailAccounts,
    buildTransport: buildEmailTransport,
  });

  /**
   * La pile d'envoi Meta et ses freins. Résolution du jeton par espace, avec repli sur `META_ACCESS_TOKEN` tant
   * qu'un WABA n'a pas d'identifiants propres. Le WABA de l'espace est lu une fois par processus (le cache de jeton
   * est indexé par WABA, cette requête passait avant lui à chaque construction de client) ; seules les réponses
   * positives entrent en cache.
   */
  const wabaDeLEspace = creerNumeroDeLEspace((t) => repo.getTenantWabaId(t));
  /**
   * Le numéro délié : une garde par processus, en cache court (`NUMERO_DELIE_TTL_MS`), qui fait refuser les envois
   * par la fabrique. Les routes Délier et Relier de l'API vident CETTE instance, celle de la copie qui sert la
   * requête : les autres copies de l'API, comme le worker, gardent leur réponse jusqu'à 5 s. Le worker lit les
   * entrants et la pause de campagne sur le dépôt, sans cache.
   */
  const numeroDelieStore = new PgNumeroDelieStore(pool);
  const gardeNumeroDelie = creerGardeNumeroDelie((pn) => numeroDelieStore.estDelie(pn));
  // Le crédit offert au premier numéro que Meta dit vérifié (`CREDIT_OFFERT_MICRO_EUR`, cf. `src/config.ts`) : seules
  // les routes de l'inscription et de l'activation le demandent (`offrirCredit`), jamais la liaison elle-même.
  const esCredentialsStore = new PgEmbeddedSignupStore(pool, { creditOffertMicroEur: config.CREDIT_OFFERT_MICRO_EUR });
  const metaCredentials = new MetaCredentialsResolver({
    getWabaIdForTenant: wabaDeLEspace,
    credentials: esCredentialsStore,
    decrypt: (enc) => decryptSecret(enc, config.ENCRYPTION_KEY),
    fallbackToken: config.META_ACCESS_TOKEN,
  });
  /**
   * La liste de l'agent de Meta (`src/mba/liste.ts`, migration 0195) : la fabrique y retire le destinataire avant
   * chaque modèle, le contrôle du fil y ajoute et en retire les contacts, la réception la lit. Elle reçoit le client
   * MBA par une fonction qui interroge la fabrique au moment du geste : la fabrique, construite juste après, dépend
   * d'elle.
   */
  const listeDeLAgent = creerListeDeLAgent({
    store: new PgListeStore(pool),
    clientMba: (t) => metaFactory.mbaClientForTenant(t),
    attendre: (ms) => dormir(ms),
  });
  const metaFactory = new MetaClientFactory({
    resolver: metaCredentials,
    transport,
    version: config.META_GRAPH_VERSION,
    marketingViaLite: config.META_MM_LITE === 'true',
    // Frein par numéro, partagé par tout ce qui envoie depuis lui. Le budget du numéro est partagé en base entre
    // l'API et le worker ; l'arbitre local reste dessous comme repli si la base de débit ne répond pas, donc le
    // pire cas est un frein local, jamais une absence de frein.
    arbitreDebit: arbitreDeDebitPartage(
      arbitreDeDebit(config.PHONE_RATE_PER_MINUTE_MAX),
      config.PHONE_RATE_PER_MINUTE_MAX,
      depsPorteDebitPg(pool),
    ),
    numerosDelies: gardeNumeroDelie,
    listeDeLAgent,
  });

  /**
   * Les publicités Click-to-WhatsApp. Le dépôt de connexion et celui des publicités servent l'écran et `/ops` dans
   * l'API, le routage d'un lead entrant et le suivi dans le worker (deux lectures sur clé sur le chemin chaud).
   * Deux clients Graph distincts : `clientPubs` lit (actifs accordés, campagne d'une publicité jamais vue, que le
   * worker mémorise ensuite) ; 🔴 `clientCreationPubs` crée une publicité sur le compte du client, donc dépense son
   * argent, et relit statuts et dépense pour le suivi. Une route de lecture ne doit pas avoir de quoi créer une
   * campagne.
   */
  const connexionsPub = new PgPubConnexionStore(pool);
  const publicites = new PgPublicitesStore(pool);
  const clientPubs = new MetaPubsClient(config.META_APP_ID, config.META_APP_SECRET, config.META_GRAPH_VERSION);
  const clientCreationPubs = new MetaPubsCreationClient(config.META_APP_ID, config.META_APP_SECRET, config.META_GRAPH_VERSION);

  /**
   * Le numéro Meta de l'espace, mis en cache pour le processus : le runtime de scénario le demande à chaque envoi,
   * le contrôle du fil à chaque geste chez Meta. Une instance, un cache.
   */
  const numeroDeLEspace = creerNumeroDeLEspace((t) => repo.getTenantPhoneNumberId(t));
  const runStore = new PgWorkflowRunStore(pool);

  /**
   * Le contrôle du fil (`src/inbox/fil.ts`) : le seul endroit qui confie une conversation à l'agent de Meta ou la
   * lui reprend (sa liste, `thread_control`) et écrit qui détient une conversation. Ici parce que les deux processus
   * s'en servent : l'Inbox de l'API (« Reprendre la main », « Rendre la main », un opérateur qui écrit), le worker
   * (réception, accusés, balayage) et le runtime de scénario, dans l'un comme dans l'autre.
   */
  const fil = creerControleDuFil({
    depot: inboxStore,
    reglages: settingsStore,
    parcours: runStore,
    numeros: { getTenantPhoneNumberId: numeroDeLEspace },
    liste: listeDeLAgent,
    consentement: {
      estDesabonne: (t, waId) => contactStore.estDesabonneParWaId(t, waId),
      estBloque: (t, waId) => contactStore.isBlockedByWaId(t, waId),
    },
    meta: metaFactory,
  });

  /**
   * Exécuteur de scénarios et ce qui l'accompagne (`workflow/wiring.ts`) : le worker le fait avancer (réponse d'un
   * contact, campagne, réveil), l'API le lance depuis l'Inbox et doit savoir tout de suite si c'est parti.
   */
  const workflowRuntime = buildWorkflowRuntime({
    pool, queue, dryRun, repo, contactStore, inboxStore, settingsStore, workflowStore, metaCredentials, metaFactory,
    rcsProvider: config.RCS_PROVIDER,
    emailTemplates, emailResolver, numeroDeLEspace, runStore, fil,
  });

  /**
   * La clé de modèle propre à chaque espace, lue par les tours d'agent du worker (l'essentiel de la dépense) comme
   * par l'API. Le repli sur la clé maison est silencieux par nature (les agents répondent, mais la dépense de cet
   * espace cesse d'être attribuée) : sans le signalement, personne ne l'apprend.
   */
  const clesGateway = new PgCleGatewayStore(
    pool,
    (clair) => encryptSecret(clair, config.ENCRYPTION_KEY),
    (chiffre) => decryptSecret(chiffre, config.ENCRYPTION_KEY),
    (tenantId, err) => { journaliser('error', 'cle_gateway_indechiffrable', { err, tenantId }); },
  );

  return {
    clesGateway, dryRun, transport, repo, recipientStore, integrationBatch, espacesBatch, emetteur, contactStore, fieldStore,
    inboxStore, settingsStore, flowStore, idempotencyStore, auditStore, erreursLivraison, echecsMessages,
    poolAttentesStore, nodeEventStore, trackedLinkStore, webhookStore, verrousCourts, compteurDebit, phoneStatusStore, opsStore, heartbeatStore,
    workflowStore, automationStore, agentStore, knowledgeStore, rechercheSemantique, toolCatalog, journalAppels,
    credits, agentSources, agentRequetes, lecturesAnalyse, essaisStore, depotAide, emailAccounts, emailTemplates, emailResolver,
    wabaDeLEspace, numeroDelieStore, gardeNumeroDelie, esCredentialsStore, metaCredentials, metaFactory, listeDeLAgent,
    connexionsPub, publicites, clientPubs, clientCreationPubs, workflowRuntime, fil,
  };
}

export type Socle = ReturnType<typeof construireSocle>;
