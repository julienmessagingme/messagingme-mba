import 'dotenv/config';
import { buildServer } from './server';
import { config } from './config';
import { adressesPubliques } from './lib/adresses-publiques';
import { surveillerOps } from './ops/tentatives';
import { sendTelegram } from './ops/telegram';
import { PgBossQueue } from './queue/pgboss';
import { pool, mesureAttentePool } from './db/pool';
import { PgContactStore } from './crm/contact-store.pg';
import { PgContactHistoryStore } from './crm/contact-history.pg';
import { PgUserFieldStore } from './crm/field-store.pg';
import { PgTagStore } from './crm/tag-store.pg';
import { ensureField, ensureFieldByKey, WHATSAPP_OPTIN_FIELD_KEY, WHATSAPP_OPTIN_FIELD_LABEL } from './crm/fields';
import { PgCampaignRepo, PgRecipientStore } from './campaign/store.pg';
import { PgCampaignDraftStore } from './campaign/draft-store.pg';
import { PgInboxStore, type ConversationMessage } from './inbox/store.pg';
import { PgStatsStore } from './stats/store.pg';
import { PgConversationStatsStore } from './stats/conversation-stats.pg';
import { estimateCostSeries, estimateCoutParCampagne, estimerCoutContact, entonnoirEngagement, type CategoryRates } from './stats/cost';
import { assemblerDetailCampagne } from './stats/cout-campagne';
import { coutMessages } from './stats/cout-messages';
import { grilleDepuisLigne, tarifsFactures, pricingFacture } from './stats/prix';
import { basculesRcs, FENETRE_BASCULE_MS } from './stats/rcs-conversationnel';
import { PLAFOND_TOURS_IA } from './stats/cout-ia';
import { rangeToUnix, addDays, todayParis } from './stats/range';
import type { CompteurClic } from './links/mesures';

import { cacheCourt } from './lib/cache-court';
import { journaliser } from './lib/journal';
import { ResendClient } from './support/resend';
import { PgTenantSettingsStore } from './settings/store.pg';
import { PgUserAuthStore } from './auth/store';
import { PgUserStore } from './user/store.pg';
import { PgAuthTokenStore } from './auth/token-store.pg';
import { verifyGoogleIdToken } from './auth/google';
import { PgFlowStore } from './flow/store.pg';
import { PgApiKeyStore } from './auth/api-key-store.pg';
import { upsertContactsFromApi } from './api/contacts-upsert';
import { creerServiceContactsV1 } from './api/contacts-v1';
import { PgReachabilityStore } from './rcs/reachability.pg';
import { joignabiliteRcsToutesFormes } from './rcs/reachability';
import { PgApiIdempotencyStore } from './api/idempotency-store.pg';
import { PgAuditStore } from './audit/store.pg';
import { PgErreursLivraisonStore } from './ops/erreurs-livraison.pg';
import { PLAFOND_CONTACTS_ERREUR } from './http/stats';
import { PgPoolAttentesStore, viderVersLaBase } from './ops/pool-attentes.pg';
import { PgWorkflowNodeEventStore } from './workflow/node-events.pg';
import { PgWorkflowReportStore } from './workflow/reports.pg';
import { PgTrackedLinkStore } from './links/tracked-links.pg';
import { lienDe, lienTraceAvecJeton } from './links/rewrite';
import { noeudsTemplate, compteursDeClics, liensRcsDesNoeuds, compteursDeClicsRcs } from './links/mesures';
import { aDesLiensTracables } from './links/rcs-liens';
import { fabriquerJeton } from './links/jeton-contact';
import { newTrackingCode } from './ids/code';
import type { AuditSink } from './audit/journal';
import { resolveScenario, resolveNode } from './ids/resolve';
import { enqueueCampaignRun } from './campaign/enqueue';
import { creerAnnonceOptOut, FILE_POUSSEE_OPTOUT } from './crm/poussee-optout';
import { plafondLePlusBas, resolveRatePerMinute } from './campaign/pacing';
import { fetchHubspotLists, importHubspotList, disconnectHubspot, fetchHubspotDealStages } from './crm/hubspot-service';
import { PgTemplateHintStore } from './crm/template-hints.pg';
import { MetaMediaClient } from './meta/media';
import { PgPhoneStatusStore } from './account/store.pg';
import { pullFromInfo, pullFromError } from './account/pull';
import { PgOpsStore } from './ops/store.pg';
import { PgWorkerHeartbeatStore } from './ops/heartbeat-store.pg';
import { makeDbReadinessCheck } from './db/readiness';
import { PgAutomationStore } from './automation/store.pg';
import { PgChannelsMeConnectionStore } from './channels-me/connection-store.pg';
import { PgChannelsMeLinkStore } from './channels-me/link-store.pg';
import { normalizeText } from './automation/match';
import { PgChannelsMePostStore } from './channels-me/post-store.pg';
import { ChannelsMeClient } from './channels-me/client';
import { enfilerEvenementAutomation, type AutomationEventJob } from './automation/event-job';
import { PgWebhookStore } from './webhook-entrant/store.pg';
import { RateLimiter } from './auth/rate-limit';
import { PgWorkflowStore } from './workflow/store.pg';
import { resolveTenantCode } from './ids/tenant-code';
import { MetaEmbeddedSignupClient } from './meta/embedded-signup';
import { PgEmbeddedSignupStore } from './account/es-store.pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { MetaCredentialsResolver } from './meta/credentials';
import { fetchUrlBorne } from './lib/page-distante';
import { signSession } from './auth/token';
import { ecrireHandoffEnabled } from './mba/handoff';
import { MetaClientFactory } from './meta/factory';
import { arbitreDeDebit } from './meta/arbitre-debit';
import { arbitreDeDebitPartage, depsPorteDebitPg } from './meta/arbitre-debit-partage';
import { buildTemplateComponents, carouselSendBlocker } from './meta/template-components';
import { buildWorkflowRuntime } from './workflow/wiring';
import type { StartOutcome } from './workflow/executor';
import { PgEmailAccountStore } from './email/account-store.pg';
import { PgEmailTemplateStore } from './email/template-store.pg';
import { PgRcsMessageStore } from './rcs/message-store.pg';
import type { RcsOutbound } from './rcs/types';
import { PgRcsMediaStore } from './rcs/media-store.pg';
import { urlImageRcs } from './rcs/image';
import { newMediaCode } from './ids/code';
import { verifierCleRcs } from './rcs/channel-info';
import { fetchGet } from './lib/http-get';
import { lireCatalogueGateway } from './agent/llm/modeles-gateway';
import { modelesProposables, type ModeleGateway } from './agent/modeles';
import { apercuMo } from './rcs/callback';
import { estDemandeArret } from './crm/consentement';
import { apercuRcsSortant } from './rcs/schema';
import { aDesVariables, appliquerVariables } from './rcs/variables';
import { contactVars } from './crm/render';
import { resolveHintParams } from './crm/template';
import { EmailAccountResolver } from './email/resolver';
import { buildTransport as buildEmailTransport } from './email/smtp';
import { FetchTransport, HTTP_TIMEOUT_MODELE_MS } from './meta/http';
import { PgAgentStore } from './agent/agent-store.pg';
import { PgKnowledgeStore } from './agent/knowledge.pg';
import { creerRechercheSemantique } from './agent/recherche';
import { PgDepotAide } from './aide/fiches.pg';
import { creerRepondeur } from './aide/repondre';
import { creerRecap } from './aide/recap.pg';
import { creerRecapRedige, creerRedacteurRecap, gabarit } from './aide/recap-rendu';
import { creerTraducteur, type LangueConsole } from './traduction/traduire';
import { PgTraductionStore } from './traduction/traduire.pg';
import { traduireFil } from './traduction/fil';
import { PgToolCatalog, PgJournalAppels } from './agent/catalog.pg';
import { creerAppelConnecteur } from './agent/resolvers/http';
import { lireContexteAgent } from './agent/contexte';
import { equipePourPrompt, MODE_TRANSFERT_DEFAUT } from './agent/disponibilite-equipe';
import { PgCreditStore } from './agent/credits.pg';
import { PgCleGatewayStore } from './agent/cles-gateway.pg';
import { transcrireMessage } from './inbox/transcrire';
import { lireMediaRecu } from './inbox/media-entrant';
import { assurerCleGateway, remonterPlafondApresRecharge, revoquerCleGateway, type DepsProvisionCle } from './agent/provisionner-cle';
import { encryptSecret, decryptSecret } from './crypto/secretbox';
import { MetaPubsClient, sansPrefixeAct, retirerAncienAcces, type EtatComptePub } from './meta/pubs';
import { DejaConnectePub, JetonNonEnregistre, PasDeConnexionPub, ConnexionPubIncomplete } from './http/pubs';
import { MetaPubsCreationClient } from './meta/pubs-creation';
import { PgPublicitesStore } from './pubs/publicites.pg';
import { PgBrouillonsPubStore, type ChampsBrouillon } from './pubs/brouillons.pg';
import { creerLaPublicite, publierLaPublicite, type DemandeCreation } from './pubs/creation';
import { entonnoir, ISSUES_NON_PRISES_EN_CHARGE } from './pubs/entonnoir';
import { estJetonRefuse } from './meta/graph';
import { PgPubConnexionStore } from './pubs/connexion.pg';
import { PgAgentSessionStore } from './agent/session-store.pg';
import { PgSourceStore } from './agent/sources.pg';
import { PgMcpStore } from './agent/mcp/store.pg';
import { PgRequeteStore } from './agent/requetes.pg';
import { PgEntretienStore } from './agent/setup/entretien-store.pg';
import { PgEntretienMbaStore } from './mba/assistant/entretien-store';
import { lireInventaireMba } from './mba/assistant/inventaire';
import { PgDepenseStore } from './assistant/budget';
import { PgHistoriqueStore } from './reglages/historique.pg';
import { magasinPiecesJointes } from './mba/assistant/pieces-jointes';
import type { LigneHistorique } from './reglages/historique';
import { PgTestRunStore } from './agent/test-runs.pg';
import { enTetesAuthSource } from './agent/http-cible';
import { creerEprouverSource } from './agent/eprouver-source';
import { GatewayChatClient } from './agent/llm/chat-client';
import { creerWabaDeLEspace } from './meta/numero-espace';
import { creerRendreLeFil, creerPrendreLeFil } from './inbox/controle-du-fil';
import { consommateurAgent, consommateurMba } from './agent/consommateur';
import { type OutilAPublier } from './mba/publication';
import { outilsAPublier } from './mba/outils-a-publier';
import { blocsProposables } from './mba/outils-maison';
import { creerGestesEnvoi } from './mba/gestes-envoi';
import { AntiRejeu, DUREE_ANTI_REJEU_MS } from './mba/anti-rejeu';
import { creerSignalerEchecTardif } from './mba/signaler-echec-tardif';
import { creerAttendreFinDuTour } from './mba/fin-de-tour';
import { cleAJour, depsCleRelaisDepuis } from './mba/cle-relais';
import { creerAppliquerGeste } from './mba/appliquer-publication';
import { baseDuRelais } from './mba/relais';
import { resolveursSimulation } from './agent/resolvers/simulation';
import { JOURNAL_MUET } from './agent/journal-muet';
import { installGracefulShutdown } from './shutdown';
import type { CountryCode } from 'libphonenumber-js';
import { handlerMaison } from './agent/outils-maison';
import type { PricingSummary } from './meta/pricing';

async function main(): Promise<void> {
  /**
   * Les deux bases d'adresses publiques, résolues UNE fois. `PUBLIC_API_URL` vide (le cas d'aujourd'hui) rend
   * exactement ce que `APP_URL` rendait avant : ce câblage est donc sans effet tant qu'on ne pose pas la
   * variable. Détail de la règle et de son cas particulier dans `src/lib/adresses-publiques.ts`.
   */
  const adressesApi = adressesPubliques(config.APP_URL, config.PUBLIC_API_URL);

  // `supervise: false` : l'API ne fait qu'EMPILER des jobs, elle n'en dépile aucun. Superviser (récupération des
  // jobs expirés, monitoring, flow) est le travail du worker. Laisser l'API superviser doublait la maintenance
  // sur la base pour zéro bénéfice : mesuré le 2026-08-17, c'était la moitié des ~55 000 requêtes/jour de
  // maintenance du projet, sur un quota d'egress Supabase déjà dépassé.
  const queue = new PgBossQueue(config.DATABASE_URL, config.PGBOSS_SCHEMA, {
    max: config.PGBOSS_MAX,
    connectionTimeoutMillis: config.DB_CONN_TIMEOUT_MS,
    supervise: false,
  });
  // Un event `error` de pg-boss non capté est une exception non gérée qui tue l'API. On le journalise
  // et on laisse tourner : une saturation ponctuelle du pooler ne doit pas coûter un redémarrage.
  // eslint-disable-next-line no-console
  queue.onError((err) => console.error('[pg-boss:api]', err instanceof Error ? err.message : err));
  await queue.start();

  const repo = new PgCampaignRepo(pool);
  // Statuts de livraison des destinataires. Le worker en a le sien pour les accusés Meta ; l'API en a besoin
  // parce que les rappels du fournisseur RCS arrivent SUR L'API (le worker n'expose aucune route publique).
  const recipientStore = new PgRecipientStore(pool);
  const campaignDraftStore = new PgCampaignDraftStore(pool);
  /**
   * 🔴 L'ANNONCE D'UN OPT-OUT, POSÉE SUR LE DÉPÔT LUI-MÊME. Elle couvre par CONSTRUCTION toutes les méthodes
   * du dépôt capables d'écrire `opted_out` (la liste qui fait foi est dérivée par `tests/optout-poussee.test.ts`)
   * au lieu d'être recopiée sur chaque appelant, où elle aurait été oubliée au prochain bouton. Elle n'appelle
   * RIEN : elle enfile.
   * L'appel au connecteur, lui, vit dans le worker, avec ses réessais.
   */
  const contactStore = new PgContactStore(
    pool,
    creerAnnonceOptOut({
      enfiler: (job, opts) => queue.enqueue(FILE_POUSSEE_OPTOUT, job, opts),
      // eslint-disable-next-line no-console
      log: (m) => console.warn(m),
    }),
  );
  const contactHistoryStore = new PgContactHistoryStore(pool);
  const templateHintStore = new PgTemplateHintStore(pool);
  const fieldStore = new PgUserFieldStore(pool);
  const tagStore = new PgTagStore(pool);
  const inboxStore = new PgInboxStore(pool);
  const statsStore = new PgStatsStore(pool);
  // Lecture des agrégats d'analyse de conversation (Pièce 1). `enabled` = état de la feature côté serveur
  // (empty-state différencié). La lecture ne coûte rien ; l'écriture (analyse LLM) est gatée ailleurs.
  // La rétention vient du MÊME endroit que la purge du worker (`CONVERSATION_RETENTION_DAYS`) : l'écran
  // annonce ainsi le nombre réellement appliqué, pas une valeur recopiée qui dériverait le jour où on la change.
  const conversationStatsStore = new PgConversationStatsStore(pool, config.CONVERSATION_ANALYSIS_ENABLED === 'true', config.CONVERSATION_RETENTION_DAYS);
  const settingsStore = new PgTenantSettingsStore(pool);
  const userStore = new PgUserStore(pool);
  const authTokenStore = new PgAuthTokenStore(pool);
  const flowStore = new PgFlowStore(pool);
  const apiKeyStore = new PgApiKeyStore(pool);
  const idempotencyStore = new PgApiIdempotencyStore(pool);
  const auditStore = new PgAuditStore(pool);
  const erreursLivraison = new PgErreursLivraisonStore(pool);
  const poolAttentesStore = new PgPoolAttentesStore(pool);
  const nodeEventStore = new PgWorkflowNodeEventStore(pool);
  const trackedLinkStore = new PgTrackedLinkStore(pool);
  const webhookStore = new PgWebhookStore(pool);
  const reportStore = new PgWorkflowReportStore(pool);
  // L'email de l'acteur est résolu ICI, une fois, et écrit en clair dans le journal : une jointure sur `users`
  // rendrait l'historique illisible au premier départ d'un collaborateur.
  const auditSink: AuditSink = async (tenant, actor, action, target, detail) => {
    const email = actor.userId ? (await userStore.getSessionUser(actor.userId))?.email ?? null : null;
    await auditStore.record(tenant, { userId: actor.userId, email }, action, target, detail);
  };
  const phoneStatusStore = new PgPhoneStatusStore(pool);
  const opsStore = new PgOpsStore(pool, config.PGBOSS_SCHEMA);
  const heartbeatStore = new PgWorkerHeartbeatStore(pool);
  const workflowStore = new PgWorkflowStore(pool);
  const agentStore = new PgAgentStore(pool);
  const knowledgeStore = new PgKnowledgeStore(pool);
  // Une seule fabrique pour les trois usages (agent, bac a sable, balayage) : trois constructions seraient
  // trois occasions de cabler un modele ou un seuil different.
  const rechercheSemantique = creerRechercheSemantique();
  const toolCatalog = new PgToolCatalog(pool);
  const credits = new PgCreditStore(pool);
  // Lecture SEULE, pour le suivi de consommation d'un agent. Le store d'ECRITURE des sessions vit dans le
  // cablage du worker (`src/workflow/wiring.ts`) : c'est lui qui les fait avancer, l'API ne fait qu'agreger.
  const agentSessions = new PgAgentSessionStore(pool);
  const agentSources = new PgSourceStore(pool);
  const mcpStore = new PgMcpStore(pool);
  const agentRequetes = new PgRequeteStore(pool);

  /**
   * LE RELAIS DU META BUSINESS AGENT (migration 0161) : trois aides partagées par la publication.
   *
   * `adresseDuRelais` : `null` quand `PUBLIC_API_URL` est vide, et la publication refuse alors en le disant
   * plutôt que de poser chez Meta un connecteur qui n'appelle rien.
   */
  const adresseDuRelais = (): string | null => baseDuRelais(config.PUBLIC_API_URL);
  /**
   * Les outils exposés à l'agent de Meta, tels qu'ils partent chez Meta : appels de connecteur et gestes maison
   * (spec 2026-09-21-outils-maison-mba). Le tri de ce qui part vit dans `src/mba/outils-a-publier.ts`, testé.
   */
  const outilsPourMeta = async (tenant: string, pn: string): Promise<OutilAPublier[]> =>
    outilsAPublier(
      await toolCatalog.listActifsConsommateur(tenant, consommateurMba(pn)),
      (id) => agentRequetes.parId(tenant, id),
    );
  /** La clé « Agent de Meta », par acteur : la fabrique et son audit vivent dans `src/mba/cle-relais.ts`. */
  const depsCleRelaisPour = depsCleRelaisDepuis({ cles: apiKeyStore, reglages: settingsStore, audit: auditSink });
  /**
   * LA CLE DE MODELE PROPRE A CHAQUE ESPACE (2026-09-09).
   *
   * 🔴 LE CHIFFREMENT EST INJECTE, il n'est pas relu dans le store : meme contrat que
   * `PgChannelsMeConnectionStore`. Un store qui irait chercher la cle de chiffrement tout seul serait un
   * second endroit ou la lire, donc un second endroit ou l'oublier.
   */
  const clesGateway = new PgCleGatewayStore(
    pool,
    (clair) => encryptSecret(clair, config.ENCRYPTION_KEY),
    (chiffre) => decryptSecret(chiffre, config.ENCRYPTION_KEY),
    // ⚠️ Le repli sur la cle maison est SILENCIEUX par nature : les agents repondent, tout a l'air normal, et
    // la depense de cet espace cesse d'etre attribuee. Sans cette ligne, personne ne l'apprend jamais.
    (tenantId, err) => { journaliser('error', 'cle_gateway_indechiffrable', { err, tenantId }); },
  );
  /**
   * ⚠️ `null` quand le jeton Vercel n'est pas configure : le provisionnement est alors ETEINT et la creation
   * d'agent se comporte comme avant. C'est ce qui permet de deployer ce lot avant d'avoir pose le jeton.
   */
  const provisionCle: DepsProvisionCle | null = config.VERCEL_API_TOKEN !== '' && config.VERCEL_TEAM_ID !== ''
    ? {
      cles: clesGateway,
      solde: (tenant) => credits.solde(tenant),
      nomEspace: async (tenant) => {
        const r = await pool.query<{ name: string }>('select name from tenants where id = $1', [tenant]);
        return r.rows[0]?.name ?? null;
      },
      transport: new FetchTransport(),
      jetonCompte: config.VERCEL_API_TOKEN,
      teamId: config.VERCEL_TEAM_ID,
      cleGatewayMaison: config.AI_GATEWAY_API_KEY,
      tauxEurParDollar: config.EUR_PER_USD,
    }
    : null;

  // Vide -> la conversation de construction repond 503, aucun crash au boot.
  // ⚠️ Le 3e argument est le resolveur de cle PAR ESPACE : sans lui, tous les appels partiraient sur la cle
  // maison et aucune depense ne serait attribuee, ce qui est exactement ce que ce lot vient corriger.
  // ⚠️ UNE SEULE EXCEPTION, juste en dessous et DELIBEREE : `gatewayAide` est construit sans resolveur,
  // parce que l aide de la console est a NOTRE charge. Ne pas << corriger >> cet ecart.
  const gateway = config.AI_GATEWAY_API_KEY
    ? new GatewayChatClient(config.AI_GATEWAY_API_KEY, undefined, async (tenant) => (await clesGateway.lire(tenant))?.cle ?? null)
    : null;
  /**
   * LE CLIENT DU BOT D AIDE, construit SANS resolveur de cle par espace.
   *
   * 🔴 C EST CE QUI FAIT QUE NOUS PAYONS, et ce n est pas un oubli : `cleDe` rend la cle maison des que le
   * resolveur est absent (`src/agent/llm/chat-client.ts`). Lui passer le resolveur ferait facturer l aide
   * au credit prepaye du client, c est-a-dire l inverse exact de ce que Julien a tranche le 2026-09-11.
   * Facturer quelqu un pour apprendre a se servir du produit se retourne contre nous : celui qui hesite a
   * poser une question est celui qui abandonne.
   *
   * ⚠️ La depense est bornee par le plafond d EQUIPE pose chez Vercel, et par le plafond de debit PAR ESPACE
   * de la route (`src/http/aide.ts`), qui empeche un seul client de la consommer pour tout le monde.
   */
  const gatewayAide = config.AI_GATEWAY_API_KEY ? new GatewayChatClient(config.AI_GATEWAY_API_KEY) : null;

  /**
   * L'HISTORIQUE DES RÉGLAGES (migration 0146). Partagé par les DEUX assistants et par les formulaires :
   * un historique qui ignorerait les gestes d'écran mentirait par omission, et on y chercherait une cause
   * qui ne s'y trouve pas.
   */
  const historiqueStore = new PgHistoriqueStore(pool);
  /**
   * LES PIECES JOINTES DEPOSEES DANS LA CONVERSATION DU MBA.
   *
   * 🔴 UNE SEULE INSTANCE, PARTAGEE ENTRE LE DEPOT ET L APPLICATION. En construire deux (une par lambda de
   * cablage) rendrait tout jeton introuvable au moment de l appliquer, sans aucune erreur visible : le
   * depot reussirait, le diff porterait le jeton, et l application dirait « document plus disponible ».
   */
  const piecesJointesMba = magasinPiecesJointes();
  /** Il n y a aucun espace pour le compte de qui l aide est appelee : la depense est la NOTRE. */
  const AUCUN_ESPACE_PAYEUR = '';
  /**
   * LE TRADUCTEUR DES CONVERSATIONS (2026-09-12).
   *
   * 🔴 IL PREND `gateway`, JAMAIS `gatewayAide`, et c est la seule chose a ne pas se tromper ici : la
   * traduction sert les conversations du CLIENT, donc elle tombe sur son credit prepaye (migration 0124),
   * quand l aide de la console est a NOTRE charge. Les deux clients se ressemblent a une lettre pres et
   * n ont pas le meme payeur.
   *
   * ⚠️ `cleDisponible` est ce qui fait qu un espace SANS credit ne traduit pas du tout, au lieu de retomber
   * en silence sur la cle maison comme le fait `cleDe`. Sans elle, le repli de `GatewayChatClient` nous
   * ferait payer les traductions de tous les espaces sans cle.
   *
   * Vide (`TRADUCTION_MODELE` non configure) -> la traduction est eteinte : le fil sort en VO avec son
   * drapeau, le bouton sortant refuse en 422, et rien d autre ne change.
   */
  const traductionStore = new PgTraductionStore(pool);
  const traducteur = gateway && config.TRADUCTION_MODELE
    ? creerTraducteur({
      completer: (input) => gateway.completer(input),
      modele: config.TRADUCTION_MODELE,
      cleDisponible: async (tenantId) => (await clesGateway.lire(tenantId)) !== null,
    })
    : null;
  const automationStore = new PgAutomationStore(pool);
  // Chaine WhatsApp (Channels Me). La cle de chiffrement est INJECTEE au store (contrat du sous-systeme),
  // elle n'est pas relue depuis la config a l'interieur : les deux secrets sont chiffres la, jamais plus haut.
  const channelsMeConnections = new PgChannelsMeConnectionStore(pool, config.ENCRYPTION_KEY);
  const channelsMeLinks = new PgChannelsMeLinkStore(pool);
  const channelsMePosts = new PgChannelsMePostStore(pool);
  // Hote FIXE et de confiance : aucune verification d'adresse privee, meme traitement que les clients Meta
  // et Zadarma.
  const channelsMeClient = new ChannelsMeClient();
  // Node « Envoi de mail » : boîtes SMTP + modèles (scopés tenant), résolveur de transport à cache par
  // tenant+compte (invalidé par les routes email à chaque écriture d'un compte).
  const emailAccounts = new PgEmailAccountStore(pool);
  const emailTemplates = new PgEmailTemplateStore(pool);
  const rcsMessageStore = new PgRcsMessageStore(pool);
  const rcsMediaStore = new PgRcsMediaStore(pool);
  // Le cache de joignabilité RCS, en LECTURE (fiche de l'API publique). L'envoi a le sien dans `rcsStack`.
  const rcsJoignabilite = new PgReachabilityStore(pool);
  const emailResolver = new EmailAccountResolver({
    getDecrypted: (t, id) => emailAccounts.getDecrypted(t, id),
    buildTransport: buildEmailTransport,
  });
  const transport = new FetchTransport();
  // Clients Meta phone/pricing/templates/flows : résolus PAR TENANT via metaFactory (B1, plus de singleton global).
  // media reste global : endpoint /{appId}/uploads app-scoped (décision assumée, cf. .loop/bloc4.md).
  const mediaClient = new MetaMediaClient(config.META_ACCESS_TOKEN, config.META_APP_ID, config.META_GRAPH_VERSION);

  // Résolution du token Meta PAR TENANT (B1). SOMMEIL : repli sur le token global tant qu'aucun WABA n'a de
  // credentials propres -> le numéro Zadarma reste sur config.META_ACCESS_TOKEN, comportement identique.
  // Le WABA de l'espace, une lecture par process : le cache de jeton etant indexe par WABA, cette requete
  // etait payee AVANT lui a chaque construction de client Meta. Reponses positives seulement.
  const wabaDeLEspace = creerWabaDeLEspace((t) => repo.getTenantWabaId(t));
  // ⚠️ HISSÉS HORS DU CÂBLAGE DE L'ÉCRAN parce qu'ils ont DEUX consommateurs depuis le 2026-09-23 : les
  // routes de l'écran Publicités, et la route `/ops` qui dépose un jeton créé à la main (le portefeuille
  // qui possède l'app ne peut pas passer par la fenêtre Meta). Les construire deux fois donnerait deux
  // chemins de chiffrement à tenir alignés.
  const clientPubs = new MetaPubsClient(config.META_APP_ID, config.META_APP_SECRET, config.META_GRAPH_VERSION);
  const connexionsPub = new PgPubConnexionStore(pool);
  // Lot 3 : ce qui CRÉE une publicité sur le compte du client, donc ce qui dépense son argent. Client
  // SÉPARÉ de celui de la connexion, qui ne fait que lire : une route de lecture ne doit pas avoir de
  // quoi créer une campagne sous la main.
  const clientCreationPubs = new MetaPubsCreationClient(config.META_APP_ID, config.META_APP_SECRET, config.META_GRAPH_VERSION);
  const publicites = new PgPublicitesStore(pool);
  const brouillonsPub = new PgBrouillonsPubStore(pool);
  const esCredentialsStore = new PgEmbeddedSignupStore(pool);
  const metaCredentials = new MetaCredentialsResolver({
    getWabaIdForTenant: wabaDeLEspace,
    getCredentialsByWaba: (w) => esCredentialsStore.getCredentialsByWaba(w),
    markTokenInvalid: (w) => esCredentialsStore.markTokenInvalid(w),
    decrypt: (enc) => decryptSecret(enc, config.ENCRYPTION_KEY),
    fallbackToken: config.META_ACCESS_TOKEN,
  });
  const metaFactory = new MetaClientFactory({
    resolver: metaCredentials,
    transport,
    version: config.META_GRAPH_VERSION,
    marketingViaLite: config.META_MM_LITE === 'true',
    // Frein PAR NUMÉRO, partagé par tout ce qui envoie depuis lui (lot 4). Instancié ICI, donc un par
    // process : le budget n'est pas partagé entre l'API et le worker, et `arbitre-debit.ts` dit pourquoi
    // c'est acceptable aujourd'hui et pourquoi ça ne le sera plus au second worker.
    // Le budget du numéro est PARTAGÉ entre l'API et le worker (migration 0102). L'arbitre local reste
    // dessous : il est le repli si la base de débit ne répond pas, donc le pire cas de ce montage est
    // exactement le comportement d'avant, jamais une absence de frein.
    arbitreDebit: arbitreDeDebitPartage(
      arbitreDeDebit(config.PHONE_RATE_PER_MINUTE_MAX),
      config.PHONE_RATE_PER_MINUTE_MAX,
      depsPorteDebitPg(pool),
    ),
  });

  /**
   * Rendre le fil à l'agent de Meta. MÊME module que le balayage du worker (`src/inbox/controle-du-fil.ts`) :
   * le geste vivait dans une fermeture du worker, donc l'API ne pouvait pas l'appeler, et le bouton « rendre
   * la main » de l'Inbox n'écrivait que notre état local.
   */
  const controleDuFil = {
    numeroDuTenant: (t: string) => repo.getTenantPhoneNumberId(t),
    clientMba: (t: string) => metaFactory.mbaClientForTenant(t),
  };
  const rendreLeFilAuMba = creerRendreLeFil(controleDuFil);
  /**
   * PRENDRE le fil à l'agent de Meta, sans écrire au client. C'est ce qui manquait au bouton « Reprendre la
   * main » : il n'écrivait que notre état local, donc Meta continuait de router les entrants vers son agent,
   * qui répondait au message suivant. Signalé par Julien le 2026-09-11.
   */
  const prendreLeFilAuMba = creerPrendreLeFil(controleDuFil);

  /**
   * DRY_RUN : aucun appel Meta. ⚠️ L'API ne lisait PAS ce drapeau jusqu'ici, alors que le worker le respecte
   * dans chacune de ses dep d'envoi. Le câbler est indispensable avant de donner à l'API le droit d'exécuter
   * un scénario : sans ça, un déploiement déclaré DRY_RUN enverrait pour de vrai depuis l'Inbox.
   */
  const dryRun = config.DRY_RUN === 'true';

  /**
   * Exécuteur de scénarios, câblage PARTAGÉ avec le worker (`workflow/wiring.ts`). Il apporte aussi la
   * préparation des visuels de carousel et la lecture mémoïsée du corps d'un template : l'API en avait sa
   * propre version, plus courte et sans cache, ce qui en faisait un troisième doublon de cette famille.
   */
  const workflowRuntime = buildWorkflowRuntime({
    pool, queue, dryRun, repo, contactStore, inboxStore, settingsStore, workflowStore, metaCredentials, metaFactory,
    rcsProvider: config.RCS_PROVIDER,
    // Node « Envoi de mail » (Task 8) : mêmes instances que celles passées aux routes email (registerRoutes,
    // ci-dessous), pour que l'invalidation du résolveur à une écriture de compte vaille aussi pour l'exécuteur.
    emailTemplates, emailResolver,
  });

  /**
   * LANCER UN SCÉNARIO POUR UN CONTACT, exactement comme le bouton de l'Inbox. Deux appelants : l'Inbox et l'outil
   * « Lancer un scénario » de l'agent de Meta (spec 2026-09-21-outils-maison-mba, § 3.4). Un seul chemin, pas un
   * cinquième : la fermeture du parcours en cours, la reprise du fil et la garde de fenêtre vivent dans `runFrom`.
   *
   * La fenêtre décide de la porte d'entrée :
   *  - ouverte -> `startInWindow` : le scénario peut ouvrir par un message rapide ou un formulaire ;
   *  - fermée  -> `start` : la garde de fenêtre s'applique et REND la raison si le scénario ouvre par un
   *    message de session, ce que Meta refuserait (131047).
   *
   * `ignoreHumanControl` : c'est un geste délibéré (l'opérateur, ou l'agent de Meta à la demande du client), et
   * celui qui déclenche détient presque toujours le fil. Le refuser à ce titre serait absurde. Même règle qu'au
   * lancement d'une campagne. `emitEvents` : un lancement unitaire (un contact, ici et maintenant), donc ses tags
   * publient, comme après une réponse du contact.
   *
   * ⚠️ LA FERMETURE DU PARCOURS EN COURS N'EST PLUS ICI, elle est dans `runFrom` (l'exécuteur), et c'est le point
   * du lot du 2026-09-07 : elle vivait chez l'appelant de l'Inbox, donc sur un chemin sur quatre, et les trois
   * autres divergeaient. Le comportement pour l'opérateur est inchangé : son scénario remplace celui en cours.
   */
  const lancerScenarioPourContact = async (
    tenant: string, workflowId: string, waId: string, windowOpen: boolean,
  ): Promise<StartOutcome | null> => {
    const wf = await workflowStore.getById(workflowId, tenant);
    if (!wf) return null;
    const contactId = await contactStore.findIdByWaId(tenant, waId);
    const contact = { waId, contactId };
    const opts = { emitEvents: true, ignoreHumanControl: true };
    return windowOpen
      ? workflowRuntime.executor.startInWindow(tenant, workflowId, wf.graph, contact, opts)
      : workflowRuntime.executor.start(tenant, workflowId, wf.graph, contact, undefined, opts);
  };

  // Envoi d'email auth (liens reset/invitation) : seulement si Resend est configuré, sinon undefined.
  const sendAuthEmail = config.RESEND_API_KEY
    ? async ({ to, subject, text, html }: { to: string; subject: string; text: string; html?: string }) => {
        await new ResendClient(config.RESEND_API_KEY).send({ from: `Messaging Me <${config.SUPPORT_FROM}>`, to, subject, text, ...(html ? { html } : {}) });
      }
    : undefined;
  /**
   * LE PRIX FACTURE D UN TEMPLATE, ET C EST LE SEUL ENDROIT OU LA MARGE DE L ESPACE S APPLIQUE.
   *
   * 🔴 UN SEUL POINT DE PASSAGE, ET C EST TOUT L INTERET. La marge a d abord ete posee dans les DEUX
   * fonctions qui calculaient un total, et deux autres consommateurs des memes tarifs l ont donc ignoree :
   * le graphe de cout du Quantitatif et le bilan d un contact affichaient le tarif Meta BRUT. Des qu un
   * client posait une marge de 150, la Synthese annoncait 1,50 € la ou le graphe du meme produit annoncait
   * 1,00 € pour exactement les memes envois. Releve en revue finale le 2026-09-18 : le correctif precedent
   * avait DEPLACE la frontiere de la divergence, pas supprimee. En margeant ici, les CINQ consommateurs
   * sont justes, et le sixieme qu on ajoutera demain le sera aussi sans y penser.
   *
   * ⚠️ ELLE S APPELAIT `tarifsMeta`, ET CE NOM A CAUSE LA PANNE QU ON VIENT DE REPARER. Ce qui sort n est
   * plus un tarif de Meta, c est un PRIX DE VENTE. L inventaire des consommateurs avait ete fait sur
   * « qui appelle `tarifsMeta` » plutot que sur « qui affiche un prix a un client », et un sixieme chemin
   * y a echappe deux revues de suite. Un nom qui decrit ce qu on lit plutot que ce qu on rend fait ca.
   *
   * ⚠️ UN TARIF ABSENT (`null`) LE RESTE : marger
   * une absence en ferait un prix, et `chiffrer` ne pourrait plus la compter comme « sans tarif ».
   *
   * ⚠️ La grille est lue PAR ESPACE a chaque appel. Elle vit dans `tenant_settings`, une ligne par espace,
   * lue par cle primaire : ce n est pas la lecture qui coute sur ce chemin, c est l aller-retour chez Meta
   * juste au-dessus.
   */
  /**
   * Le tarif de Meta, par espace ET par fenetre. Soixante secondes : voir `prixFactures` juste en dessous.
   *
   * ⚠️ DECLARE ICI, DANS LE CABLAGE, et pas dans un module : il n'y a qu'un seul processus d'API, et un
   * cache par process est exactement ce que `cacheCourt` promet. Le sortir dans un module partage le ferait
   * partager par le worker, qui n'affiche aucun tarif.
   */
  const cacheTarifsMeta = cacheCourt<PricingSummary | null>(60_000);

  /**
   * LE POINT DE PASSAGE UNIQUE vers le tarif de Meta. Les deux appelants passent par ici.
   *
   * 🔴 UN ECHEC N'EST PAS MEMORISE, ET C'EST LA PROMESSE DU MODULE QU'ON HONORE ICI (jaune de la relecture
   * du 2026-09-23). `cacheCourt` ne garde jamais un REJET, il le dit en toutes lettres ; mais
   * `getPricingAnalytics` AVALE ses pannes et rend `null`, c'est-a-dire une valeur RESOLUE. Un 429, un jeton
   * expire ou une coupure d'une seconde eteignaient donc la colonne « cout » de TOUS les ecrans pendant une
   * minute, sans qu'un rechargement n'y puisse rien. On oublie la cle aussitot : le prochain affichage
   * retentera.
   *
   * ⚠️ ET ON NE MARTELE PAS META POUR AUTANT : la mutualisation des appels EN VOL reste acquise (vingt-cinq
   * onglets qui arrivent ensemble font UN aller-retour, panne comprise). Ce qu'on retire, c'est seulement de
   * resservir un echec a ceux qui arrivent APRES lui.
   *
   * ⚠️ UN SEUL POINT DE PASSAGE, parce qu'il y en avait deux et qu'un des deux avait ete oublie du cache
   * pendant un cycle entier. Un sixieme appelant passera par ici ou nulle part.
   */
  const tarifMeta = async (
    tenant: string,
    startTs: number,
    endTs: number,
    appel: () => Promise<PricingSummary | null>,
  ): Promise<PricingSummary | null> => {
    const cle = `${tenant}:${startTs}:${endTs}`;
    const v = await cacheTarifsMeta.lire(cle, appel);
    if (v === null) cacheTarifsMeta.invalider(cle);
    return v;
  };

  const prixFactures = async (tenant: string, range: { from: string; to: string }): Promise<CategoryRates> => {
    const [wabaId, ligne] = await Promise.all([repo.getTenantWabaId(tenant), statsStore.grillePrixGlobale()]);
    const { startTs, endTs } = rangeToUnix(range);
    const pricingClientT = wabaId ? await metaFactory.pricingClientForTenant(tenant) : null;
    /**
     * 🔴 L'ALLER-RETOUR CHEZ META PASSE SOUS MICRO-CACHE (revue finale du 2026-09-23, son seul rouge).
     *
     * Cet appel n'en avait AUCUN, et quatre écrans le déclenchent : le graphe de coût, la synthèse de
     * Performance Lab, le total des messages envoyés, et depuis ce jour l'onglet Campagnes, qu'on ouvre en
     * permanence. Chaque montage, chaque changement de période et chaque bascule partait donc chez Meta,
     * pour un TARIF qui ne bouge pas dans la minute. C'est une API tierce à quota : la faire appeler par un
     * écran de travail était le vrai défaut, pas la taille de la fenêtre demandée.
     *
     * ⚠️ LA CLÉ PORTE L'ESPACE ET LA FENÊTRE : deux périodes différentes sont deux tarifs différents, et les
     * confondre ferait lire à un écran le prix moyen d'une autre plage. L'espace y est pour la raison
     * habituelle (le filtrage en code est le seul contrôle d'isolation).
     *
     * ⚠️ SOIXANTE SECONDES, comme les compteurs de l'Inbox : ce cache convient à ce qui tolère d'être en
     * retard de quelques secondes, jamais à une décision. Un tarif affiché est exactement de ce genre.
     */
    const pricing = pricingClientT && wabaId
      ? await tarifMeta(tenant, startTs, endTs, () => pricingClientT.getPricingAnalytics(wabaId, startTs, endTs))
      : null;
    // La transformation elle-meme vit dans `tarifsFactures`, PURE et testee : ce cablage ne fait que lire
    // la grille et la lui passer, pour que le cas « une marge de 150 majore le prix » reste eprouvable.
    return tarifsFactures({
      marketing: pricing?.byCategory['marketing']?.ratePerMessage,
      utility: pricing?.byCategory['utility']?.ratePerMessage,
      currency: pricing?.currency,
    }, grilleDepuisLigne(ligne));
  };

  /** Micro-cache de la pastille du numéro : dix minutes, très en deçà de la durée de vie de l'URL signée. */
  const photoNumeroCache = cacheCourt<string | null>(10 * 60_000);

  /**
   * Micro-cache du CATALOGUE de modèles du Gateway : une heure.
   *
   * Un catalogue de 373 modèles et leurs tarifs ne bouge pas d'une minute à l'autre, et cette lecture sert un
   * menu déroulant qu'on ouvre en réglant un agent. Sans cache, chaque ouverture de l'onglet Modèle, de
   * chaque onglet de navigateur ouvert, referait un aller-retour de plusieurs centaines de millisecondes vers
   * Vercel pour une réponse identique.
   */
  const catalogueModelesCache = cacheCourt<ModeleGateway[]>(60 * 60_000);

  /**
   * Micro-cache de l'ÉTAT DU COMPTE PUBLICITAIRE : deux minutes.
   *
   * 🔴 C'EST CE QUI REND TENABLE UNE LECTURE META SUR UN CHEMIN D'AFFICHAGE. La route qui sert
   * l'écran Publicités est volontairement hors du plafond « coûteux » (dix par minute et par espace
   * couperaient la page dès que deux personnes la consultent) : sans cache, chaque ouverture et chaque
   * rafraîchissement ferait un aller-retour Graph, et l'écran dépendrait du temps de réponse de Meta.
   *
   * ⚠️ DEUX MINUTES ET PAS DIX : un statut de compte et un moyen de paiement bougent rarement, mais
   * quand ils bougent, c'est parce que le client vient JUSTEMENT de les corriger chez Meta et revient
   * voir. Dix minutes lui feraient croire que son geste n'a rien fait.
   */
  const etatComptePubCache = cacheCourt<EtatComptePub | null>(2 * 60_000);

  const app = buildServer({
    /**
     * 🔴 SURVEILLANCE DE `/ops` (décision de Julien, 2026-09-03). `/ops` ouvre la lecture de toutes les
     * conversations de tous les clients, et Fastify tourne sans journal d'accès : jusqu'ici, quelqu'un qui
     * cherchait le jeton ne laissait AUCUNE trace. On n'a pas durci l'accès (une liste blanche d'IP couperait
     * Julien dès que son IP change), on l'a rendu VISIBLE.
     *
     * `sendTelegram` est un no-op silencieux si Telegram n'est pas configuré : cette surveillance journalise
     * alors, sans alerter, ce qui reste mieux que rien.
     */
    surveillanceOps: surveillerOps({
      alerter: (m) => { void sendTelegram(`[mba-api] ${m}`); },
      // eslint-disable-next-line no-console
      journaliser: (m) => { console.warn(m); },
    }),
    // Origines autorisées à appeler l'API depuis un navigateur. Vide (le cas d'aujourd'hui) -> aucun en-tête
    // CORS n'est posé du tout. Voir `src/server.ts` pour les deux règles qui la rendent sûre.
    corsOrigins: config.CORS_ORIGINS.split(',').map((o) => o.trim()).filter((o) => o !== ''),
    queue,
    // Readiness : `select 1` (timeout court 2 s) -> /health 503 si la DB est injoignable. /live reste trivial.
    checkReadiness: makeDbReadinessCheck(pool, 2000),
    auth: {
      /**
       * ⚠️ L'ACTEUR EST LE COMPTE VISÉ, pas l'auteur : personne n'est authentifié sur une connexion échouée.
       * L'email est donc résolu depuis CE compte, comme le fait `auditSink` pour un acteur ordinaire.
       */
      auditConnexion: async (tenant, userId, cause) => {
        const email = (await userStore.getSessionUser(userId))?.email ?? null;
        await auditStore.record(tenant, { userId, email }, 'connexion.echouee', { kind: 'user', id: userId }, { cause });
      },
      users: new PgUserAuthStore(pool),
      secret: config.AUTH_SECRET,
      // Re-vérif par requête : compte révoqué/supprimé -> 401 immédiat, rôle frais depuis la base.
      getUserState: (userId) => userStore.getAuthState(userId),
      // Refonte auth : inscription libre, reset/changement de mot de passe.
      createTenantWithAdmin: (name, admin) => userStore.createTenantWithAdmin(name, admin),
      setPassword: (userId, hash) => userStore.setPassword(userId, hash),
      touchLastLogin: (userId) => userStore.touchLastLogin(userId),
      getPasswordHash: (userId) => userStore.getPasswordHash(userId),
      sessionUser: (userId) => userStore.getSessionUser(userId),
      tokens: authTokenStore,
      appUrl: config.APP_URL,
      resetTtlMs: config.RESET_TOKEN_TTL_MS,
      // Se connecter avec Google : client public (bouton front) + vérif serveur du jeton ID + liaison par email.
      googleClientId: config.GOOGLE_CLIENT_ID,
      verifyGoogle: (idToken) => verifyGoogleIdToken(idToken, config.GOOGLE_CLIENT_ID),
      getUserByEmail: (email) => userStore.getByEmail(email),
      ...(sendAuthEmail ? { sendEmail: sendAuthEmail } : {}),
    },
    import: {
      contacts: contactStore,
      userFields: fieldStore,
      defaultCountry: config.DEFAULT_COUNTRY as CountryCode,
      listContacts: (tenantId, limit, offset, tag) => contactStore.list(tenantId, limit, offset, tag),
      queryContacts: (tenantId, filters, limit, offset) => contactStore.query(tenantId, filters, limit, offset),
      countContacts: (tenantId, filters) => contactStore.count(tenantId, filters),
      contactIdsForFilters: (tenantId, filters) => contactStore.idsForFilters(tenantId, filters),
      audit: auditSink,
    },
    campaigns: {
      repo,
      queue,
      drafts: campaignDraftStore,
      // Palier d'envoi du numéro, pour AVERTIR avant un lancement plus gros que ce que Meta laissera passer
      // en 24 h (lot 7). Lecture du relevé déjà persisté, aucun appel Graph sur ce chemin.
      getMessagingLimitTier: async (tenant) => (await phoneStatusStore.getPhoneNumber(tenant))?.messagingLimitTier ?? null,
      phoneNumberBelongsToTenant: (pn, tenant) => repo.phoneNumberBelongsToTenant(pn, tenant),
      // La MÊME résolution de cible que les actions en masse du mini-CRM : une campagne désigne ses
      // destinataires comme le mini-CRM désigne les siens, donc par l'intention et non par une liste
      // d'identifiants qui ne tiendrait pas dans le corps de la requête.
      // 🔴 `limite` DOIT ÊTRE RELAYÉE. Une flèche à DEUX paramètres est parfaitement assignable à un contrat
      // qui en déclare TROIS : le troisième est avalé EN SILENCE, le typecheck ne dit rien, et la route qui
      // passe soigneusement `plafond + 1` retombe sur le plafond technique de 100 000 du store. C'est le
      // défaut même que ce lot ferme, reproduit dans son propre câblage. Trouvé par la contre-vérification
      // du 2026-09-03, pas par le compilateur, qui ne peut pas le voir.
      contactIdsForTarget: (tenant, target, limite) => contactStore.contactIdsForTarget(tenant, target, limite),
      // Le plafond de taille, sur le chemin « tous les contacts », celui qui n'était borné par rien.
      // Bornée à `limite` : le chemin « tous les contacts » ne compte plus, il FIGE son jeu d'identifiants
      // (constat B4). `{ filters: {} }` sélectionne l'espace entier, exactement comme le comptage d'avant,
      // et les contacts bloqués qu'il ramène sont écartés au chargement (`listContactsForBuildByIds`), donc
      // la liste finale de destinataires est identique.
      identifiantsDeTousLesContacts: (tenant: string, limite: number) => contactStore.contactIdsForTarget(tenant, { filters: {} }, limite),
      plafondDestinataires: config.CAMPAIGN_MAX_RECIPIENTS,
      // Garde d'isolation du canal RCS, symétrique de celle du numéro Meta : le partenaire RBM est global,
      // donc c'est CE contrôle qui empêche un tenant de créer une campagne sous la marque d'un autre.
      rcsAgentBelongsToTenant: (agentId, tenant) => workflowRuntime.rcsStack.agents.belongsToTenant(agentId, tenant),
      listRcsAgents: (tenant) => workflowRuntime.rcsStack.agents.listForTenant(tenant),
      // Garde d'un étage e-mail de la chaîne : `getById` est scopée tenant ET écarte les modèles supprimés
      // (suppression douce), donc elle rend null dans les deux cas où la clé étrangère aurait rendu une 5xx.
      emailTemplateBelongsToTenant: async (id, tenant) => (await emailTemplates.getById(tenant, id)) !== null,
      campaignBelongsTo: (id, tenant) => repo.campaignBelongsTo(id, tenant),
      // Campagne AU FIL DE L'EAU : le webhook doit appartenir à l'espace ET être actif. Même nature de garde
      // que pour le numéro Meta et l'agent RCS, sur la troisième porte d'entrée possible des destinataires.
      webhookUsableByTenant: (id, tenant) => webhookStore.usableByTenant(tenant, id),
      stopWebhookCampaign: (id, tenant) => repo.stopWebhookCampaign(id, tenant),
      // Arrêt d'urgence d'un envoi en cours, et son pendant : la reprise lève la pause avant d'enfiler le run.
      // Les deux vont ensemble, câbler l'un sans l'autre donne soit un bouton sans effet, soit une campagne
      // qu'on ne peut plus relancer.
      pauseCampaign: (id, tenant) => repo.pauseCampaign(id, tenant),
      resumeCampaign: (id, tenant) => repo.resumeCampaign(id, tenant),
      getRunSizing: (id) => repo.getRunSizing(id),
      scheduleCampaign: (id, tenant, when) => repo.scheduleCampaign(id, tenant, when),
      cancelSchedule: (id, tenant) => repo.cancelSchedule(id, tenant),
      getWorkflowGraph: async (wfId, tenant) => (await workflowStore.getById(wfId, tenant))?.graph ?? null,
      listCampaigns: (tenant, opts) => repo.listCampaignSummaries(tenant, opts),
      archiveCampaign: (id, tenant) => repo.archiveCampaign(id, tenant),
      unarchiveCampaign: (id, tenant) => repo.unarchiveCampaign(id, tenant),
      deleteDraftCampaign: (id, tenant) => repo.deleteDraftCampaign(id, tenant),
      getCampaignDetail: (id, tenant) => repo.getCampaignDetail(id, tenant),
      resetRecipientForRetry: (tenant, id, rid) => repo.resetRecipientForRetry(tenant, id, rid),
      listPhoneNumbers: (tenant) => repo.listPhoneNumbers(tenant),
      defaultRatePerMinute: config.CAMPAIGN_DEFAULT_RATE_PER_MINUTE,
      // Borne SÛRE pour l'estimation de durée : ces deux routes enfilent sans savoir le canal, et une
      // estimation trop OPTIMISTE fait expirer le job en plein envoi (pg-boss le rejoue, le débit double).
      plafondLePlusBas: plafondLePlusBas(config),
    },
    // Redirection publique des liens tracés. Le tenant vient du code retrouvé en base, jamais de l'URL.
    links: {
      getByCode: (code) => trackedLinkStore.getByCode(code),
      recordClick: (code, tenant, contactId) => trackedLinkStore.recordClick(code, tenant, contactId),
      // QUI a clique (migration 0106). L espace vient du LIEN, jamais de l URL : un jeton d un autre client
      // ne doit pas s attribuer ce clic-ci.
      contactParJeton: (tenant, jeton) => trackedLinkStore.contactParJeton(tenant, jeton),
    },
    // Réception PUBLIQUE des webhooks entrants. L'appelant est un outil tiers : le tenant vient du code, et
    // l'écriture du contact passe par `upsertContactsFromApi`, le chemin partagé avec la création à la main de
    // la console.
    webhookEntrant: {
      limiter: new RateLimiter(config.WEBHOOK_IN_RATE_LIMIT_MAX, config.WEBHOOK_IN_RATE_LIMIT_WINDOW_MS),
      budgetInconnus: new RateLimiter(config.CODES_INCONNUS_PAR_MINUTE, 60_000),
      getByCode: (code) => webhookStore.getByCode(code),
      recordCall: (tenant, id, payload, cree) => webhookStore.recordCall(tenant, id, payload, cree),
      trouverWaId: async (tenant, waId) => ((await contactStore.findIdByWaId(tenant, waId)) ? waId : null),
      ecrireContact: async (tenant, entree) => {
        const [res] = await upsertContactsFromApi(
          tenant,
          [{
            phone: entree.phone,
            fields: entree.fields,
            ...(entree.name ? { name: entree.name } : {}),
            ...(entree.optIn ? { optIn: true, optInSource: entree.optInSource } : {}),
          }],
          { contacts: contactStore, fields: fieldStore },
        );
        // Un seul item entré, donc un seul résultat. L'absence de résultat serait un bug d'`upsertContactsFromApi`,
        // pas un cas métier : on le traite comme un refus plutôt que de laisser passer un succès imaginaire.
        if (!res) return { statut: 'error' as const, raison: 'contact non écrit' };
        return res.status === 'error'
          ? { statut: 'error' as const, ...(res.reason ? { raison: res.reason } : {}) }
          : { statut: res.status };
      },
      publish: async (tenantId, event) => {
        await enfilerEvenementAutomation(queue, { tenantId, event } satisfies AutomationEventJob);
      },
    },
    webhooksAdmin: {
      audit: auditSink,
      list: (tenant) => webhookStore.list(tenant),
      get: (tenant, id) => webhookStore.get(tenant, id),
      create: (tenant, input) => webhookStore.create(tenant, input),
      update: (tenant, id, input) => webhookStore.update(tenant, id, input),
      remove: (tenant, id) => webhookStore.remove(tenant, id),
      rotateSecret: (tenant, id) => webhookStore.rotateSecret(tenant, id),
      clearSecret: (tenant, id) => webhookStore.clearSecret(tenant, id),
      forgetPayload: (tenant, id) => webhookStore.forgetPayload(tenant, id),
      workflowBelongsToTenant: async (wfId, tenant) => (await workflowStore.getById(wfId, tenant)) !== null,
      campagneVivante: (tenant, id) => repo.webhookFeedsLiveCampaign(tenant, id),
      baseUrl: adressesApi.avecPrefixe,
    },
    templates: {
      templatesFor: (tenant) => metaFactory.templateClientForTenant(tenant), // token PAR TENANT (B1), repli global en sommeil
      getWabaId: (tenant) => repo.getTenantWabaId(tenant),
      getPublishedFlow: (tenant, flowId) => flowStore.isPublished(flowId, tenant),
      listActiveCampaignsForTemplate: (tenant, name, language) => repo.listActiveCampaignsForTemplate(tenant, name, language),
      saveParamHints: (tenant, name, language, hints) => templateHintStore.save(tenant, name, language, hints),
      getParamHints: (tenant, name, language) => templateHintStore.get(tenant, name, language),
      removeParamHints: (tenant, name) => templateHintStore.removeByName(tenant, name),
      // Traçage des liens : l'adresse publique est celle qui part DANS LES MESSAGES. Elle vient de
      // `adressesPubliques` et non plus d'`APP_URL` en direct, parce que le front et l'API se séparent :
      // cette adresse-là doit suivre l'API, pas la console.
      tracking: {
        allocate: (tenant, cible, destination, avecJeton) => trackedLinkStore.allocate(tenant, newTrackingCode(), cible, destination, avecJeton),
        confirm: (tenant, codes) => trackedLinkStore.confirm(tenant, codes),
        // 🔴 Le lien SOUMIS porte desormais son suffixe variable : c est lui qui fera voyager le jeton du
        // destinataire, donc qui permettra de savoir QUI a clique. Les templates deja approuves gardent
        // l ancienne forme, leur URL etant figee chez Meta.
        lienDe: (code, avecJeton) => (avecJeton ? lienTraceAvecJeton(adressesApi.racine, code) : lienDe(adressesApi.racine, code)),
        // `adresse de redirection -> destination d'origine` : c'est ce qui permet de remontrer à
        // l'utilisateur le lien qu'il a saisi, partout où la console liste des templates.
        // ⚠️ Les DEUX formes sont dans la map, et il le faut : les templates approuves AVANT le 2026-09-02
        // portent l adresse nue, ceux d apres portent le suffixe variable. N en mettre qu une ferait
        // reapparaitre notre URL de redirection a la place du lien saisi, sur toute une famille de
        // templates, dans les quatre ecrans qui les listent.
        destinations: async (tenant, noms) => new Map(
          (await trackedLinkStore.listByTemplates(tenant, noms)).flatMap((l) => [
            [lienDe(adressesApi.racine, l.code), l.destination] as [string, string],
            [lienTraceAvecJeton(adressesApi.racine, l.code), l.destination] as [string, string],
          ]),
        ),
      },
    },
    inbox: {
      listConversations: (tenant, opts) => inboxStore.listConversations(tenant, opts),
      // « Ouvrir la conversation » depuis la fiche d un contact du mini-CRM : trouve le fil, ou le cree.
      ouvrirConversationDuContact: (tenant, contactId) => inboxStore.ouvrirConversationDuContact(tenant, contactId),
      // Effacer le CONTENU d une conversation. Reserve aux administrateurs par la garde de `server.ts`, et
      // trace au Journal des actions (sans le numero ni le texte : y ecrire ce qu on vient d effacer
      // annulerait l effacement).
      effacerMessages: (tenant, id) => inboxStore.effacerMessages(tenant, id),
      audit: auditSink,
      countATraiter: (tenant) => inboxStore.countATraiter(tenant),
      // Les compteurs du menu de dossiers, plus la charge par membre, en une lecture.
      compterConversations: (tenant) => inboxStore.compterConversations(tenant),
      archiverConversation: (tenant, id, archive) => inboxStore.archiverConversation(tenant, id, archive),
      signalerConversation: (tenant, id, signale, par) => inboxStore.signalerConversation(tenant, id, signale, par),
      marquerTraitee: (tenant, id, traitee) => inboxStore.marquerTraitee(tenant, id, traitee),
      /**
       * ⚠️ LA CLE MAISON PAIE LA TRANSCRIPTION, decision de Julien du 2026-09-09 : « on va le payer
       * nous-memes sur la cle API generale, et on verra apres si je la refacture au client ». Le resolveur
       * par espace existe deja (`clesGateway.lire`) : le jour ou ca change, c'est cette ligne, et elle seule.
       */
      ...(config.AI_GATEWAY_API_KEY && config.TRANSCRIPTION_MODELE ? {
        transcrireMessage: (tenant: string, messageId: string, conversationId?: string, cible?: LangueConsole | null) => transcrireMessage({
          lireMessage: (t, m2, c2) => inboxStore.lireMessagePourTranscription(t, m2, c2),
          // ⚠️ `langue` EST TRANSMISE, et l'oublier ne casserait rien de visible : la transcription
          // marcherait, la langue partirait a la poubelle, et on repaierait une traduction inutile sur
          // chaque vocal deja dans la langue du lecteur.
          ecrireTranscription: (t, m2, texte, modele, langue) => inboxStore.ecrireTranscription(t, m2, texte, modele, langue),
          /**
           * ⚠️ LA TRADUCTION D'UN VOCAL EST SUR LE CREDIT DU CLIENT, la transcription sur NOTRE cle, et
           * les deux cohabitent dans le meme geste. Ce n'est pas une incoherence : la transcription a ete
           * tranchee comme un service offert le 2026-09-09, la traduction sert les conversations du
           * client. Deux decisions, deux payeurs, le meme bouton.
           */
          ...(traducteur ? {
            traduire: (t, texte, cible2, source) => traducteur.traduire(t, texte, cible2, source),
            rangerTraduction: (t, m2, texte, langue) => traductionStore.ranger(t, null, [{ messageId: m2, texte, langue }]),
          } : {}),
          telecharger: (mediaId, max) => mediaClient.telechargerEntrant(mediaId, max),
          // ⚠️ Le transport du MODÈLE (120 s), pas le transport général (30 s) : un fichier de 2 Mo part en
          // base64, donc 2,7 Mo à téléverser, et un modèle a le droit d'être lent là où Meta n'en a pas le
          // droit. Le défaut aurait coupé les transcriptions les plus longues, celles qui servent le plus.
          transport: new FetchTransport(HTTP_TIMEOUT_MODELE_MS),
          cle: config.AI_GATEWAY_API_KEY,
          modele: config.TRANSCRIPTION_MODELE,
          tailleMaxOctets: config.TRANSCRIPTION_TAILLE_MAX_KO * 1024,
          noterCout: (t, m2, cout, secondes) => {
            journaliser('info', 'transcription_cout', { tenantId: t, messageId: m2, coutDollars: cout, secondes });
          },
        }, tenant, messageId, conversationId, cible),
      } : {}),
      /**
       * LIRE UNE PIÈCE JOINTE REÇUE (`lireMediaRecu`, `src/inbox/media-entrant.ts`).
       *
       * 🔴 HORS DU BLOC DE LA TRANSCRIPTION, et c'est le correctif : elle était câblée seulement si un modèle de
       * transcription l'était, donc une instance sans lui répondait 503 sur chaque photo. Lire un fichier n'a
       * besoin que du jeton Meta. Son plafond est le SIEN (`MEDIA_ENTRANT_TAILLE_MAX_KO`), pas les 2 Mo de la
       * transcription.
       */
      lireMediaMessage: (tenant, messageId, conversationId) => lireMediaRecu({
        lireMessage: (t, m2, c2) => inboxStore.lireMessagePourTranscription(t, m2, c2),
        telecharger: (mediaId, max) => mediaClient.telechargerEntrant(mediaId, max),
        tailleMaxOctets: config.MEDIA_ENTRANT_TAILLE_MAX_KO * 1024,
      }, tenant, messageId, conversationId),
      getAssignee: (tenant, id) => inboxStore.getAssignee(tenant, id),
      setAssignee: (tenant, id, assignee, par) => inboxStore.setAssignee(tenant, id, assignee, par),
      // La PRISE d'une conversation du pot commun par un agent (migration 0160) : l'écriture conditionnelle,
      // le réglage de l'espace qui l'autorise, et la liste de l'encadrement que le sélecteur lisait mal.
      prendreSiLibre: (tenant, id, userId) => inboxStore.prendreSiLibre(tenant, id, userId),
      agentsPeuventPrendre: async (tenant) => (await settingsStore.get(tenant)).agentsPeuventPrendre,
      membresPourAffectation: (tenant) => inboxStore.membresPourAffectation(tenant),
      getConversationContext: (id, tenant) => inboxStore.getConversationContext(id, tenant),
      getMessages: (id, apres) => inboxStore.getMessages(id, apres),
      /**
       * LA TRADUCTION DES CONVERSATIONS (migration 0137).
       *
       * ⚠️ LES TROIS LIGNES SONT MONTEES ENSEMBLE OU PAS DU TOUT : une console qui pourrait traduire les
       * entrants sans pouvoir traduire un sortant proposerait un bouton qui rendrait 503, et l inverse
       * laisserait l ecran croire que la traduction est branchee.
       */
      ...(traducteur ? {
        traduireFil: (tenant: string, conversationId: string, messages: ConversationMessage[], cible: LangueConsole) => traduireFil({
          traducteur,
          ranger: (t, c, trads) => traductionStore.ranger(t, c, trads),
          apprendreLangueContact: (t, c, langue) => traductionStore.apprendreLangueContact(t, c, langue),
          // Une ecriture d appoint qui echoue ne prive personne de sa lecture, mais elle fait REPAYER la
          // meme traduction a chaque ouverture : sans ce journal, la fuite ne se verrait que sur la facture.
          onErreur: (err, quoi) => { journaliser('error', 'traduction_ecriture_impossible', { err, quoi, tenantId: tenant }); },
        }, { tenantId: tenant, conversationId, messages, cible }),
        traduireSortant: (tenant: string, texte: string, cible: LangueConsole) => traducteur.traduire(tenant, texte, cible),
        traductionDisponible: (tenant: string) => traducteur.disponible(tenant),
      } : {}),
      // ⚠️ `redaction` EST TRANSMISE, et l'oublier ne casserait RIEN de visible : une fleche a neuf
      // parametres reste assignable a un contrat qui en declare dix, et la redaction d'origine
      // partirait simplement a la poubelle. C'est exactement le defaut que ce cablage portait deja sur
      // le curseur du delta, juste au-dessus.
      recordOutbound: (id, body, msgId, origine, type, cat, name, sender, canal, redaction) => inboxStore.recordOutbound(id, body, msgId, origine, type, cat, name, sender, canal, redaction),
      /**
       * Variables d'un template résolues sur la fiche du contact ouvert, avec le libellé du champ qui les
       * alimente. MÊME résolution que l'envoi réel (`resolveHintParams` + les indices posés à la création du
       * template) : l'écran montre donc exactement ce qui partira, pas une approximation.
       */
      resolveTemplateParams: async (tenant, waId, tpl) => {
        const hints = await templateHintStore.get(tenant, tpl.name, tpl.language);
        const contact = await contactStore.getResolvableByPhone(tenant, waId);
        const { values } = resolveHintParams(hints, tpl.count, contact ?? {}, { now: new Date() });
        // Le libellé dit D'OÙ vient la valeur. Sans lui, une variable pré-remplie « Julien » ne se distingue
        // pas d'une valeur tapée à la main, et l'opérateur ne sait pas ce qui changera pour le contact suivant.
        const parPosition = new Map(hints.map((h) => [h.position, h.source]));
        const labels = Array.from({ length: tpl.count }, (_, i) => {
          const src = parPosition.get(i + 1);
          if (!src) return '';
          if (src.type === 'now') return 'date du jour';
          if (src.type === 'literal') return 'texte fixe';
          return src.key ?? '';
        });
        return { values, labels };
      },
      /**
       * Envoi d'un message RCS depuis l'inbox. Le message vient de la bibliothèque et ses variables sont
       * résolues sur la fiche du contact, exactement comme dans une campagne : c'est le MÊME chemin d'envoi
       * (`rcsStack.sender`), donc les mêmes garde-fous (opt-out, élagage des boutons, normalisation des
       * charges utiles) sans en réécrire un seul.
       *
       * Chaque refus porte sa RAISON, destinée à l'opérateur qui a le doigt sur le bouton : « le canal RCS
       * n'est pas activé » et « ce contact s'est désabonné » demandent deux gestes différents.
       */
      sendRcsFromInbox: async (tenant, waId, contenu) => {
        const agentId = await workflowRuntime.rcsStack.agents.agentIdForTenant(tenant);
        if (!agentId) return { refus: "Le canal RCS n'est pas activé sur cet espace (page d'accueil, sous le numéro WhatsApp)." };
        // Réponse LIBRE : rien à relire en bibliothèque, et rien à substituer non plus. L'opérateur a écrit ce
        // qu'il voulait dire ; y chercher des {{champ}} transformerait une accolade tapée par erreur en trou.
        let brut: RcsOutbound;
        if ('text' in contenu) {
          brut = { kind: 'text', text: contenu.text };
        } else {
          const enregistre = await rcsMessageStore.getById(tenant, contenu.rcsMessageId);
          if (!enregistre?.content) return { refus: 'Ce message RCS n’existe plus, ou son format n’est plus reconnu.' };
          brut = enregistre.content;
        }
        const message = 'text' in contenu
          ? brut
          : aDesVariables(brut)
            ? appliquerVariables(brut, contactVars(await contactStore.getResolvableByPhone(tenant, waId) ?? {}))
            : brut;
        // QUI a cliqué : le jeton du contact ouvert, écrit dans les liens tracés du message. Lu SEULEMENT si
        // le message porte un lien, et jamais bloquant : sans jeton, le lien part tracé mais anonyme.
        const jeton = aDesLiensTracables(message)
          ? (await trackedLinkStore.jetonPourE164(tenant, waId, fabriquerJeton).catch(() => null)) ?? undefined
          : undefined;
        const issue = await workflowRuntime.rcsStack.sender.sendTo(tenant, agentId, waId, message, randomUUID(), jeton);
        if ('skipped' in issue) {
          return {
            refus: issue.skipped === 'rcs_optout'
              ? 'Ce contact s’est désabonné du RCS (il a répondu STOP). Passez par WhatsApp.'
              : 'Ce contact n’est pas joignable en RCS.',
          };
        }
        return { messageId: issue.messageId, apercu: apercuRcsSortant(message) };
      },
      // Un opérateur qui écrit prend le fil : le scénario cesse d'avancer TOUT SEUL sur ce contact et MBA cesse de répondre.
      // 🔴 ÉCRIRE SUFFIT, ET C'EST MESURÉ (2026-09-10) : après une réponse depuis l'Inbox pendant que l'agent
      // de Meta tenait le fil, l'entrant suivant est arrivé en `field: "messages"` et non plus en `standby`.
      // Meta le dit aussi en toutes lettres, « Sending a message to a conversation takes control implicitly ».
      // ⚠️ CE COMMENTAIRE A AJOUTÉ « Meta n'a AUCUNE action `take` », ET C'ÉTAIT FAUX (corrigé le 2026-09-11).
      // L'action existe depuis le 2026-08-13 ; c'est le corpus OpenAPI TÉLÉCHARGÉ qui ne la connaît pas. Elle
      // est désormais câblée sur le bouton « Reprendre la main » (`prendreLeFil`, juste en dessous). Ici,
      // rien à changer : sur un chemin d'ENVOI, l'appel serait une redondance payante.
      // ⚠️ Une CAMPAGNE, elle, part quand même : elle est déclenchée par un opérateur, donc c'est un humain qui a la main, et elle REPREND la conduite du fil (`ignoreHumanControl`). Le contraire a été écrit ici pendant des semaines, cf. `tests/campagne-controle-humain.test.ts`.
      takeControl: async (tenant, waId) => { await inboxStore.setControlOwner(tenant, waId, 'app_human'); },
      /**
       * Le bouton « Reprendre la main » : il PREND le fil chez Meta avant de toucher notre état local.
       *
       * 🔴 C'EST LE CORRECTIF DU 2026-09-11. Le bouton n'écrivait que notre état local ; Meta, lui,
       * continuait de router les entrants du client vers son agent, qui répondait au message suivant.
       * Autrement dit le geste ne faisait rien de ce que son libellé promet, et la seule façon d'éteindre
       * réellement l'agent de Meta était d'ÉCRIRE au client, c'est-à-dire d'envoyer un message qu'on n'a
       * pas à envoyer pour un geste de reprise.
       *
       * ⚠️ ON N'APPELLE META QUE SI META TIENT LE FIL. La doc pose la précondition symétrique sur `release`
       * (« you must currently hold thread control ») et ne dit rien du cas inverse : demander `take` sur un
       * fil qu'on détient déjà est au mieux inutile, au pire une erreur que l'opérateur lirait comme une
       * panne. Reprendre un fil qui n'est tenu par personne chez Meta n'est qu'une écriture locale.
       *
       * ⚠️ LÈVE quand Meta refuse, et la route en fait un 409 lisible. `take` est réservé au « configured
       * escalation partner » : le refus est un cas normal, pas un incident.
       */
      prendreLeFil: async (tenant, waId) => {
        if ((await inboxStore.getControlOwner(tenant, waId)) !== 'mba') return;
        const reglages = await settingsStore.get(tenant);
        if (!reglages.mbaEnabled) return;
        await prendreLeFilAuMba(tenant, waId);
      },
      getControlOwner: (tenant, waId) => inboxStore.getControlOwner(tenant, waId),
      /**
       * L'opérateur rend la main : au scénario, ou à l'agent de Meta quand le client l'a allumé.
       *
       * 🔴 CE PRÉ-CÂBLAGE EST RESTÉ À MOITIÉ FAIT UN JOUR DE TROP. Il écrivait notre état local et
       * n'appelait JAMAIS Meta ; son propre commentaire annonçait l'appel « le jour venu ». Le jour venu
       * était le 2026-09-10, et le symptôme a été exactement celui qu'on pouvait prédire : Julien rend la
       * main, écrit sur WhatsApp, et l'agent de Meta reste muet parce que Meta croit toujours que NOUS
       * tenons le fil (son entrant suivant est arrivé en `field: "messages"`, pas en `standby`).
       *
       * ⚠️ META D'ABORD, NOTRE ÉTAT ENSUITE, ET SEULEMENT S'IL A CONFIRMÉ. L'ordre inverse est précisément
       * ce qui vient de coûter la soirée : un état local qui annonce ce que Meta n'a pas fait est pire
       * qu'une erreur, parce qu'il rend le problème invisible. Un échec REMONTE à l'appelant, qui le
       * traduit en 4xx lisible plutôt qu'en 500 dont Cloudflare mange le corps.
       *
       * ⚠️ `mbaEnabled` est notre drapeau, il peut avoir dérivé de l'état réel chez Meta. C'est acceptable
       * ICI parce que la dérive est réparée automatiquement à chaque message entrant, à partir du `field`
       * du webhook (`processInbound`) : au pire on rend au scénario un fil que Meta donnerait au MBA, et
       * le premier message suivant remet les deux d'accord.
       */
      releaseControl: async (tenant, waId) => {
        /**
         * 🔴 UN SEUL BOUTON, DEUX GESTES OPPOSÉS, ET C'EST CE QUI A CASSÉ. L'écran affiche « Rendre la main »
         * quand un opérateur détient le fil, et « Reprendre la main » quand c'est l'agent de Meta : deux
         * libellés contraires pour le MÊME appel. Ça marchait tant que cette fonction ne faisait qu'écrire
         * `app_workflow` en local. Depuis qu'elle appelle Meta (2026-09-10), partir de `mba` revenait à
         * RENDRE le fil à celui qui l'a déjà : un bouton sans effet, sous un libellé qui promet l'inverse.
         *
         * ⚠️ CE BRANCHEMENT N'EST PLUS LE CHEMIN DU BOUTON « Reprendre la main », qui va désormais sur
         * `/prendre` et appelle réellement `thread_control` avec l'action `take` (2026-09-11). Il reste ici
         * pour le cas où `/release` est appelée alors que Meta tient le fil : releaser sans le détenir est
         * hors contrat (« you must currently hold thread control »), donc on ne fait que rouvrir NOTRE côté,
         * ce qui est le geste sûr.
         * ⚠️ Ce commentaire a dit « il n'existe aucune action `take` chez Meta ». C'était faux, et c'est ce
         * qui a laissé l'agent de Meta répondre juste après un clic sur « Reprendre la main ».
         */
        // ⚠️ LES QUATRE BRANCHES CLÔTURENT L'ESCALADE : c'est le même geste délibéré, quelle que soit la valeur
        // écrite. Trois d'entre elles posent `app_workflow`, que « À traiter » exclut : la conversation
        // disparaissait avec son drapeau intact, et plus rien ne l'effaçait (revue finale du 2026-09-23).
        if ((await inboxStore.getControlOwner(tenant, waId)) === 'mba') {
          await inboxStore.setControlOwner(tenant, waId, 'app_workflow', { effacerEscalade: true });
          return 'app_workflow';
        }
        const reglages = await settingsStore.get(tenant);
        if (!reglages.mbaEnabled) {
          await inboxStore.setControlOwner(tenant, waId, 'app_workflow', { effacerEscalade: true });
          return 'app_workflow';
        }
        const rendu = await rendreLeFilAuMba(tenant, waId);
        if (!rendu) {
          // Aucun numéro connecté : il n'y a pas de fil à rendre chez Meta, et notre état local reste la
          // seule vérité. Ce n'est pas un échec, c'est un espace sans WhatsApp.
          await inboxStore.setControlOwner(tenant, waId, 'app_workflow', { effacerEscalade: true });
          return 'app_workflow';
        }
        // Geste DÉLIBÉRÉ d'un opérateur (« Rendre la main ») : il clôt l'escalade, elle n'attend plus personne.
        await inboxStore.setControlOwner(tenant, waId, 'mba', { effacerEscalade: true });
        return 'mba';
      },
      /** Lancement d'un SCÉNARIO depuis l'Inbox : le chemin partagé avec l'agent de Meta (`lancerScenarioPourContact`). */
      startWorkflow: (tenant, workflowId, waId, windowOpen) => lancerScenarioPourContact(tenant, workflowId, waId, windowOpen),
      countUnread: (tenant, acteur) => inboxStore.countUnread(tenant, acteur),
      markConversationRead: (tenant, conversationId) => inboxStore.markConversationRead(tenant, conversationId),
      getTenantPhoneNumberId: (tenant) => repo.getTenantPhoneNumberId(tenant),
      sendReply: async (tenant, phoneNumberId, to, text) => {
        const client = await metaFactory.clientForTenant(tenant, phoneNumberId); // token PAR TENANT (B1), repli global en sommeil
        return (await client.sendText(to, text)).messageId;
      },
      sendTemplateMessage: async (tenant, phoneNumberId, to, tpl) => {
        const client = await metaFactory.clientForTenant(tenant, phoneNumberId); // token PAR TENANT (B1), repli global en sommeil
        const components = buildTemplateComponents({
          bodyParams: tpl.bodyParams,
          ...(tpl.headerMediaUrl ? { headerMediaUrl: tpl.headerMediaUrl } : {}),
          ...(tpl.headerFormat ? { headerFormat: tpl.headerFormat } : {}),
          ...(tpl.carousel ? { carousel: tpl.carousel } : {}),
        });
        const spec = { name: tpl.name, language: tpl.language, ...(components.length > 0 ? { components } : {}) };
        return (await client.sendTemplate(to, spec)).messageId;
      },
      /**
       * Cartes d'un template CAROUSEL, relues chez Meta et visuels re-téléversés pour l'envoi. `null` si le
       * template n'est pas un carousel : l'envoi classique reste strictement inchangé.
       */
      /**
       * 🔴 LA GARDE D OPT-OUT DE L ENVOI DE MODELE DEPUIS L INBOX, et elle est en DEUX morceaux : le statut
       * du contact, et la categorie REELLE du modele. Le corps de la requete porte bien un
       * `templateCategory`, mais il vient du navigateur et ne sert qu aux statistiques : s en servir comme
       * garde laisserait n importe qui se declarer « utility ».
       *
       * ⚠️ `templateVarInfo` est la MEME lecture que le worker, avec son cache court : le cas ou la
       * question se pose (un contact desabonne) ne paie donc quasiment jamais un appel a Meta.
       */
      estDesabonne: (tenant, waId) => contactStore.estDesabonneParWaId(tenant, waId),
      categorieDuModele: async (tenant, name, language) => {
        const cat = (await workflowRuntime.templateVarInfo(tenant, name, language))?.category;
        return cat === 'utility' ? 'utility' : cat === 'marketing' ? 'marketing' : null;
      },
      prepareCarousel: async (tenant, name, language) => {
        // MÊME lecture que le worker (résolution nom+langue, repli sur le nom seul, cache court) : c'est
        // `templateVarInfo` de la fabrique partagée. L'API en avait sa propre copie, sans cache.
        const lu = (await workflowRuntime.templateVarInfo(tenant, name, language))?.carousel;
        if (!lu) return null;
        const cards = await workflowRuntime.prepareCarouselMedia(tenant, lu.cards);
        const refus = carouselSendBlocker(cards);
        return refus === null ? { cards } : { refus: `Carousel non envoyable : ${refus}` };
      },
    },
    // Canal ENTRANT depuis le connecteur HubSpot. Même secret partagé que le canal sortant (le connecteur
    // l'appelle SERVICE_SECRET), et même format de signature : on ne crée pas un troisième schéma.
    ...(config.HUBSPOT_SERVICE_SECRET ? {
      hubspotEvents: {
        secret: config.HUBSPOT_SERVICE_SECRET,
        findWaId: async (tenant: string, waId: string) => ((await contactStore.findIdByWaId(tenant, waId)) ? waId : null),
        publish: async (tenantId: string, event: { kind: 'hubspot_deal_stage'; waId: string; pipelineId: string; stageId: string }) => {
          await enfilerEvenementAutomation(queue, { tenantId, event } satisfies AutomationEventJob);
        },
      },
    } : {}),
    stats: {
      getDashboard: (tenant, range) => statsStore.getDashboard(tenant, range),
      getTemplateBreakdown: (tenant, range) => statsStore.getTemplateBreakdown(tenant, range),
      // La MEME grille que les prix affiches au-dessus : deux lectures donneraient deux marges.
      // ⚠️ `tenant` N'EST PLUS LU, et la fleche le garde parce que le CONTRAT de la route le passe : une
      // seule grille sert tous les espaces depuis la migration 0168.
      margeTemplate: async () => grilleDepuisLigne(await statsStore.grillePrixGlobale()).margeTemplate,
      /**
       * 🔴 CE CHEMIN AUSSI PORTE LA MARGE, ET IL A ETE OUBLIE DEUX FOIS. Son resultat alimente la carte
       * « Detail par template » du Quantitatif ET le cout affiche sur l ecran Campagnes (total, ligne, et
       * tiroir de detail). L inventaire des consommateurs avait ete fait sur `prixFactures`, alors que la
       * bonne question etait « qui affiche un prix de template a un client ». Sans marge ici, la MEME
       * campagne valait 1,00 € sur l ecran Campagnes et 1,50 € sur sa fiche Performance Lab, et deux cartes
       * de la MEME page annoncaient deux totaux. Releve a la troisieme revue du 2026-09-18.
       *
       * ⚠️ `cost` ET `totalCost` NE SONT PAS MARGES, et c est delibere : ce sont les charges REELLES que
       * Meta a facturees sur la periode, pas une projection de vente. Seul `ratePerMessage` devient un prix,
       * parce que c est le seul que les ecrans multiplient par un volume pour annoncer un montant au client.
       * Les melanger ferait un total qui n est ni l un ni l autre.
       */
      getPricing: async (tenant, range) => {
        const [wabaId, ligne] = await Promise.all([repo.getTenantWabaId(tenant), statsStore.grillePrixGlobale()]);
        if (!wabaId) return null;
        const { startTs, endTs } = rangeToUnix(range);
        const pricing = await metaFactory.pricingClientForTenant(tenant); // token PAR TENANT (B1), repli global en sommeil
        // 🔴 LE MEME CACHE QUE `prixFactures`, ET C'EST LE CINQUIEME APPELANT QU'UNE RELECTURE A TROUVE
        // (2026-09-23). Cette route sert « Detail par template », que l'onglet Campagnes appelle LUI AUSSI a
        // chaque montage : le cache pose sur l'autre chemin etait donc contourne par la porte d'a cote, et
        // l'ecran le plus ouvert du produit repartait chez Meta a chaque affichage. Meme cle, meme fenetre.
        const brut = await tarifMeta(tenant, startTs, endTs, () => pricing.getPricingAnalytics(wabaId, startTs, endTs));
        if (!brut) return brut;
        return pricingFacture(brut, grilleDepuisLigne(ligne));
      },
      getCampaignFunnel: (tenant, campaignId) => statsStore.getCampaignFunnel(tenant, campaignId),
      getErrorBreakdown: (tenant, range, templateName) => statsStore.getErrorBreakdown(tenant, range, templateName),
      // Le MÊME journal que l'écran d'exploitation (`/parametres`), avec le code et la plage en filtre. Une
      // seconde requête propre à Analytics existait : elle comptait une population voisine, donc les deux
      // écrans, qui portent le même titre, se seraient contredits chez un client.
      getErrorContacts: (tenant, range, code, filter) => erreursLivraison.lister(tenant, {
        code,
        from: range.from,
        to: range.to,
        ...filter,
        // Une ligne de plus que le plafond : c'est ainsi que la route sait qu'elle tronque, et le dit.
        limit: PLAFOND_CONTACTS_ERREUR + 1,
      }),
      getCostSeries: async (tenant, range, filter) => {
        const [rows, rates] = await Promise.all([
          statsStore.getCostVolume(tenant, range, filter),
          prixFactures(tenant, range),
        ]);
        return estimateCostSeries(range.from, range.to, rows, rates);
      },
      /**
       * Le tableau « ce que coûte un engagement » de la page de synthèse (lot E).
       *
       * ⚠️ Les tarifs Meta viennent du MÊME appel que le graphe de coût (`prixFactures`) : deux façons de les
       * lire donneraient deux coûts sur deux écrans du même onglet, et le client comparerait. Le calcul,
       * lui, est pur (`estimateCoutParCampagne`) et vit à côté de celui de la série, avec ses règles.
       */
      getCoutParCampagne: async (tenant, range, opts) => {
        const [volumes, rates, serviceMois, ligne, rcs] = await Promise.all([
          // ⚠️ LA RETENTION VOYAGE JUSQU'ICI, et c'est ce qui permet a une campagne dont les envois ont ete
          // purges de garder une case VIDE plutot qu'un 0,00 € qui se lirait « gratuit ».
          statsStore.getVolumeParCampagne(tenant, range, { ...opts, retentionJours: config.CONVERSATION_RETENTION_DAYS }),
          prixFactures(tenant, range),
          // 🔴 LE MEME CALCUL DE FRANCHISE QUE LA LIGNE « MESSAGES », par les mêmes deux lectures. Deux
          // façons de déduire la franchise donneraient deux coûts de service sur la MÊME carte, à deux
          // lignes d'écart, et le client comparerait. Voir `estimateCoutParCampagne` pour le prorata.
          statsStore.serviceParMois(tenant, range),
          statsStore.grillePrixGlobale(),
          // 🔴 ET LE MEME LOT DE RCS QUE CETTE LIGNE-LA, par la même lecture et la même règle de bascule.
          // Une campagne RCS affichait « — » alors que son prix est saisi depuis la migration 0154.
          // ⚠️ `attribuer` : SEUL cet appelant lit `campaignId`, et l'attribution coute une sous-requete
          // correlee par message RCS, non servie par un index. L'autre route s'en passe desormais.
          statsStore.envoisEtReactionsRcs(tenant, range, FENETRE_BASCULE_MS, { attribuer: true }),
        ]);
        const ids = [...new Set(volumes.map((v) => v.campaignId))];
        // ⚠️ LES TROIS ENSEMBLE, pas l'une après l'autre : ce sont des lectures indépendantes sur la même
        // liste d'identifiants, et cette route sert la page d'accueil de Performance lab.
        const [clics, engagements, services] = await Promise.all([
          statsStore.clicsParCampagne(tenant, ids),
          statsStore.engagementsParCampagne(tenant, ids),
          statsStore.servicesParCampagne(tenant, ids, range),
        ]);
        /**
         * LE PRIX EFFECTIF D'UN MESSAGE DE SERVICE SUR LA PERIODE, franchise déjà déduite.
         *
         * ⚠️ IL SE CALCULE, IL NE SE LIT PAS DANS LA GRILLE. Le prix du tarif (2,48 cts) est celui d'un
         * message FACTURÉ ; la franchise mensuelle en rend une partie gratuite, et une période qui tombe
         * entièrement sous le millième a un prix effectif de ZÉRO. Prendre le tarif nu surfacturerait
         * chaque campagne du début de mois.
         *
         * ⚠️ `envoyes === 0` -> pas de division, et pas d'imputation : aucun message de service n'existe
         * sur la période, donc il n'y a rien à répartir.
         */
        const cm = coutMessages(
          { templates: [], rates, service: serviceMois, rcsSimple: 0, rcsConversationnel: 0 },
          grilleDepuisLigne(ligne),
        );
        const prixUnitaire = cm.service.envoyes > 0 ? cm.service.cout / cm.service.envoyes : 0;
        /**
         * LES RCS DE CHAQUE CAMPAGNE, SIMPLES D'UN COTE, CONVERSATIONNELS DE L'AUTRE.
         *
         * 🔴 LA BASCULE SE CALCULE SUR TOUS LES ENVOIS DE L'ESPACE, PAS SUR CEUX D'UNE CAMPAGNE, et c'est la
         * règle elle-même qui l'impose : elle fait passer l'ECHANGE entier à 8 cts dès qu'une réaction suit
         * l'un de ses envois dans les sept jours. Un RCS envoyé hors campagne peut donc faire basculer les
         * RCS de campagne du même échange. `basculesRcs` reçoit ainsi la totalité, puis on impute.
         *
         * ⚠️ LES LIGNES SANS CAMPAGNE SONT IGNOREES A L'IMPUTATION, mais pas à la bascule (voir ci-dessus).
         */
        const envoisRcs = rcs.conversations.flatMap((c) =>
          c.instants.map((at) => ({ id: '', conversationId: c.conversationId, waId: c.waId, at })));
        const bascules = basculesRcs(envoisRcs, rcs.reactions);
        const rcsParCampagne = new Map<string, { simple: number; conversationnel: number }>();
        for (const c of rcs.conversations) {
          if (c.campaignId === null) continue;
          const acc = rcsParCampagne.get(c.campaignId) ?? { simple: 0, conversationnel: 0 };
          if (bascules.has(c.conversationId)) acc.conversationnel += c.envois; else acc.simple += c.envois;
          rcsParCampagne.set(c.campaignId, acc);
        }
        // La marge est DEJA dans `rates` (cf. `prixFactures`) : la reappliquer ici la compterait deux fois.
        // ⚠️ La marge ne touche PAS le RCS : elle porte sur le tarif Meta, quand le prix RCS est saisi par
        // l'espace, donc déjà un prix de vente (migration 0154).
        return estimateCoutParCampagne(volumes, rates, clics, engagements,
          { parCampagne: services, prixUnitaire },
          { parCampagne: rcsParCampagne, grille: grilleDepuisLigne(ligne) });
      },
      /**
       * LE COUT TOTAL DES MESSAGES DE LA PERIODE : templates margés, service franchise déduite, RCS.
       *
       * 🔴 LES MEMES TARIFS META QUE LE GRAPHE ET QUE LE TABLEAU, par le même `prixFactures`. Trois écrans du
       * même onglet lisent ce chiffre ; deux lectures de tarif différentes produiraient deux totaux que le
       * client mettrait côte à côte.
       *
       * 🔴 LA BASCULE RCS EST CALCULEE ICI, PAR LA FONCTION PURE, ET PAS EN SQL. La règle (« une réaction
       * dans les sept jours fait passer l'échange ENTIER à 8 cts ») vit dans `basculesRcs`, qui est testée
       * et mutée dans les deux sens. La recopier en SQL en ferait deux implémentations, et le jour où l'une
       * changerait l'autre resterait juste assez plausible pour ne pas se voir. Le store, lui, réduit le
       * transport à une ligne par conversation en gardant TOUS les instants : rien n'est approximé.
       *
       * ⚠️ LA FENETRE EST PASSEE AU SQL depuis `FENETRE_BASCULE_MS`, au lieu d'un `interval '7 days'` écrit
       * à côté : c'est l'invariant « deux constantes de fichiers différents qui doivent rester ordonnées »,
       * et ce dépôt l'a déjà payé.
       */
      getCoutMessages: async (tenant, range) => {
        const [volumes, rates, service, rcs, ligne] = await Promise.all([
          statsStore.getCostVolume(tenant, range, {}),
          prixFactures(tenant, range),
          statsStore.serviceParMois(tenant, range),
          statsStore.envoisEtReactionsRcs(tenant, range, FENETRE_BASCULE_MS),
          statsStore.grillePrixGlobale(),
        ]);
        // Les instants d'envoi redéployés en un envoi par instant : c'est la forme que la fonction pure
        // attend, et la reconstruire ici coûte des objets éphémères plutôt que des lignes de base.
        const envoisRcs = rcs.conversations.flatMap((c) =>
          c.instants.map((at) => ({ id: '', conversationId: c.conversationId, waId: c.waId, at })));
        const bascules = basculesRcs(envoisRcs, rcs.reactions);
        // ⚠️ Le compte se fait sur les ENVOIS de chaque conversation, pas sur le nombre de conversations :
        // un échange basculé facture TOUS ses RCS au tarif haut, ce qui est précisément la règle.
        let rcsSimple = 0;
        let rcsConversationnel = 0;
        for (const c of rcs.conversations) {
          if (bascules.has(c.conversationId)) rcsConversationnel += c.envois; else rcsSimple += c.envois;
        }
        return coutMessages(
          {
            templates: volumes.map((v) => ({ category: v.category, count: v.count })),
            rates,
            service,
            rcsSimple,
            rcsConversationnel,
          },
          grilleDepuisLigne(ligne),
        );
      },
      /**
       * CE QUE LE CLIENT A DEPENSE EN IA sur SON crédit, et le détail de ses tours.
       *
       * ⚠️ RIEN DE CE QUI EST SUR NOTRE CLE N'Y ENTRE (transcription, bot d'aide, assistants de
       * configuration), et le Meta Business Agent non plus : il tourne chez Meta et se facture au message
       * de service, donc son coût est dans `getCoutMessages`, pas ici.
       */
      getCoutIa: async (tenant, range) => statsStore.consommationIa(tenant, range, PLAFOND_TOURS_IA),
      /**
       * La fiche d'UNE campagne, ouverte en cliquant sa ligne dans le tableau ci-dessus.
       *
       * 🔴 LES MÊMES TARIFS QUE LE TABLEAU, par le même `prixFactures`, et c'est ce qui empêche les deux
       * écrans de se contredire au moment précis où on les met côte à côte : le clic sur une ligne ouvre
       * cette fiche, et deux lectures de tarif différentes y afficheraient deux coûts pour la même campagne.
       *
       * ⚠️ LES TARIFS SONT CEUX DES 30 DERNIERS JOURS, alors que la fiche couvre toute la VIE de la
       * campagne. C'est une approximation ASSUMÉE et non un oubli : Meta rend un tarif PAR PÉRIODE, et
       * demander la période exacte de chaque campagne multiplierait les appels sans rien changer au chiffre
       * (les tarifs bougent de quelques centimes par an). La carte annonce déjà un coût ESTIMÉ qui n'est
       * pas une facture ; c'est la même réserve, pas une nouvelle.
       *
       * `null` -> 404 : la campagne n'est pas dans cet espace. La lecture de la fiche vient AVANT le reste,
       * pour ne pas payer trois requêtes sur un identifiant qui n'existe pas.
       */
      getDetailCoutCampagne: async (tenant, campaignId) => {
        const campagne = await statsStore.ficheCampagne(tenant, campaignId);
        if (campagne === null) return null;
        const [envois, rates, funnel, evenements] = await Promise.all([
          statsStore.envoisDeLaCampagne(tenant, campaignId),
          // Les 30 derniers jours, la fenêtre par défaut du tableau : c'est LUI qui sert de référence,
          // parce que c'est de lui qu'on ouvre cette fiche.
          prixFactures(tenant, { from: addDays(todayParis(), -29), to: todayParis() }),
          statsStore.getCampaignFunnel(tenant, campaignId),
          campagne.workflowId ? statsStore.mesuresScenarioParCampagne(tenant, campaignId) : Promise.resolve([]),
        ]);
        /**
         * Les clics de liens tracés, ATTRIBUÉS à cette campagne, fusionnés aux événements de blocs.
         *
         * ⚠️ MÊME MONTAGE que `getWorkflowNodeCounts` juste en dessous (graphe -> blocs template -> liens ->
         * `compteursDeClics`), et c'est délibéré : le node d'un clic ne se déduit que du GRAPHE, et deux
         * façons de faire ce chemin donneraient deux répartitions par bloc sur deux écrans.
         *
         * Best-effort, pour la même raison qu'à côté : une panne de cette lecture retire la colonne des
         * liens, elle ne doit pas emporter le coût ni les réponses, qui sont déjà là.
         */
        let clics: CompteurClic[] = [];
        let clicsAnonymes = 0;
        if (campagne.workflowId) {
          try {
            const wf = await workflowStore.getById(campagne.workflowId, tenant);
            const noeuds = noeudsTemplate(wf?.graph);
            if (noeuds.length > 0) {
              const liens = await trackedLinkStore.listByTemplates(tenant, noeuds.map((n) => n.templateName));
              if (liens.length > 0) {
                const compte = await trackedLinkStore.clicsAttribuesCampagne(tenant, campaignId, liens.map((l) => l.code));
                clics = compteursDeClics(noeuds, liens, compte.attribues);
                clicsAnonymes = compte.anonymes;
              }
            }
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error('clics attribues a la campagne ignores:', err instanceof Error ? err.message : err);
          }
        }
        return assemblerDetailCampagne({
          campagne, envois, rates, funnel, mesures: [...evenements, ...clics], clicsAnonymes,
        });
      },
      /**
       * Mesures d'un scénario : les événements de blocs, PLUS les clics sur les liens tracés des templates
       * qu'il envoie. Les seconds ne peuvent pas vivre dans `workflow_node_events` (elle exige un `wa_id`,
       * or un clic sur un lien statique n'identifie personne) : ils sont donc fusionnés à la LECTURE.
       *
       * Best-effort sur la partie liens : une panne ici retire la mesure de clic, elle ne doit pas emporter
       * les compteurs d'envoi et de lecture qui, eux, sont disponibles.
       */
      getWorkflowNodeCounts: async (tenant, workflowId, range) => {
        const evenements = await nodeEventStore.countByNode(tenant, workflowId, range);
        try {
          const wf = await workflowStore.getById(workflowId, tenant);
          const noeuds = noeudsTemplate(wf?.graph);
          // Les blocs RCS ont leurs propres liens, sur une AUTRE clé (l'adresse, migration 0107) et un autre
          // espace de noms de handle (`lien:i`). Les deux familles se lisent séparément puis se concatènent :
          // les mélanger dans une seule requête reviendrait à joindre deux tables sur rien.
          const liensRcs = liensRcsDesNoeuds(wf?.graph);
          if (noeuds.length === 0 && liensRcs.length === 0) return evenements;

          const codesRcs = liensRcs.length > 0
            ? await trackedLinkStore.codesRcsParDestination(tenant, liensRcs.map((l) => l.destination))
            : new Map<string, string>();
          const liens = noeuds.length > 0
            ? await trackedLinkStore.listByTemplates(tenant, noeuds.map((n) => n.templateName))
            : [];
          const tousLesCodes = [...liens.map((l) => l.code), ...codesRcs.values()];
          if (tousLesCodes.length === 0 && liensRcs.length === 0) return evenements;
          const clics = await trackedLinkStore.countClicks(tenant, tousLesCodes, range);
          return [
            ...evenements,
            ...compteursDeClics(noeuds, liens, clics),
            ...compteursDeClicsRcs(liensRcs, codesRcs, clics),
          ];
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('mesures de clics ignorées:', err instanceof Error ? err.message : err);
          return evenements;
        }
      },
      getConversationSummary: (tenant, range) => conversationStatsStore.getSummary(tenant, range),
      listAnalyzedConversations: (tenant, range, filters) => conversationStatsStore.listAnalyzed(tenant, range, filters),
      getNuageQualitatif: (tenant, range) => conversationStatsStore.getNuageQualitatif(tenant, range),
      /**
       * LES JOURNEES de l ecran « Analyse des conversations » (2026-09-17).
       *
       * ⚠️ AUCUN CALCUL ICI, et c est voulu : l agregation se fait EN BASE, bornee par le nombre de jours
       * de la periode. Descendre une ligne par conversation pour les grouper ensuite ferait transiter tout
       * ce que cet ecran existe justement pour ne plus transiter.
       */
      /**
       * 🔴 `joursAnalyse` ET PAS `parJour` : la lecture FUSIONNÉE. Les vraies données font foi tant
       * qu'elles existent (choix de Julien du 2026-09-17), les agrégats comblent au-delà de la rétention.
       * Brancher `parJour` seul ferait disparaître l'historique de l'écran le jour où la purge passe,
       * c'est-à-dire exactement ce que la table d'agrégats existe pour empêcher.
       */
      getJoursAnalyse: (tenant, range) => conversationStatsStore.joursAnalyse(tenant, range),
    },
    workflowReports: {
      listReports: (tenant) => reportStore.list(tenant),
      saveReport: (tenant, input) => reportStore.save(tenant, input),
      removeReport: (tenant, id) => reportStore.remove(tenant, id),
    },
    settings: {
      getSettings: (tenant) => settingsStore.get(tenant),
      // Canal RCS allumé dès qu'un agent est rattaché au tenant : l'interface suit l'état réel du dépôt.
      rcsEnabledFor: (tenant) => workflowRuntime.rcsStack.agents.hasAgent(tenant),
      setMbaEnabled: (tenant, enabled) => settingsStore.setMbaEnabled(tenant, enabled),
      setHubspotListsEnabled: (tenant, enabled) => settingsStore.setHubspotListsEnabled(tenant, enabled),
      /**
       * UN PORTAIL HUBSPOT EST-IL LIE A CET ESPACE ? (lot 9, 2026-09-23)
       *
       * ⚠️ LECTURE LOCALE : le mapping vit dans le schema `mmhs` de la MEME base, donc une jointure indexee
       * sur `tenant_id`, pas un aller-retour vers le connecteur. C'est ce qui rend acceptable de la poser
       * sur une route que plusieurs ecrans appellent a l'ouverture.
       *
       * 🔴 `catch -> false` ET C'EST LE BON SENS DU REPLI, a la difference de la plupart des gardes de ce
       * depot. Le cas d'erreur reel n'est pas un hoquet reseau, c'est une base ou le schema `mmhs` N'EXISTE
       * PAS (instance sans connecteur HubSpot, base de CI) : `42P01`. Repondre « connecte » y offrirait une
       * source qui ne peut pas fonctionner. La route du statut de compte fait deja exactement ce repli.
       */
      hubspotPortalConnecte: (tenant) => phoneStatusStore.getHubspotPortal(tenant).then((p) => p.connected).catch(() => false),
      setControlHandbackSeconds: (tenant, seconds) => settingsStore.setControlHandbackSeconds(tenant, seconds),
      setMbaHandoffMode: (tenant, mode) => settingsStore.setMbaHandoffMode(tenant, mode),
      // Applique le choix chez Meta immédiatement. Mêmes helpers que le balayage horaire, pour que « je viens
      // de choisir » et « l'heure a changé » écrivent exactement la même chose.
      applyMbaHandoffEnabled: (tenant, enabled) => ecrireHandoffEnabled(
        { clientFor: (t) => metaFactory.mbaClientForTenant(t), phoneNumberFor: (t) => repo.getTenantPhoneNumberId(t) },
        tenant,
        enabled,
      ),
      setTimezone: (tenant, tz) => settingsStore.setTimezone(tenant, tz),
      setBusinessHours: (tenant, hours) => settingsStore.setBusinessHours(tenant, hours),
      /**
       * LE CONNECTEUR PREVENU A CHAQUE DESABONNEMENT (migration 0139).
       *
       * ⚠️ On ne rend que l IDENTIFIANT et le LIBELLE, pas la requete entiere : l ecran du Consentement a
       * besoin de nommer un appel, pas de connaitre son adresse, ses en-tetes ni ce qu il envoie.
       */
      listerRequetesConnecteur: async (tenant) => (await agentRequetes.lister(tenant)).map((r) => ({ id: r.id, label: r.label })),
      setOptoutRequestId: (tenant, requestId) => settingsStore.setOptoutRequestId(tenant, requestId),
      /**
       * « L IA se declare comme telle », au niveau de l ESPACE (migration 0140).
       *
       * ⚠️ La LISTE porte la PHRASE de chaque agent, pas seulement son nom : le reglage dit QUAND on
       * annonce, il ne dit pas CE QU ON annonce, et un ecran de conformite qui cacherait le texte
       * promettrait une verification qu il ne permet pas de faire.
       */
      setMentionIaFrequence: (tenant, frequence) => settingsStore.setMentionIaFrequence(tenant, frequence),
      setAgentTransfertMode: (tenant, mode) => settingsStore.setAgentTransfertMode(tenant, mode),
      setAgentsPeuventPrendre: (tenant, actif) => settingsStore.setAgentsPeuventPrendre(tenant, actif),
      listerAgentsPourConformite: (tenant) => agentStore.listerPourConformite(tenant),
    },
    // Import de listes HubSpot (3e source de campagne) : monté seulement si le canal service est configuré.
    ...(config.HUBSPOT_SERVICE_URL
      ? {
          hubspotImport: {
            // Accès listes = réglage utilisateur + flag pause (F3-b). La pause du toggle Synchronisation pose
            // campaigns_paused (même transaction que hubspot_paused_at), sans écraser hubspot_lists_enabled. La route compose.
            listsAccess: async (tenant: string) => {
              const s = await settingsStore.get(tenant);
              return { enabled: s.hubspotListsEnabled, paused: s.campaignsPaused };
            },
            fetchLists: (tenant: string, query?: string) => fetchHubspotLists({ baseUrl: config.HUBSPOT_SERVICE_URL, secret: config.HUBSPOT_SERVICE_SECRET, transport }, tenant, query),
            importList: (tenant: string, listId: string, listName: string) =>
              importHubspotList({ baseUrl: config.HUBSPOT_SERVICE_URL, secret: config.HUBSPOT_SERVICE_SECRET, transport }, { contacts: contactStore, userFields: fieldStore }, tenant, listId, listName),
          },
          // Étapes de deal : même canal service, mais AUCUN rapport avec le réglage « listes » (cf. la route).
          hubspotPipelines: {
            fetchDealStages: (tenant: string) =>
              fetchHubspotDealStages({ baseUrl: config.HUBSPOT_SERVICE_URL, secret: config.HUBSPOT_SERVICE_SECRET, transport }, tenant),
          },
        }
      : {}),
    // Émission du lien d'install/re-consentement HubSpot signé (admin-only). Vide si l'origine publique du connecteur
    // ou le secret ne sont pas configurés -> la route répond 503, le front garde son bouton.
    hubspotInstall: {
      connectorPublicUrl: config.HUBSPOT_CONNECTOR_PUBLIC_URL,
      serviceSecret: config.HUBSPOT_SERVICE_SECRET,
    },
    admin: {
      audit: auditSink,
      listUsers: (tenant) => userStore.list(tenant),
      setUserRole: (tenant, userId, role) => userStore.setRole(tenant, userId, role),
      setUserDisabled: (tenant, userId, disabled) => userStore.setDisabled(tenant, userId, disabled),
      deleteUser: (tenant, userId) => userStore.deleteUser(tenant, userId),
      createPendingUser: (tenant, email, role, name) => userStore.createPending(tenant, email, role, name),
      setUserName: (tenant, userId, name) => userStore.setName(tenant, userId, name),
      createInviteToken: (userId) => authTokenStore.create('invite', userId, config.INVITE_TOKEN_TTL_MS),
      // Personnalisation de l'email d'invitation : nom de l'invitant (repli email) + nom de l'espace.
      getInviterName: async (userId) => {
        const u = await userStore.getById(userId);
        return u ? (u.name ?? u.email) : null;
      },
      getWorkspaceName: (tenantId) => userStore.getTenantName(tenantId),
      appUrl: config.APP_URL,
      ...(sendAuthEmail ? { sendEmail: sendAuthEmail } : {}),
    },
    // Configuration de l'agent MBA depuis la console (admin-only). `phoneNumberBelongsToTenant` est le contrôle
    // d'isolation de la PLUPART de ces routes : la surface MBA est indexée par NUMÉRO chez Meta, pas par tenant.
    // ⚠️ `PUT /tenants/:id/mba-activation` fait EXCEPTION, et c'est sa raison d'être : elle résout le numéro
    // elle-même et s'isole par `scopeTenant`. Exiger le numéro de l'appelant est précisément ce qui a fait
    // sauter l'appel à Meta trois fois le 2026-09-10, la dernière parce que le navigateur ne l'avait pas encore.
    /**
     * L'ASSISTANT DU META BUSINESS AGENT (lot B du plan des assistants conversationnels).
     *
     * 🔴 IL PASSE PAR `gatewayAide`, DONC PAR NOTRE CLÉ, comme l'assistant d'agent IA depuis le 2026-09-14 :
     * facturer quelqu'un pour apprendre à se servir du produit se retourne contre nous. Et c'est pourquoi
     * `ASSISTANT_PLAFOND_EUROS_MOIS` l'accompagne : sur le crédit du client, un bavardage se payait tout
     * seul ; sur le nôtre, rien ne le borne.
     *
     * ⚠️ ABSENT SANS CLÉ DE MODÈLE : la route n'est alors pas montée du tout, plutôt que montée et
     * inopérante. Un écran qui appelle une route absente reçoit un 404 lisible ; une route qui répond 503 à
     * chaque tour ressemble à une panne intermittente.
     */
    ...(gatewayAide ? {
      mbaAssistant: {
        inventaire: async (tenant: string) => {
          const phoneNumberId = await repo.getTenantPhoneNumberId(tenant);
          if (!phoneNumberId) return null;
          // ⚠️ L'« agentId » des routes MBA EST le `phone_number_id` : c'est ce que fait déjà `src/http/mba.ts`
          // (`listSkills(phoneNumberId, agentId)` y reçoit le même identifiant). Inventer un second champ
          // créerait une seconde vérité pour la même chose.
          return lireInventaireMba(await metaFactory.mbaClientForTenant(tenant), phoneNumberId, phoneNumberId);
        },
        entretiens: new PgEntretienMbaStore(pool),
        depenses: new PgDepenseStore(pool),
        plafondEuros: config.ASSISTANT_PLAFOND_EUROS_MOIS,
        modele: config.AGENT_SETUP_MODEL || config.LLM_MODEL,
        tauxEurParDollar: config.EUR_PER_USD,
        agentIdDuTenant: (tenant: string) => repo.getTenantPhoneNumberId(tenant),
        pieces: piecesJointesMba,
        completer: (i: Parameters<GatewayChatClient['completer']>[0]) =>
          gatewayAide.completer({ ...i, tenantId: AUCUN_ESPACE_PAYEUR }),
        application: (tenant: string, acteur: { id: string | null; email: string | null }) => ({
          numeroDuTenant: (t: string) => repo.getTenantPhoneNumberId(t),
          client: (t: string) => metaFactory.mbaClientForTenant(t),
          journaliser: (t: string, ligne: LigneHistorique) => historiqueStore.ecrire(t, ligne),
          // ⚠️ `t` et non `tenant` : c'est l'espace que `appliquer` transmet, le seul qui fasse foi ici.
          pieceJointe: async (t: string, jeton: string) => piecesJointesMba.reprendre(t, jeton),
          acteur,
        }),
      },
    } : {}),
    historique: { historique: historiqueStore },
    mba: {
      /**
       * ⚠️ SEULES LES SUPPRESSIONS SONT JOURNALISÉES DEPUIS LES ONGLETS, pas encore les créations ni les
       * modifications. Ce n'est pas un oubli mais un ordre de priorité : chez Meta une suppression est
       * DÉFINITIVE, et cette ligne en est le seul exemplaire ; une création ratée se refait.
       */
      journaliserSuppression: (tenant, l) => historiqueStore.ecrire(tenant, {
        surface: 'mba', surfaceId: null, element: l.element, operation: 'suppression',
        cible: l.cible, libelle: l.libelle, avant: l.avant, apres: null,
        origine: 'formulaire', acteurEmail: null, acteurId: l.acteurId,
      }),
      clientFor: (tenant) => metaFactory.mbaClientForTenant(tenant),
      phoneNumberBelongsToTenant: (pn, tenant) => repo.phoneNumberBelongsToTenant(pn, tenant),
      fetchUrl: fetchUrlBorne(),
      // 🔴 CE QUI REND LA ROUTE D'ACTIVATION POSSIBLE : le numéro se résout ICI, côté serveur. Le faire
      // côté navigateur est ce qui a produit trois pannes le 2026-09-10, la dernière parce que l'état du
      // compte n'était pas encore arrivé au moment du clic.
      numeroDuTenant: (tenant) => repo.getTenantPhoneNumberId(tenant),
      ecrireDrapeauMba: (tenant, enabled) => settingsStore.setMbaEnabled(tenant, enabled),
      messagesTenus: (tenant, jours) => statsStore.messagesTenusParMba(tenant, jours),
    },
    // Agents IA, en lecture : la palette du builder a besoin de la liste pour proposer le bloc.
    agents: {
      listActifs: (tenant) => agentStore.listActifs(tenant),
      listToutes: (tenant) => agentStore.listToutes(tenant),
      complet: (tenant, id) => agentStore.complet(tenant, id),
      create: (tenant, label, mention, modele) => agentStore.create(tenant, label, mention, modele),
      patch: (tenant, id, p) => agentStore.patch(tenant, id, p),
      remove: (tenant, id) => agentStore.remove(tenant, id),
      // Le modèle d'un agent NEUF vient de la configuration serveur, pas du client : il choisira ensuite
      // dans l'écran de réglage. Vide en l'absence de configuration, la colonne l'accepte.
      //
      // 🔴 `AGENT_MODEL` D'ABORD, et `LLM_MODEL` seulement en repli. Le second est le modèle de l'ANALYSE de
      // conversation, servi en DIRECT par Anthropic ; l'agent, lui, passe par le Gateway, dont les
      // identifiants sont préfixés par leur fournisseur. Créer un agent avec l'identifiant de l'analyse lui
      // donne un modèle que le Gateway ne connaît pas, et chaque tour échoue sans que la création n'ait rien
      // signalé.
      modeleParDefaut: config.AGENT_MODEL || config.LLM_MODEL,
      // LECTURE seule : le client voit ce qui lui reste, il ne se recharge pas lui-meme (cf. /ops).
      soldeAgent: (tenant) => credits.solde(tenant),
      // Absente quand le provisionnement est eteint : la creation d'agent se comporte alors comme avant.
      ...(provisionCle ? { assurerCleModele: (tenant: string) => assurerCleGateway(provisionCle, tenant) } : {}),
      consommationAgent: (tenant, agentId, jours) => agentSessions.consommation!(tenant, agentId, jours),
      messagesAgent: (tenant, agentId, jours) => agentSessions.messagesTenus!(tenant, agentId, jours),
      // Le blocage dur avant activation : il lit la fiche, la connaissance, et les outils actifs AVEC leurs
      // handlers (le COMPTE seul ne peut pas dire QUEL outil manque, et c'est l'absence d'un outil PRECIS,
      // celui qui lit la base, qui a rendu un agent muet en production le 2026-09-08),
      // parce qu un agent active est proposable dans un scenario, donc il finira par ecrire a de vrais clients.
      etatPourLint: async (tenant, agentId) => {
        const fiche = await agentStore.complet(tenant, agentId);
        if (!fiche) return null;
        // ⚠️ LE TROISIEME EST UN AVERTISSEMENT, PAS UN MANQUE : un serveur tiers qui change son schema
        // eteint le consentement d un outil (c est la bonne decision, cf. 0127), mais il ne doit pas
        // pouvoir EMPECHER le client d activer son agent. Sans cette lecture, la perte etait muette.
        const [fiches, outils, debranches] = await Promise.all([
          knowledgeStore.lister(tenant, agentId),
          toolCatalog.listActifs(tenant, agentId),
          mcpStore.debranchesParRafraichissement(tenant, consommateurAgent(agentId)),
        ]);
        return {
          fiche: fiche.contenu,
          fichesConnaissance: fiches.length,
          outilsActifs: outils.length,
          handlersActifs: outils.map(handlerMaison).filter((h) => h !== ''),
          outilsMcpDebranches: debranches,
        };
      },
      /**
       * LES MODÈLES PROPOSABLES ET LEUR TARIF (2026-09-09).
       *
       * Deux sources, et une seule sort d'ici : la LISTE est la nôtre (`MODELES_CHOISIS`, choisie pour la
       * gestion des outils et pour le français), les PRIX viennent du Gateway en direct. Figer les prix dans
       * le code aurait garanti qu'ils soient faux au premier changement de tarif chez un fournisseur.
       *
       * ⚠️ La clé du Gateway ne quitte JAMAIS le serveur : la console reçoit des identifiants et des euros.
       */
      modelesProposes: () => catalogueModelesCache.lire('catalogue', () => lireCatalogueGateway(fetchGet, config.AI_GATEWAY_API_KEY))
        .then((catalogue) => modelesProposables(catalogue, config.EUR_PER_USD, config.COMMISSION_MODELE_PCT)),
    },
    // L assistant de construction. Il ne peut ecrire NI la mention legale d IA, NI les plafonds, NI le
    // modele, NI le risque ou l activation d un outil : il rend une proposition, le client l applique.
    /**
     * LE BOT D AIDE DE LA CONSOLE. Il explique et il emmene, il n ecrit jamais rien.
     *
     * ⚠️ `gatewayAide` ET NON `gateway` : le premier est construit sans resolveur de cle par espace, donc il
     * paie sur la NOTRE. Les intervertir ferait facturer l aide au credit du client, en silence, et c est
     * `tests/aide-cablage.test.ts` qui garde ce point.
     */
    aide: {
      /**
       * LE RECAP DE LA VEILLE. Il est branche MEME SANS MODELE, et ce n est pas une tolerance : tout ce qui
       * est chiffre sort du SQL, et le gabarit le dit deja en trois phrases. Le modele n ajoute que le
       * REMARQUABLE, les jours ou il y en a un.
       */
      recap: {
        calculer: creerRecapRedige({
          recap: creerRecap(pool),
          rediger: gatewayAide && config.AGENT_AIDE_MODEL
            ? creerRedacteurRecap({
              // Meme clef que la question, et pour la meme raison : c est NOUS qui payons.
              completer: (i) => gatewayAide.completer({ ...i, tenantId: AUCUN_ESPACE_PAYEUR }),
              modele: config.AGENT_AIDE_MODEL,
            })
            : async (r, langue) => ({ texte: gabarit(r, langue), redigeParModele: false }),
        }),
      },
      ...(gatewayAide && config.AGENT_AIDE_MODEL ? {
        repondre: creerRepondeur({
          depot: new PgDepotAide(pool),
          recherche: creerRechercheSemantique(),
          // AUCUN espace ne paie cet appel : c est nous. `gatewayAide` n a pas de resolveur de cle par
          // espace, donc cette valeur n est jamais lue pour en choisir une ; la nommer evite qu on la
          // prenne pour un oubli et qu on y mette le tenant, ce qui facturerait le client.
          completer: (i) => gatewayAide.completer({ ...i, tenantId: AUCUN_ESPACE_PAYEUR }),
          modele: config.AGENT_AIDE_MODEL,
        }),
      } : {}),
    },
    agentSetup: {
      etatCourant: async (tenant, agentId) => {
        const fiche = await agentStore.complet(tenant, agentId);
        if (!fiche) return null;
        const [outils, fiches, sources, catalogue] = await Promise.all([
          toolCatalog.listToutes(tenant, agentId),
          knowledgeStore.lister(tenant, agentId),
          // La BIBLIOTHEQUE de l espace : ce qui est declare, branche sur cet agent ou non. Sert a repondre
          // honnetement << vous avez declare votre ERP, il reste a y brancher l appel >> au lieu de
          // << rien n existe >> a un client qui vient justement de le declarer.
          agentSources.lister(tenant),
          // 🔴 LA BIBLIOTHEQUE de l ESPACE, pas les outils de cet agent : c est elle qui borne ce que l
          // assistant peut BRANCHER. La definition appartient a l espace depuis 0127, le consentement au
          // couple (outil, consommateur) ; l assistant n agit que sur le second, et ne cree jamais rien.
          toolCatalog.listCatalogue(tenant),
        ]);
        return {
          label: fiche.label,
          // Le régime d'annonce d'IA : l'entretien pose la question, le diff doit donc pouvoir dire ce qui
          // change. ⚠️ IL VIENT DE L'ESPACE depuis 0140, plus de la fiche : la question posée à la
          // construction règle la politique de la marque, pas celle de ce robot-là.
          mentionIaFrequence: (await settingsStore.get(tenant)).mentionIaFrequence ?? 'session',
          // Idem pour le délai d'inactivité, depuis que l'entretien demande quand l'agent lâche un contact muet.
          inactiviteMinutes: fiche.inactiviteMinutes,
          fiche: fiche.contenu,
          // Les outils MAISON, par leur handler : c est par lui que l assistant les designe.
          outils: outils.filter((o) => o.origin === 'mba')
            .map((o) => ({ handler: String(o.binding.handler ?? ''), description: o.description, nePasUtiliser: o.nePasUtiliser })),
          // Les CONNECTEURS deja declares, par leur nom expose. L assistant peut en reecrire les MOTS, jamais
          // en creer : declarer une source, c est ecrire une adresse reseau et un secret.
          // ⚠️ L ORIGINE PART AVEC, sinon les deux familles se confondent dans l inventaire de
          // l assistant : un outil MCP y etait annonce comme un connecteur API.
          connecteurs: outils.filter((o) => o.origin !== 'mba')
            .map((o) => ({
              nom: o.name, titre: o.title, description: o.description, nePasUtiliser: o.nePasUtiliser,
              origine: o.origin === 'mcp' ? 'mcp' as const : 'http' as const,
              sourceId: o.sourceId,
            })),
          titresConnaissance: fiches.map((f) => f.titre),
          // ⚠️ `id` PART AVEC : c'est lui qui apparie un outil a son serveur, pas le prefixe de son nom,
          // que le client peut reecrire.
          sources: sources.map((s) => ({ id: s.id, label: s.label, kind: s.kind, status: s.status })),
          // ⚠️ `branche` se lit sur les CONSOMMATEURS de la definition, pas sur `outils` ci-dessus : les deux
          // repondent a la meme question, mais seul le catalogue connait les outils NON branches, qui sont
          // justement ceux que l assistant peut proposer de brancher.
          catalogue: catalogue.map((c) => ({
            nom: c.name,
            titre: c.title,
            branche: c.consommateurs.some((x) => x.agentId === agentId),
          })),
        };
      },
      /**
       * Les adresses des membres, par identifiant, pour afficher QUI a ecrit chaque tour du fil.
       *
       * ⚠️ UNE SEULE REQUETE, et seulement si le fil porte au moins un auteur : `list` rend les membres de
       * l espace, ce qui suffit puisqu un tour ne peut avoir ete ecrit que par l un d eux.
       */
      emailsDesMembres: async (tenant: string) =>
        Object.fromEntries((await userStore.list(tenant)).map((u) => [u.id, u.email])),
      // Les PIECES JOINTES ecrivent des fiches de connaissance, par le MEME store que l onglet Connaissance :
      // ce que le client joint est ensuite relisible et modifiable la-bas, comme une page importee.
      ecrireFichesDocument: (tenant, agentId, nom, fiches) =>
        knowledgeStore.remplacerSource(tenant, agentId, { type: 'document', nom }, fiches),
      // L entretien est TENU PAR LE SERVEUR : c est lui qui rend la conversation persistante entre deux
      // visites de l onglet, et surtout qui rend la sequence des questions deterministe (la couverture
      // cesse d etre une declaration du modele pour devenir un fait).
      entretiens: new PgEntretienStore(pool),
      /**
       * 🔴 `gatewayAide`, ET PLUS `gateway` (tranché par Julien le 2026-09-14). Cet assistant tournait sur le
       * CRÉDIT PRÉPAYÉ DU CLIENT : configurer son propre robot lui était facturé. Il passe sur notre clé
       * maison, comme le bot d'aide de la console, et pour la raison déjà écrite dans ce dépôt : facturer
       * quelqu'un pour apprendre à se servir du produit se retourne contre nous.
       *
       * ⚠️ `AUCUN_ESPACE_PAYEUR` n'est pas décoratif : `gatewayAide` est construit SANS résolveur de clé par
       * espace, donc cette valeur n'est jamais lue pour en choisir une. La nommer évite qu'on la prenne pour
       * un oubli et qu'on y remette le tenant, ce qui refacturerait le client sans que rien ne le signale.
       *
       * 🔴 ET C'EST CE QUI REND LE PLAFOND OBLIGATOIRE : sur le crédit du client, un bavardage se payait tout
       * seul ; sur le nôtre, rien ne le borne. Les deux moitiés de cette décision vont ensemble
       * (`ASSISTANT_PLAFOND_EUROS_MOIS`), l'une sans l'autre est dangereuse.
       */
      ...(gatewayAide ? {
        completer: (i: Parameters<GatewayChatClient['completer']>[0]) =>
          gatewayAide.completer({ ...i, tenantId: AUCUN_ESPACE_PAYEUR }),
      } : {}),
      modele: config.AGENT_SETUP_MODEL || config.LLM_MODEL,
      /**
       * 🔴 LE MEME COMPTEUR QUE L ASSISTANT DU MBA, ET LE MEME PLAFOND. Le commentaire ci-dessus annonce que
       * « les deux moities de cette decision vont ensemble, l une sans l autre est dangereuse » : la moitie
       * qui manquait etait celle-ci. Le compteur est PAR ESPACE (migration 0146), donc les deux assistants
       * d un meme client se partagent la meme enveloppe mensuelle, ce qui est le sens de la decision.
       */
      depenses: new PgDepenseStore(pool),
      plafondEuros: config.ASSISTANT_PLAFOND_EUROS_MOIS,
      tauxEurParDollar: config.EUR_PER_USD,
      // Le modele de VISION est distinct : mesure du 2026-08-31, `zai/glm-4.7` (le modele d entretien de la
      // production) refuse une part image en 400. Vide -> les images sont refusees explicitement, les
      // documents continuent de passer.
      modeleVision: config.AGENT_VISION_MODEL,
    },
    // Le BAC A SABLE : parler a son agent depuis la console avant de l activer. Il fait tourner le VRAI
    // cerveau (vrai prompt, vrais outils exposes, VRAIE recherche de connaissance), mais les outils a EFFET
    // sont simules : il n y a ni contact, ni conversation, ni parcours, et poser un tag ecrirait sur une
    // vraie fiche du mini-CRM.
    agentTest: {
      // L HISTORIQUE des essais (14 j). Il ne conditionne rien : sans lui l essai marche comme avant et
      // l ecran n affiche aucune trace.
      essais: new PgTestRunStore(pool),
      // Le modele du bac a sable est celui de la FICHE de l agent, pas une variable d env : le seul
      // prerequis est donc la cle du Gateway. Le lier a LLM_MODEL rendrait /test indisponible le jour ou
      // l analyse de conversation serait desactivee, sans aucun rapport.
      disponible: gateway !== null,
      // 🔴 UN ESSAI CONSOMME POUR DE VRAI : les outils a effet sont simules, l appel de modele ne l est pas.
      // Meme solde, meme garde qu en production, sinon la console offrirait une porte gratuite et illimitee
      // sur un compte prepaye. Le mouvement n a pas de session (un essai n en ouvre aucune) : c est la note
      // qui l explique dans le journal.
      solde: (tenant) => credits.solde(tenant),
      debiter: async (tenant, montant, note) => { await credits.debiter(tenant, montant, { note }); },
      ...(gateway ? {
        cerveau: {
          completer: (i) => gateway.completer(i),
          // Point de lecture PARTAGE avec le tour de production : c est ce qui garantit que le bac a sable
          // montre exactement ce que la production ferait, modele et politiques compris.
          contexte: async (tenant, agentId) => {
          /**
           * ⚠️ UNE SEULE LECTURE DES RÉGLAGES POUR LES DEUX POLITIQUES D'ESPACE. Cette fonction est sur le
           * chemin de CHAQUE tour d'agent : deux `get` y feraient deux allers-retours pour la même ligne,
           * et la seconde politique est arrivée le 2026-09-18 à côté de la première.
           */
          const reglages = await settingsStore.get(tenant);
          return lireContexteAgent({
            agents: agentStore,
            outils: toolCatalog,
            politiqueMentionIa: async () => reglages.mentionIaFrequence,
            // L'heure est prise ICI, au moment du tour : une disponibilité calculée plus tôt serait fausse
            // sur une conversation qui traverse l'heure de fermeture.
            disponibiliteEquipe: async () => equipePourPrompt(
              reglages.agentTransfertMode ?? MODE_TRANSFERT_DEFAUT,
              new Date(),
              reglages.timezone,
              reglages.businessHours,
            ),
          }, tenant, agentId);
        },
          // Meme taux qu en production : un essai doit annoncer ce que la conversation couterait vraiment.
          tauxEurParDollar: config.EUR_PER_USD,
          outils: {
            catalogue: toolCatalog,
            // Muet : `agent_tool_calls.session_id` reference une session, et le bac a sable n en ouvre aucune.
            journal: JOURNAL_MUET,
            // Le bac a sable recoit la MEME recherche que la production : il n'a de valeur que s'il rend
            // exactement ce qu'elle rendrait.
            // 🔴 LES TROIS ORIGINES, PAS SEULEMENT `mba` (défaut trouvé par la revue du 2026-09-16). Un
            // outil de connecteur produisait ici `erreur_protocole` avec `fatal: true`, donc un essai qui
            // s'arrête net, alors que la simulation savait parfaitement le rendre : la branche
            // `origin !== 'mba'` était inatteignable par le câblage. Le type impose désormais la liste
            // complète, et une quatrième origine ne compilerait plus sans être traitée.
            resolveurs: resolveursSimulation({ connaissance: knowledgeStore, ...(rechercheSemantique ? { recherche: rechercheSemantique } : {}) }),
            // Rien a compter : sans session, il n y a pas de compteur a incrementer. Le plafond d appels du
            // tour est tenu en memoire par la boucle du cerveau.
            compterAppel: async () => {},
            /**
             * 🔴 LE BAC À SABLE N'EXÉCUTE AUCUN GESTE, ET C'EST LA MÊME DOCTRINE QUE `connecteurSimule`.
             * Un essai depuis la console ne doit pas taper sur les données réelles d'un client : poser un
             * vrai tag sur un vrai contact, ou écrire dans sa fiche, ferait un dégât réel pendant qu'on
             * croit essayer.
             *
             * ⚠️ ET CE SILENCE EST UNE DETTE ASSUMÉE, PAS UN OUBLI, MAIS ELLE N'EST TOUJOURS PAS PAYÉE.
             * Le bac à sable promet « exactement ce que l'agent fera », et il ne montre pas les gestes
             * qu'un moment déclencherait : c'est le mensonge par omission que la migration 0150 a corrigé
             * ailleurs. ⚠️ Ce commentaire a annoncé que la passe 3 s'en chargerait ; la passe 3 est livrée
             * et elle ne l'a pas fait. Une échéance qu'on laisse passer dans un commentaire finit par
             * dire que c'est fait : le reste à faire est suivi dans
             * `docs/superpowers/plans/2026-09-18-moments-agent-ia.md`, section « État d'exécution ».
             */
            executerGeste: async () => {},
          },
          alerter: (m: string) => console.error(`[agent] ${m}`),
        },
      } : {}),
    },
    // Base de connaissance d'un agent : la seule source que l'agent a le droit d'utiliser. `fetchUrl` porte
    // la garde SSRF (le serveur vit dans le reseau Docker du VPS) et le plafond de taille.
    agentKnowledge: {
      lister: (tenant, agentId) => knowledgeStore.lister(tenant, agentId),
      creer: (tenant, agentId, fiche) => knowledgeStore.creer(tenant, agentId, fiche),
      modifier: (tenant, agentId, ficheId, patch) => knowledgeStore.modifier(tenant, agentId, ficheId, patch),
      supprimer: (tenant, agentId, ficheId) => knowledgeStore.supprimer(tenant, agentId, ficheId),
      remplacerSource: (tenant, agentId, source, fiches) => knowledgeStore.remplacerSource(tenant, agentId, source, fiches),
      /**
       * 🔴 IL N Y A PAS DE CORBEILLE ICI NON PLUS. Une fiche supprimee disparait de `agent_knowledge` : cette
       * ligne est le seul exemplaire de ce que le robot savait dire, et le seul endroit qui reponde a « qui
       * l a retire ? ». Meme choix que pour le MBA : les SUPPRESSIONS d abord, une creation ratee se refait.
       */
      journaliserSuppression: (tenant, agentId, l) => historiqueStore.ecrire(tenant, {
        surface: 'agent', surfaceId: agentId, element: 'connaissance', operation: 'suppression',
        cible: l.cible, libelle: l.libelle, avant: l.avant, apres: null,
        origine: 'formulaire', acteurEmail: null, acteurId: l.acteurId,
      }),
      fetchUrl: fetchUrlBorne(),
    },
    // Outils d'un agent. L'activation et l'autonomie portent le nom de qui les a posees : la migration 0086
    // l'exige en base, et c'est ce qui rend un incident instruisable.
    agentTools: {
      listToutes: (tenant, agentId) => toolCatalog.listToutes(tenant, agentId),
      ajouter: (tenant, agentId, outil) => toolCatalog.ajouter(tenant, agentId, outil),
      // Lot L2 : un outil de connecteur, sur une source du tenant. La source est verifiee ICI (404) plutot
      // que par la cle etrangere, qui leverait en 500.
      ajouterConnecteur: (tenant, agentId, outil) => toolCatalog.ajouterConnecteur(tenant, agentId, outil),
      // La REQUETE est LUE, pas crue sur parole : le risque plancher et le resume de ce qui sera envoye en
      // derivent, et ils doivent decrire l appel REEL.
      requetePourOutil: (tenant, requeteId) => agentRequetes.parId(tenant, requeteId),
      patch: (tenant, agentId, id, p) => toolCatalog.patch(tenant, agentId, id, p),
      activer: (tenant, agentId, id, actif, par) => toolCatalog.activer(tenant, agentId, id, actif, par),
      autonomie: (tenant, agentId, id, autonome, par) => toolCatalog.autonomie(tenant, agentId, id, autonome, par),
      // DÉTACHE de cet agent, ne supprime plus la définition : elle appartient à l'espace (migration 0127).
      detacher: (tenant, agentId, id) => toolCatalog.detacher(tenant, agentId, id),
      rattacher: (tenant, agentId, id) => toolCatalog.rattacher(tenant, agentId, id),
      // Les regles d'arret viennent de la FICHE : c'est d'elles que derive l'enumeration de « terminer ».
      sortiesDeLAgent: async (tenant, agentId) => {
        const fiche = await agentStore.complet(tenant, agentId);
        return fiche ? fiche.contenu.sorties : null;
      },
    },
    // La BIBLIOTHEQUE d outils de l ESPACE (migration 0127) : les definitions, et qui s en sert. Separee des
    // routes d agent parce qu elle ne parle pas du meme objet, et isolee par `scopeTenant` et non par un
    // agent dans l URL : une definition appartient a l espace.
    // La bibliothèque ne porte plus que la lecture : les routes de l'agent de Meta sont dans `mbaOutils`.
    agentCatalogue: {
      listCatalogue: (tenant) => toolCatalog.listCatalogue(tenant),
    },
    /**
     * L'ONGLET « OUTILS » DE L'AGENT DE META (spec 2026-09-21-outils-maison-mba, § 9).
     *
     * ⚠️ Le numéro est résolu ICI, côté serveur : le faire porter au navigateur est ce qui a cassé le toggle MBA
     * trois fois le 2026-09-10. Et la REQUÊTE d'un connecteur est LUE, pas crue sur parole : le risque et la
     * source en dérivent.
     */
    mbaOutils: {
      numeroDuTenant: (tenant) => repo.getTenantPhoneNumberId(tenant),
      lister: (tenant, pn) => toolCatalog.listToutesConsommateur(tenant, consommateurMba(pn)),
      contexte: async (tenant, outils) => {
        // Les scénarios ne se lisent que si une ligne en désigne un : la liste porte les graphes complets.
        const veutScenarios = outils.some((o) => {
          const h = (o.binding as { handler?: unknown } | null)?.handler;
          return h === 'bloc_fixe' || h === 'scenario_fixe';
        });
        const [requetes, champs, bibliotheque, workflows] = await Promise.all([
          agentRequetes.lister(tenant), fieldStore.list(tenant), toolCatalog.listCatalogue(tenant),
          veutScenarios ? workflowStore.list(tenant) : Promise.resolve([]),
        ]);
        return {
          requetes: new Map(requetes.map((r) => [r.id, { label: r.label }])),
          champs: new Set(champs.map((f) => f.key)),
          bibliotheque: new Map(bibliotheque.map((o) => [o.id, o])),
          workflows: new Map(workflows.map((w) => [w.id, { name: w.name, graph: w.graph }])),
        };
      },
      // Le graphe PUBLIÉ, celui que le relais joue : jamais le brouillon.
      workflow: async (tenant, id) => {
        const w = await workflowStore.getById(id, tenant);
        return w ? { name: w.name, graph: w.graph } : null;
      },
      blocs: async (tenant, id) => {
        const w = await workflowStore.getById(id, tenant);
        return w ? blocsProposables([{ id: w.id, name: w.name, graph: w.graph }]) : [];
      },
      requete: (tenant, id) => agentRequetes.parId(tenant, id),
      champs: async (tenant) => (await fieldStore.list(tenant)).map((f) => f.key),
      creerMaison: (tenant, pn, outil, par) => toolCatalog.ajouterMaisonPourMba(tenant, pn, outil, par),
      // Deux gestes, comme l'ancienne route : créer, puis activer pour l'agent de Meta au nom de l'administrateur.
      creerConnecteur: async (tenant, pn, outil, par) => {
        const cree = await toolCatalog.ajouterConnecteurPourMba(tenant, pn, outil);
        if (!cree) return null;
        await toolCatalog.activerConsommateur(tenant, consommateurMba(pn), cree.id, true, par);
        return { id: cree.id };
      },
      modifierMaison: (tenant, pn, id, patch) => toolCatalog.patchMaisonPourMba(tenant, pn, id, patch),
      // ⚠️ `consommateurMba(pn)` ET PAS UN AGENT : c'est elle qui borne la correction à un outil de CE consommateur.
      modifierConnecteur: (tenant, pn, id, patch) => toolCatalog.patchConsommateur(tenant, consommateurMba(pn), id, patch),
      retirer: (tenant, pn, id) => toolCatalog.retirerDeMba(tenant, pn, id),
      reactiver: async (tenant, pn, id, par) =>
        (await toolCatalog.activerConsommateur(tenant, consommateurMba(pn), id, true, par)) !== null,
    },
    /**
     * Publication du catalogue chez Meta (lot 4), traduite en RELAIS le 2026-09-21 (migration 0161).
     *
     * 🔴 LE PLAN EST RECALCULE AU MOMENT D APPLIQUER, jamais transmis par le navigateur : le lui faire
     * porter ouvrirait une fenetre ou Meta a change entre l apercu et le clic.
     *
     * 🔴 CE QUI PART CHEZ META EST LE RELAIS : un connecteur `EngageMe` par espace, son adresse est notre API
     * et sa cle une cle d API de l espace (`src/mba/cle-relais.ts`). Le secret du client ne quitte plus notre
     * serveur, et les valeurs du mini-CRM sont remplies par le relais (`src/http/mba-relais.ts`).
     */
    mbaPublication: {
      numeroDuTenant: (tenant) => repo.getTenantPhoneNumberId(tenant),
      relais: async (tenant) => {
        const base = adresseDuRelais();
        if (base === null) return null;
        return { baseUrl: base, cleAJour: await cleAJour(depsCleRelaisPour(null), tenant) };
      },
      outilsExposes: (tenant, pn) => outilsPourMeta(tenant, pn),
      etatMeta: async (tenant, pn) => {
        const client = await metaFactory.mbaClientForTenant(tenant);
        const connecteurs = await client.listConnectors(pn);
        /**
         * 🔴 LE TYPE VIENT DU CLIENT, il n est pas RECOPIE ici : le plan COMPARE `request_definition`, et une
         * annotation ecrite a la main l a deja omise une fois.
         */
        const outilsParConnecteur: Record<string, Awaited<ReturnType<typeof client.listConnectorTools>>> = {};
        for (const c of connecteurs) outilsParConnecteur[c.id] = await client.listConnectorTools(pn, c.id);
        return { connecteurs, outilsParConnecteur };
      },
      /** Sorti en module pour être testé contre des faux (`src/mba/appliquer-publication.ts`). */
      appliquer: creerAppliquerGeste({
        client: (tenant) => metaFactory.mbaClientForTenant(tenant),
        adresseDuRelais,
        outils: outilsPourMeta,
        cle: depsCleRelaisPour,
      }),
    },
    // Les SOURCES externes d outils (lot L2) : l adresse de base du systeme du client, son mode d
    // authentification et son secret. Le secret est chiffre par le store, et aucune route ne le rend.
    /**
     * Les CONNECTEURS MCP. Tout passe par `PgMcpStore` sauf la source elle-meme, qui reste servie par
     * `agentSources` : c'est la MEME table (`agent_tool_sources`, `kind = 'mcp'`), et en ouvrir un second
     * chemin de lecture ferait deux facons de dechiffrer un secret.
     */
    agentMcp: {
      audit: auditSink,
      listerServeurs: (tenant) => mcpStore.listerServeurs(tenant),
      // Le MEME store que les connecteurs API : c est la meme table, et le secret s y chiffre au meme
      // endroit. En ouvrir un second chemin ferait deux facons de chiffrer.
      creerServeur: (tenant, input) => agentSources.creer(tenant, { kind: 'mcp', ...input }),
      // 🔴 PAS `agentSources.supprimer`, qui est un `delete` nu : il rendait `true` en emportant les outils
      // et les consentements par cascade, et `false` seulement sur un identifiant inexistant.
      supprimerServeur: (tenant, id) => mcpStore.supprimerServeur(tenant, id),
      pourAppel: (tenant, id) => agentSources.pourAppel(tenant, id),
      marquerEpreuve: (tenant, id, ok, erreur) => agentSources.marquerEpreuve(tenant, id, ok, erreur),
      outilsPourEcran: (tenant, sourceId) => mcpStore.outilsPourEcran(tenant, sourceId),
      outilsDuServeur: (tenant, sourceId) => mcpStore.outilsDuServeur(tenant, sourceId),
      nomsPris: (tenant) => mcpStore.nomsPris(tenant),
      appliquer: (tenant, sourceId, e) => mcpStore.appliquer(tenant, sourceId, e),
      // La MEME lecture que pour les variables de requete : deux definitions de « ce champ existe »
      // finiraient par accepter ici ce que l'autre refuse.
      clesDeChamps: async (tenant) => (await fieldStore.list(tenant)).map((f) => f.key),
      reglerOutil: (tenant, outilId, patch) => mcpStore.reglerOutil(tenant, outilId, patch),
    },
    agentSources: {
      audit: auditSink,
      lister: (tenant) => agentSources.lister(tenant),
      parId: (tenant, id) => agentSources.parId(tenant, id),
      creer: (tenant, input) => agentSources.creer(tenant, input),
      patch: (tenant, id, p) => agentSources.patch(tenant, id, p),
      supprimer: (tenant, id) => agentSources.supprimer(tenant, id),
      // EPROUVER une source : un appel reel, le resultat ecrit sur la ligne. Toutes ses gardes (nature de la
      // source, adresse verifiee avant l appel ET a la connexion, redirection refusee) vivent dans le module,
      // teste a part : `src/agent/eprouver-source.ts`.
      eprouver: creerEprouverSource({
        pourAppel: (tenant, id) => agentSources.pourAppel(tenant, id),
        marquerEpreuve: (tenant, id, ok, erreur) => agentSources.marquerEpreuve(tenant, id, ok, erreur),
      }),
    },
    // Les REQUETES de connecteur (migration 0105) : un appel mis au point une fois dans la bibliotheque, que
    // l outil d un agent DESIGNE au lieu de le redecrire.
    agentRequetes: {
      lister: (tenant) => agentRequetes.lister(tenant),
      parId: (tenant, id) => agentRequetes.parId(tenant, id),
      creer: (tenant, input) => agentRequetes.creer(tenant, input),
      patch: (tenant, id, p) => agentRequetes.patch(tenant, id, p),
      supprimer: (tenant, id) => agentRequetes.supprimer(tenant, id),
      /**
       * Ce qu il faut pour EPROUVER une requete : l adresse de base et les en-tetes d authentification.
       *
       * ⚠️ `enTetesAuthSource` est le MEME point de passage que l appel reel. Un test qui authentifierait
       * autrement dirait « ca repond » d une source que les appels ne savent pas authentifier, ce qui est
       * exactement la divergence que l audit du 2026-08-18 a payee une centaine de fois.
       */
      sourcePourTest: async (tenant, sourceId) => {
        const src = await agentSources.pourAppel(tenant, sourceId);
        /**
         * 🔴 `kind === 'http'`, ET C EST LE CINQUIEME CHEMIN DU MEME TROU. La route de test
         * (`POST /tenants/:t/agent-requetes/test`) prend `sourceId` DIRECTEMENT dans le corps : sans ce
         * filtre, un administrateur y passait l identifiant d un SERVEUR MCP (que `GET /tenants/:t/mcp`
         * lui donne) et faisait partir une requete HTTP de sa composition, methode et chemin compris, sur
         * le point MCP du client, AVEC SON SECRET DECHIFFRE dans l en-tete, puis recevait 20 ko de
         * reponse. C est mot pour mot ce que la garde posee sur les routes MCP et sur celles des
         * connecteurs API pretendait fermer.
         *
         * ⚠️ LE REPLI SUR `null` REND DEJA UN 400 LISIBLE (« la source de cet appel n existe plus »), donc
         * il n y a pas de branche a ajouter chez l appelant.
         */
        return src && src.kind === 'http'
          ? { baseUrl: src.baseUrl, entetes: enTetesAuthSource(src), status: src.status }
          : null;
      },
      // Les cles des champs DECLARES : une variable `champ` doit en designer une, sinon la faute de frappe ne
      // se verrait qu a l appel, en pleine conversation.
      clesDeChamps: async (tenant) => (await fieldStore.list(tenant)).map((f) => f.key),
      // Le SECOND usage d une requete, celui que le compteur `outils` ne voit pas : la poussee d opt-out.
      brancheeSurConsentement: async (tenant, requestId) => (await settingsStore.get(tenant)).optoutRequestId === requestId,
    },
    flows: {
      flowsFor: (tenant) => metaFactory.flowClientForTenant(tenant), // token PAR TENANT (B1), repli global en sommeil
      getWabaId: (tenant) => repo.getTenantWabaId(tenant),
      insertFlow: (tenantId, id, name, screens, ref, mapping, cta) => flowStore.insert({ id, tenantId, name, screens, ref, mapping, ...(cta ? { cta } : {}) }),
      listFlows: (tenant) => flowStore.list(tenant),
      belongsTo: (flowId, tenant) => flowStore.belongsTo(flowId, tenant),
      markPublished: (flowId, tenant) => flowStore.markPublished(flowId, tenant),
      ensureUserField: async (tenant, label, type) => { await ensureField(fieldStore, tenant, label, type); },
      listUserFields: (tenant) => fieldStore.list(tenant),
      ensureOptinField: async (tenant) => { await ensureFieldByKey(fieldStore, tenant, WHATSAPP_OPTIN_FIELD_KEY, WHATSAPP_OPTIN_FIELD_LABEL, 'boolean'); },
      getFlow: (flowId, tenant) => flowStore.getById(flowId, tenant),
      updateFlowRow: (tenant, id, name, screens, ref, mapping, cta) => flowStore.update(id, tenant, { name, screens, ref, mapping, ...(cta ? { cta } : {}) }),
      removeFlowRow: (flowId, tenant) => flowStore.remove(flowId, tenant),
      insertExternalFlow: (tenant, f) => flowStore.insertExternal({ ...f, tenantId: tenant }),
      alignFlowFromMeta: (flowId, tenant, patch) => flowStore.alignFromMeta(flowId, tenant, patch),
    },
    media: { uploadImage: (bytes, mime) => mediaClient.uploadImage(bytes, mime) },
    tags: {
      listTags: (tenant) => tagStore.listDistinct(tenant),
      createTag: (tenant, name) => tagStore.create(tenant, name),
      renameTag: (tenant, from, to) => tagStore.rename(tenant, from, to),
      removeTag: (tenant, tag) => tagStore.remove(tenant, tag),
    },
    fields: {
      listFields: (tenant) => fieldStore.list(tenant),
      tenantCode: (tenant) => resolveTenantCode(pool, tenant),
      createField: (tenant, def) => fieldStore.create(tenant, def),
      updateField: (tenant, key, patch) => fieldStore.updateField(tenant, key, patch),
      deleteField: (tenant, key) => fieldStore.deleteField(tenant, key),
      fieldUsage: (tenant) => contactStore.fieldUsage(tenant),
    },
    contacts: {
      applyEdits: (tenant, id, edits) => contactStore.applyEdits(tenant, id, edits),
      applyEditsMany: (tenant, target, edits) => contactStore.applyEditsMany(tenant, target, edits),
      setBlocked: (tenant, id, bloque, par) => contactStore.setBlocked(tenant, id, bloque, par),
      listBlocked: (tenant) => contactStore.listBlocked(tenant),
      listeDesabonnes: (tenant) => contactStore.listeDesabonnes(tenant),
      messagesARelire: (tenant) => contactStore.messagesARelire(tenant),
      purgeMany: (tenant, ids) => contactStore.purgeMany(tenant, ids),
      contactIdsForTarget: (tenant, target) => contactStore.contactIdsForTarget(tenant, target),
      audit: auditSink,
      listAudit: (tenant, o) => auditStore.list(tenant, o),
      // Le journal des ERREURS de livraison. Separe du journal d actions : celui-ci porte les numeros (sans
      // eux il ne repond a rien), celui-la n en porte jamais (y ecrire un numero annulerait une purge).
      listErreursLivraison: (tenant, f) => erreursLivraison.lister(tenant, f),
      // La moitie SYSTEME : les appels vers les systemes du CLIENT qui n ont pas abouti. Ecrite depuis 0086,
      // lue par personne jusqu a la migration 0142.
      listErreursSysteme: (tenant, limit) => erreursLivraison.listerEchecsSysteme(tenant, limit),
      listUserFields: (tenant) => fieldStore.list(tenant),
      // Champ socle absent -> on le crée au premier usage (idempotent). Aucun chemin d'inscription ne les
      // créait, donc un espace neuf refusait « Prénom » alors que l'écran le propose.
      ensureSocleField: async (tenant, key, label, type) => { await ensureFieldByKey(fieldStore, tenant, key, label, type); },
      // Création à la main : MÊME upsert que le webhook entrant, avec le pays par défaut du tenant.
      createOneContact: async (tenant, input) => {
        const [r] = await upsertContactsFromApi(tenant, [input], { contacts: contactStore, fields: fieldStore, defaultCountry: config.DEFAULT_COUNTRY as CountryCode });
        return r ? { status: r.status, ...(r.contactId ? { contactId: r.contactId } : {}), ...(r.reason ? { reason: r.reason } : {}) } : { status: 'error', reason: 'aucun résultat' };
      },
      getContactHistory: (tenant, id) => contactHistoryStore.getContactHistory(tenant, id),
      listSendsForExport: (tenant, id) => contactHistoryStore.listSendsForExport(tenant, id),
      // Le résumé DÉRIVÉ de la dernière conversation analysée : aucune donnée n'est recopiée dans la fiche,
      // donc rien ne survit à la purge des conversations. Voir `ResumeContact` pour le pourquoi complet.
      getResumeContact: (tenant, id) => contactHistoryStore.resumeContact(tenant, id),
      /**
       * Le bilan d'un contact : son coût estimé et son entonnoir d'engagement.
       *
       * 🔴 LES MÊMES TARIFS QUE LES DEUX AUTRES ÉCRANS, par le MÊME `prixFactures`, et c'est ce qui les
       * empêche de se contredire au moment précis où on les met côte à côte : un client qui compare le coût
       * d'un contact au coût de la campagne qui le lui a envoyé doit retrouver la même arithmétique.
       *
       * ⚠️ LES TARIFS SONT CEUX DES 30 DERNIERS JOURS, alors que la fiche couvre toute la vie du contact.
       * Même approximation ASSUMÉE que la fiche de campagne, et pour la même raison : Meta rend un tarif PAR
       * PÉRIODE, et demander la période exacte de chaque envoi multiplierait les appels sans rien changer au
       * chiffre. L'écran annonce un coût ESTIMÉ, pas une facture.
       */
      getBilanContact: async (tenant, id) => {
        const matiere = await contactHistoryStore.bilanContact(tenant, id);
        if (!matiere) return null;
        // ⚠️ MÊME fenêtre que la fiche de campagne, écrite de la même façon : trois écrans qui disent un
        // coût doivent lire le même tarif, sinon ils se contredisent sur la même donnée.
        const rates = await prixFactures(tenant, { from: addDays(todayParis(), -29), to: todayParis() });
        return {
          cout: estimerCoutContact(matiere.envois, rates),
          entonnoir: entonnoirEngagement(matiere.profondeurs),
        };
      },
      // Automations « tag ajouté » (E.2) : l'API ne sait pas démarrer un scénario (c'est le worker qui tient
      // l'exécuteur), elle publie donc un événement par tag posé. Un contact sans identité joignable (ni
      // numéro ni BSUID) n'a rien à déclencher.
      emitTagAdded: async (tenant, contactId, tags) => {
        const waId = await contactStore.waIdOfContact(tenant, contactId);
        if (!waId) return;
        for (const tag of tags) {
          await enfilerEvenementAutomation(queue, { tenantId: tenant, event: { kind: 'tag_added', waId, tag } } satisfies AutomationEventJob);
        }
      },
    },
    embeddedSignup: (() => {
      const esClient = new MetaEmbeddedSignupClient(config.META_APP_ID, config.META_APP_SECRET, config.META_GRAPH_VERSION);
      return {
        audit: auditSink,
        configId: config.META_ES_CONFIG_ID,
        appId: config.META_APP_ID,
        graphVersion: config.META_GRAPH_VERSION,
        exchangeCode: (code: string) => esClient.exchangeCode(code),
        getPhone: (pn: string, tok: string) => esClient.getPhone(pn, tok),
        subscribeApp: (waba: string, tok: string) => esClient.subscribeApp(waba, tok),
        register: (pn: string, tok: string, pin: string) => esClient.register(pn, tok, pin),
        verifyWaba: (waba: string, tok: string) => esClient.verifyWaba(waba, tok),
        // Repêchage quand la popup n'annonce pas les identifiants (parcours déjà abouti chez Meta).
        wabasForToken: (tok: string) => esClient.wabasForToken(tok),
        listPhones: (waba: string, tok: string) => esClient.listPhones(waba, tok),
        link: (input: { tenantId: string; wabaId: string; phoneNumberId: string; displayPhoneNumber: string | null; verifiedName: string | null }) => esCredentialsStore.linkTenant(input),
        // Chiffrement au repos ICI (la route ne voit jamais le stockage) : AES-GCM avec ENCRYPTION_KEY. Token ET pin
        // (PIN 2FA du numéro = secret Meta) chiffrés.
        saveCredentials: (waba: string, tenant: string, token: string, pin: string | null) =>
          esCredentialsStore.saveCredentials(waba, tenant, encryptSecret(token, config.ENCRYPTION_KEY), pin === null ? null : encryptSecret(pin, config.ENCRYPTION_KEY)),

        // ----- « Activer le numéro » (2026-09-22) -----
        // Le JETON NE SORT PAS D'ICI : ces fonctions ne prennent qu'un `tenantId`, la route ne voit jamais un
        // secret. Même règle que le chiffrement de `saveCredentials`, posé ici et pas dans la route.
        numeroDuTenant: async (tenant: string) => (await phoneStatusStore.getPhoneNumber(tenant))?.id ?? null,
        // Relu CHEZ META à chaque geste, jamais dans notre base : notre copie date du dernier pull, et c'est
        // Meta qui décide si un code est encore nécessaire.
        etatNumero: async (tenant: string, phoneNumberId: string) => {
          const client = await metaFactory.phoneClientForTenant(tenant);
          const info = await client.get(phoneNumberId);
          return { status: info.status ?? null, codeVerificationStatus: info.codeVerificationStatus ?? null };
        },
        demanderCode: async (tenant: string, phoneNumberId: string, methode: 'VOICE' | 'SMS') => {
          const client = await metaFactory.phoneRegisterClientForTenant(tenant);
          await client.requestCode(phoneNumberId, { methode });
        },
        verifierCode: async (tenant: string, phoneNumberId: string, code: string) => {
          const client = await metaFactory.phoneRegisterClientForTenant(tenant);
          await client.verifyCode(phoneNumberId, code);
        },
        // ⚠️ LE REGISTER RESTE CELUI DE L'INSCRIPTION, délibérément : `MetaPhoneRegisterClient` dit dans son
        // en-tête pourquoi il ne le porte pas (deux copies du même appel Graph divergeraient au premier
        // changement). D'où le jeton résolu à la main ici, le client d'inscription ne le portant pas.
        // Pas d'interception d'erreur d'auth autour : ce client-là lève des `Error` ordinaires, que
        // `isMetaAuthError` ne reconnaît pas. Poser un `onError` ici ne ferait que rassurer à tort.
        enregistrerNumero: async (tenant: string, phoneNumberId: string, pin: string) => {
          const { token } = await metaCredentials.resolveForTenant(tenant);
          await esClient.register(phoneNumberId, token, pin);
        },
        sauverPin: async (tenant: string, pin: string) => {
          const waba = await wabaDeLEspace(tenant);
          if (waba === null) {
            // Numéro branché à la main, hors Embedded Signup : aucune ligne où conserver le PIN. L'activation
            // a réussi, on le dit plutôt que de laisser croire que le PIN est gardé quelque part.
            // eslint-disable-next-line no-console
            console.warn(`numero/activer: PIN non conservé (espace ${tenant} sans compte WhatsApp rattaché)`);
            return;
          }
          await esCredentialsStore.enregistrerPin(waba, tenant, encryptSecret(pin, config.ENCRYPTION_KEY));
        },
      };
    })(),
    /**
     * LES PUBLICITÉS CLICK-TO-WHATSAPP (lot 2 « Connecter », migration 0167).
     *
     * 🔴 LE JETON EST CHIFFRÉ ET DÉCHIFFRÉ ICI, NULLE PART AILLEURS. La route ne le voit jamais : elle ne
     * reçoit qu'un `tenantId`, exactement comme pour l'inscription WhatsApp. Un jeton qui n'entre pas dans une
     * route ne peut ni fuiter dans un journal, ni partir dans un corps de réponse, ni se lire dans une trace
     * de pile.
     *
     * ⚠️ `META_ADS_CONFIG_ID` VIDE = les routes sont montées mais l'échange répond 503, et l'écran l'annonce
     * avant de proposer quoi que ce soit. La configuration refuse déjà de démarrer si cette variable est
     * posée sans `ENCRYPTION_KEY` : on ne peut donc pas arriver ici avec un jeton à chiffrer et pas de clé.
     */
    pubs: (() => {
      const connexions = connexionsPub;
      const jetonClair = async (tenantId: string): Promise<string> => {
        const chiffre = await connexions.lireJetonChiffre(tenantId);
        // Une erreur NOMMÉE : la route en fait un 409 « pas connecté », là où un `Error` nu ressortait en
        // 502 « Meta ne répond pas » et envoyait le client chercher une panne qui n'existait pas.
        if (chiffre === null) throw new PasDeConnexionPub();
        return decryptSecret(chiffre, config.ENCRYPTION_KEY);
      };
      /**
       * 🔴 UN JETON REFUSÉ SE RETIENT, UNE PANNE NON. C'est la différence entre « reconnectez-vous » et
       * « réessayez » à l'écran, et elle se lit sur le CODE de Meta (`estJetonRefuse`), jamais sur la phrase :
       * un message se reformule et la garde casserait en silence. L'erreur remonte dans les deux cas.
       */
      const noterSiRefus = async <T>(tenantId: string, appel: Promise<T>): Promise<T> => {
        try {
          return await appel;
        } catch (err) {
          if (estJetonRefuse(err)) await connexions.marquerJetonRejete(tenantId);
          throw err;
        }
      };
      return {
        audit: auditSink,
        configId: config.META_ADS_CONFIG_ID,
        appId: config.META_APP_ID,
        graphVersion: config.META_GRAPH_VERSION,
        lire: (t: string) => connexions.lire(t),
        etatCompte: async (t: string) => {
          const etat = await connexions.lire(t);
          const comptePubId = etat?.comptePubId ?? null;
          if (comptePubId === null) return null;
          return etatComptePubCache.lire(`${t}:${comptePubId}`, async () => {
            // Pas de `noterSiRefus` : un refus ici ne doit pas marquer la connexion morte pour un
            // indicateur d'affichage. La route traite déjà l'échec comme « je ne sais pas ».
            return clientPubs.etatCompte(comptePubId, await jetonClair(t));
          });
        },
        connecter: async (t: string, code: string, userId: string | null) => {
          // 🔴 BRETELLES : on refuse AVANT L'ÉCHANGE quand une connexion existe déjà. Meta n'émet alors
          // AUCUN jeton, donc rien ne peut être orphelin sur le chemin ordinaire (un appel hors séquence).
          // ⚠️ Ce n'est PAS un contrôle suffisant à lui seul, et il ne remplace pas la base : entre cette
          // lecture et l'insertion, deux connexions simultanées passeraient toutes les deux. La ceinture
          // reste l'insertion seule de `poserJeton` ; ceci ne fait qu'éviter d'émettre un jeton pour rien.
          if (await connexions.lireJetonChiffre(t) !== null) throw new DejaConnectePub(false);
          const jeton = await clientPubs.exchangeCode(code);
          // 🔴 À PARTIR D'ICI, META A ÉMIS UN JETON SANS EXPIRATION. Il est rangé AVANT qu'on lise les
          // actifs, et son échec porte un nom à LUI : ce n'est pas un refus de Meta, c'est NOTRE panne, et
          // elle laisse derrière elle un accès vivant dont nous n'avons plus la trace.
          let pose = false;
          try {
            pose = await connexions.poserJeton(t, encryptSecret(jeton, config.ENCRYPTION_KEY), userId);
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error(`jeton publicitaire NON enregistré pour l'espace ${t}, il reste vivant chez Meta:`, err instanceof Error ? err.message : err);
            throw new JetonNonEnregistre(err);
          }
          // 🔴 LA BASE A REFUSÉ D'ÉCRASER UNE CONNEXION EXISTANTE : c'est la course, et elle est rare
          // (la vérification ci-dessus attrape tout le reste). Le jeton qu'on vient d'échanger est PERDU
          // pour nous, et le client l'apprend dans la réponse.
          //
          // 🔴 NE PAS LE RÉVOQUER ICI, ET C'EST UN PIÈGE QUI PARAÎT ÉVIDENT. `DELETE /me/permissions/...`
          // porte sur le couple (application, entité), pas sur LE jeton : « me » se résout depuis le
          // porteur, et l'ancien comme le neuf désignent la même entité sous la même application. Révoquer
          // avec le neuf retirerait donc les permissions de l'ANCIEN, c'est-à-dire de la connexion qu'on
          // vient de protéger. ⚠️ Hypothèse forte, PAS mesurée : c'est précisément pour ça qu'on ne tranche
          // pas dessus, et qu'on laisse un orphèlin rare plutôt qu'un risque de casser ce qui marche.
          if (!pose) {
            // eslint-disable-next-line no-console
            console.error(`connexion publicitaire concurrente sur l'espace ${t} : un jeton a été émis par Meta et n'a pas été gardé`);
            throw new DejaConnectePub(true);
          }
          return clientPubs.actifsAccordes(jeton);
        },
        actifsAccordes: async (t: string) => noterSiRefus(t, clientPubs.actifsAccordes(await jetonClair(t))),
        choisir: async (t: string, choix: { comptePubId: string; pageId: string }) => {
          const jeton = await jetonClair(t);
          // ⚠️ LA DEVISE ET LE FUSEAU VIENNENT DE LA LISTE DES ACTIFS, qui les porte déjà : les relire compte
          // par compte était un appel pour rien, et surtout une SECONDE vérité qui pouvait diverger de
          // celle que la route vient d'utiliser pour valider le choix.
          const actifs = await noterSiRefus(t, clientPubs.actifsAccordes(jeton));
          const compte = actifs.comptesPub.find((c) => c.id === choix.comptePubId);
          const page = actifs.pages.find((p) => p.id === choix.pageId);
          // ⚠️ `inconnu` SANS APPELER META, et c'est une mesure, pas un renoncement : aucune API n'expose
          // la liaison Page / numéro (dix champs essayés le 2026-09-23, détail dans `src/meta/pubs.ts`).
          // L'écran dit où la voir chez Meta plutôt que de prétendre la connaître.
          const pageLiee = 'inconnu' as const;
          await connexions.choisirActifs(t, {
            ...choix,
            // Les NOMS sont gardés ici et nulle part ailleurs (0169) : l'écran les relirait sinon chez Meta
            // à chaque ouverture, pour afficher ce qu'on sait déjà.
            compteNom: compte?.nom ?? null,
            pageNom: page?.nom ?? null,
            devise: compte?.devise ?? null,
            fuseau: compte?.fuseau ?? null,
            pageLiee,
          });
          const etat = await connexions.lire(t);
          if (etat === null) throw new Error('connexion publicitaire introuvable après enregistrement');
          return etat;
        },
        deconnecter: async (t: string) => {
          // 🔴 RÉVOQUER D'ABORD, EFFACER ENSUITE. Notre ligne est le seul endroit où ce jeton existe
          // chez nous, et il n'expire JAMAIS : l'effacer sans avoir tenté le retrait laisserait un accès
          // vivant que plus personne, de notre côté, ne pourrait fermer (le piège de la clé Vercel, 0124).
          const chiffre = await connexions.lireJetonChiffre(t);
          let revoqueChezMeta = false;
          if (chiffre !== null) {
            try {
              await clientPubs.revoquerAcces(decryptSecret(chiffre, config.ENCRYPTION_KEY));
              revoqueChezMeta = true;
            } catch (err) {
              // ⚠️ UN ÉCHEC N'EMPÊCHE PAS DE SE DÉCONNECTER, et c'est un arbitrage : bloquer la déconnexion
              // sur une panne de Meta retiendrait un client qui veut partir.
              //
              // 🔴 ET LE BOOLÉEN NE VA PAS À L'ÉCRAN. Cette phrase disait le contraire, et pire : elle
              // prescrivait « retirer l'application », c'est-à-dire le geste qui couperait le numéro
              // WhatsApp du client, puisque c'est la MÊME application. Décision de Julien du 2026-09-23 :
              // le client n'est pas averti, parce que le jeton résiduel n'est détenu par PERSONNE (nous
              // venons de supprimer notre seule copie) et qu'aucun des gestes qu'on pourrait lui
              // prescrire n'est sans danger. Le booléen sert à MESURER si le retrait fonctionne sur un
              // jeton d'utilisateur système, et il va au journal.
              // eslint-disable-next-line no-console
              console.warn('retrait d’accès publicitaire non confirmé par Meta:', err instanceof Error ? err.message : err);
            }
          }
          await connexions.supprimer(t);
          return { revoqueChezMeta };
        },

        listerPubs: (t: string) => publicites.lister(t),

        /**
         * LES BROUILLONS (migration 0171). Cinq passe-plats, et c'est voulu : un brouillon est un
         * formulaire mémorisé, il ne touche JAMAIS Meta, donc il n'y a rien à orchestrer ici.
         *
         * ⚠️ `listerBrouillons` ne transporte PAS les octets des visuels, `lireBrouillon` si. L'écart est
         * porté par le store (deux requêtes distinctes) et pas par ce câblage : le dire ici en plus ferait
         * une seconde vérité, et c'est celle du store qui décide.
         */
        listerBrouillons: (t: string) => brouillonsPub.lister(t),
        lireBrouillon: (t: string, id: string) => brouillonsPub.lire(t, id),
        creerBrouillon: (t: string, c: ChampsBrouillon) => brouillonsPub.creer(t, c),
        majBrouillon: (t: string, id: string, c: ChampsBrouillon) => brouillonsPub.mettreAJour(t, id, c),
        supprimerBrouillon: (t: string, id: string) => brouillonsPub.supprimer(t, id),

        /**
         * CRÉER UNE PUBLICITÉ CHEZ META, EN PAUSE (lot 3, commit 2).
         *
         * 🔴 LA SÉQUENCE N'EST PAS ICI, ET C'EST DÉLIBÉRÉ. Ce câblage ne fait que LIER : il résout la
         * connexion, dérive le jeton de Page, et donne à `creerLaPublicite` deux objets minuscules. La
         * séquence elle-même, avec son rattrapage, vit dans `src/pubs/creation.ts`, où elle s'exécute
         * contre de faux objets, chemins d'échec compris. Un chemin d'échec écrit dans un câblage est un
         * chemin d'échec que personne n'exécute jamais avant le jour où il compte.
         */
        creerPub: async (t: string, d: Omit<DemandeCreation, 'comptePubId' | 'pageId' | 'numeroWhatsApp'>) => {
          const etat = await connexions.lire(t);
          if (etat === null) throw new PasDeConnexionPub();
          if (etat.comptePubId === null || etat.pageId === null) throw new ConnexionPubIncomplete();
          const jeton = await jetonClair(t);
          const comptePubId = etat.comptePubId;
          const pageId = etat.pageId;
          // ⚠️ LE JETON DE PAGE NE SERT QU'À LA CRÉA, et il n'est jamais stocké. Meta documente qu'il faut un
          // jeton de Page pour ce guide ; ce qui n'est PAS mesuré, c'est s'il est exigé partout ou seulement
          // là où l'on agit sur la Page. Repli sur le jeton du client, et le refus de Meta sera lisible.
          const jetonCrea = (await clientCreationPubs.jetonDePage(pageId, jeton)) ?? jeton;
          /**
           * ⚠️ LE NUMÉRO EST FACULTATIF CHEZ META, et on le pose quand on le connaît. Sans lui, Meta
           * choisit le numéro associé à la Page, qui peut ne pas être celui de cet espace : les prospects
           * écriraient alors à un autre numéro que le nôtre, et aucun webhook ne nous parviendrait. Meta
           * l'attend en chiffres, sans le `+` de la forme E.164.
           */
          const affiche = (await phoneStatusStore.getPhoneNumber(t))?.displayPhoneNumber ?? null;
          const numeroWhatsApp = affiche === null ? null : affiche.replace(/[^0-9]/g, '');
          return creerLaPublicite(
            { ...d, comptePubId, pageId, numeroWhatsApp },
            {
              televerserImage: (b64) => clientCreationPubs.televerserImage(comptePubId, jeton, b64),
              creerCampagne: (p) => clientCreationPubs.creerCampagne(comptePubId, jeton, p),
              creerEnsemble: (p) => clientCreationPubs.creerEnsemble(comptePubId, jeton, p),
              creerCrea: (p) => clientCreationPubs.creerCrea(comptePubId, jetonCrea, p),
              creerPub: (p) => clientCreationPubs.creerPub(comptePubId, jeton, p),
              supprimerCampagne: (id) => clientCreationPubs.supprimerCampagne(id, jeton),
            },
            {
              ouvrir: (v) => publicites.ouvrir(t, v),
              noterIds: (id, v) => publicites.noterIds(t, id, v),
              marquerEtat: (id, etatPub) => publicites.marquerEtat(t, id, etatPub),
              memoriserPub: (adId, campagneId) => publicites.memoriserPub(t, adId, campagneId),
              creerAutomation: (id, v) => publicites.creerAutomation(t, id, v),
              supprimerAutomation: (id) => publicites.supprimerAutomation(t, id),
            },
          );
        },

        /**
         * PUBLIER : l'automation d'abord, Meta ensuite. L'ORDRE est dans `publierLaPublicite`, pas ici.
         */
        publierPub: async (t: string, publiciteId: string) => {
          const pub = await publicites.lire(t, publiciteId);
          if (pub === null) throw new Error('cette publicité n’existe pas');
          const jeton = await jetonClair(t);
          await publierLaPublicite(
            publiciteId,
            { campagneId: pub.campagneId, ensembleId: pub.ensembleId, pubId: pub.pubId, etat: pub.etat, destination: pub.destination },
            { allumer: (objetId) => clientCreationPubs.changerStatut(objetId, jeton, 'ACTIVE') },
            {
              allumerAutomation: (id) => publicites.allumerAutomation(t, id),
              marquerPubliee: (id) => publicites.marquerEtat(t, id, 'publiee'),
            },
          );
        },

        /**
         * LA PAGE D'UNE PUBLICITÉ : ce qu'on sait d'elle, et son entonnoir.
         *
         * ⚠️ AUCUN APPEL À META ICI. Les chiffres viennent du balayage, qui relit toutes les quinze
         * minutes. Les relire à l'ouverture de l'écran ferait dépendre l'affichage du temps de réponse de
         * Meta, et multiplierait les appels par le nombre de personnes qui consultent.
         */
        lirePub: async (t: string, publiciteId: string) => {
          const publicite = await publicites.lire(t, publiciteId);
          if (publicite === null) return null;
          const comptes = await publicites.comptesDeLaCampagne(t, publicite.campagneId, ISSUES_NON_PRISES_EN_CHARGE);
          return { publicite, entonnoir: entonnoir({ depense: publicite.depense, clics: publicite.clics, ...comptes }) };
        },

        /**
         * PAUSE ET REPRISE, SUR LA CAMPAGNE, chez Meta.
         *
         * 🔴 SUR LA CAMPAGNE ET RIEN D'AUTRE, parce qu'elle est l'interrupteur : Meta met en pause tout ce
         * qu'elle contient. Toucher aussi l'ensemble et la publicité ferait trois appels dont deux sans
         * effet, et surtout trois façons d'échouer à mi-chemin sur le bouton d'ARRÊT d'une dépense.
         *
         * ⚠️ L'AUTOMATION N'EST PAS TOUCHÉE (spec § 3.5) : un prospect qui a cliqué juste avant la pause
         * peut écrire plusieurs minutes plus tard, et son lead a été payé.
         */
        basculerPub: async (t: string, publiciteId: string, actif: boolean) => {
          const pub = await publicites.lire(t, publiciteId);
          if (pub === null) throw new Error('cette publicité n’existe pas');
          await clientCreationPubs.changerStatut(pub.campagneId, await jetonClair(t), actif ? 'ACTIVE' : 'PAUSED');
          // Meta vient d'accepter : on l'écrit tout de suite, sinon l'écran afficherait « Diffuse » sur une
          // campagne qu'on vient d'arrêter, jusqu'au balayage suivant, et le client recliquerait.
          await publicites.noterStatutMeta(t, publiciteId, actif ? 'ACTIVE' : 'PAUSED');
        },
      };
    })(),
    account: {
      getPhoneNumber: (tenant) => phoneStatusStore.getPhoneNumber(tenant),
      /**
       * La pastille du numéro (demande de Julien, 2026-09-08).
       *
       * 🔴 RELUE, JAMAIS STOCKÉE : l'URL que Meta rend est signée et expire. En base, elle donnerait une
       * image qui marche quelques heures puis casse, sans que personne ne sache pourquoi.
       *
       * ⚠️ DERRIÈRE UN MICRO-CACHE (`cacheCourt`, la brique du dépôt) : l'Accueil est la page la plus
       * ouverte de la console, et un appel Graph par affichage la ferait dépendre du temps de réponse de
       * Meta pour une décoration. Dix minutes sont très en deçà de la durée de vie de l'URL.
       */
      photoNumero: (tenant, phoneNumberId) => photoNumeroCache.lire(`${tenant}:${phoneNumberId}`, async () => {
        if (!config.META_ACCESS_TOKEN) return null;
        const client = await metaFactory.phoneClientForTenant(tenant);
        return client.photoDeProfil(phoneNumberId);
      }),
      pullStatus: async (phoneNumberId, tenant) => {
        if (!config.META_ACCESS_TOKEN) return null; // pas de token global -> pas de pull live (statut sur le dernier connu)
        try {
          const phoneClientT = await metaFactory.phoneClientForTenant(tenant); // token PAR TENANT (B1), repli global en sommeil
          const info = await phoneClientT.get(phoneNumberId);
          // Santé WABA : 2e appel Graph, best-effort. Un échec (droits/état) ne casse pas le pull du numéro :
          // on retombe sur le statut du numéro seul (les champs WABA restent sur leur dernier connu via coalesce).
          const wabaId = await repo.getTenantWabaId(tenant);
          const waba = wabaId ? await phoneClientT.getWabaHealth(wabaId).catch(() => undefined) : undefined;
          return pullFromInfo(info, waba);
        } catch (err) {
          return pullFromError(err);
        }
      },
      saveStatus: (id, patch) => phoneStatusStore.saveStatus(id, patch),
      setHubspotConnected: (id, tenant, connected) => phoneStatusStore.setHubspotConnected(id, tenant, connected),
      // Rattrapage HubSpot (F3-a) : enfile un seul job hubspot-catchup (le worker liste les marques et re-pousse).
      // NO-OP si le pipeline analyse/push est inerte (mêmes conditions que le worker qui consomme la file).
      enqueueHubspotCatchup: async (tenant) => {
        if (!(config.CONVERSATION_ANALYSIS_ENABLED === 'true' && config.CONNECTOR_PUSH_URL !== '')) return;
        await queue.enqueue('hubspot-catchup', { tenantId: tenant });
      },
      getHubspotPortal: (tenant) => phoneStatusStore.getHubspotPortal(tenant),
      // Déconnexion complète (candidat 2) : appel service signé vers mm-hubspot (unlink + révocation token). Monté
      // seulement si le canal service est configuré (sinon la route répond 503, le front garde son bouton).
      ...(config.HUBSPOT_SERVICE_URL
        ? { disconnectHubspot: (tenant: string) => disconnectHubspot({ baseUrl: config.HUBSPOT_SERVICE_URL, secret: config.HUBSPOT_SERVICE_SECRET, transport }, tenant) }
        : {}),
      // Reflet local (toujours dispo) : coupe hubspot_connected de tous les numéros du tenant après succès connecteur.
      disconnectHubspotTenant: (tenant) => phoneStatusStore.disconnectHubspotTenant(tenant),
    },
    me: { getUser: (userId) => userStore.getById(userId) },
    workflows: {
      createWorkflow: (tenant, name, graph) => workflowStore.insert(tenant, name, graph),
      tenantCode: (tenant) => resolveTenantCode(pool, tenant),
      listWorkflows: (tenant) => workflowStore.list(tenant),
      // Le navigateur reçoit le RÉSUMÉ : plus aucun graphe ne traverse le réseau pour afficher des noms.
      listWorkflowsResume: (tenant) => workflowStore.listResume(tenant),
      getWorkflow: (id, tenant) => workflowStore.getById(id, tenant),
      updateWorkflow: (id, tenant, patch) => workflowStore.update(id, tenant, patch),
      // Bouton « Publier » (lot 7) : le SEUL chemin qui touche le graphe exécuté.
      publishWorkflow: (id, tenant) => workflowStore.publish(id, tenant),
      audit: auditSink,
      deleteWorkflow: (id, tenant) => workflowStore.remove(id, tenant),
      // La garde du 409 : une publicite vivante retient son scenario. Requise par le type, parce qu un
      // cablage qui l oublierait laisserait supprimer le scenario d une pub qui diffuse, en silence.
      publicitesQuiUtilisent: (tenant, workflowId) => publicites.publicitesQuiUtilisent(tenant, workflowId),
      // Déclare les tags des blocs « ajout de tag » dans le référentiel (Contenus > Tags) à la sauvegarde.
      declareTags: async (tenant, tags) => { for (const t of tags) await tagStore.create(tenant, t); },
      // Lien de test (Lot F) : jeton stable posé au 1er clic, + numéro affiché pour construire le lien wa.me.
      ensureTestToken: (id, tenant, token) => workflowStore.ensureTestToken(id, tenant, token),
      getDisplayPhoneNumber: async (tenant) => (await phoneStatusStore.getPhoneNumber(tenant))?.displayPhoneNumber ?? null,
    },
    // Node « Envoi de mail » : boîtes SMTP + modèles (Contenu), et le résolveur qu'invalident les routes
    // d'écriture pour ne jamais garder un transport périmé (hôte/mot de passe changés).
    email: { accounts: emailAccounts, templates: emailTemplates, resolver: emailResolver },
    rcsChannel: {
      etat: (tenant) => workflowRuntime.rcsStack.agents.etatPour(tenant),
      verifier: (apiKey) => verifierCleRcs(fetchGet, apiKey),
      activer: async (tenant, canal, apiKey) => {
        // La clé est chiffrée ICI, jamais stockée en clair. `client_token_enc` reste réservé au jour où un
        // fournisseur signera ses rappels (Google le fait) ; smsmode, lui, ne signe pas.
        //
        // 🔴 Le `webhook_code` EST le secret de l'adresse de rappel : c'est lui, et lui seul, qui dit à quel
        // workspace appartient un appel non signé. Donc 128 bits, comme le code des webhooks entrants, et
        // jamais une valeur courte « puisque ce n'est qu'un identifiant ».
        await workflowRuntime.rcsStack.agents.activer(
          tenant,
          canal,
          encryptSecret(apiKey, config.ENCRYPTION_KEY),
          encryptSecret(randomBytes(24).toString('hex'), config.ENCRYPTION_KEY),
          `rcs-${randomBytes(16).toString('hex')}`,
        );
      },
      desactiver: (tenant) => workflowRuntime.rcsStack.agents.desactiver(tenant),
    },
    /**
     * Rappels smsmode : rapports de livraison et réponses des contacts. C'est ce qui referme la boucle du
     * canal RCS, qui jusqu'ici ne savait qu'émettre.
     *
     * Le tenant vient du CODE de l'URL (`parWebhookCode`), jamais du corps : smsmode ne signe pas ses rappels.
     */
    rcsCallback: {
      parCode: (code) => workflowRuntime.rcsStack.agents.parWebhookCode(code),
      noterRappel: (tenant, corps) => workflowRuntime.rcsStack.agents.noterRappel(tenant, corps),
      onDlr: async (tenant, dlr) => {
        // 1. Le destinataire de campagne, par identifiant de message. Même chemin que les accusés Meta : une
        //    seule échelle de statuts dans le produit, donc un seul écran de résultats à lire.
        if (dlr.status !== null) {
          await recipientStore.updateDeliveryByMessageId(dlr.messageId, dlr.status, dlr.detail, null);
          // 1 bis. La MESURE PAR BLOC (Analytics > Mes tableaux). Le chemin Meta le fait depuis toujours
          //    (webhooks/delivery.ts), pas celui-ci : un bloc RCS n'affichait donc jamais « délivré » ni
          //    « lu », alors que smsmode remonte bien DELIVERED et READ et que l'envoi RCS écrit bien son
          //    identifiant dans workflow_node_events. Best-effort, comme côté Meta : une mesure ne doit pas
          //    faire échouer le traitement d'un rapport de livraison.
          if (dlr.status !== 'sent') {
            try {
              await nodeEventStore.recordStatusForMessage(dlr.messageId, dlr.status);
            } catch (err) {
              // eslint-disable-next-line no-console
              console.error('mesure de bloc RCS (statut) ignorée:', err instanceof Error ? err.message : err);
            }
          }
        }
        // 2. Les DEUX sorties du bloc RCS. C'est ICI, et nulle part ailleurs, qu'elles s'allument : chez
        //    smsmode le sort d'un message ne se sait pas avant l'envoi, il se constate APRÈS, sur un rapport.
        //    Échec définitif -> repli WhatsApp. Remis -> la suite du parcours (sauf si le bloc attend encore
        //    un clic, cf. `rcsDelivered`).
        if (dlr.to !== '') {
          if (dlr.echecDefinitif) await workflowRuntime.executor.rcsUndeliverable(tenant, dlr.to, dlr.messageId);
          else if (dlr.status === 'delivered') await workflowRuntime.executor.rcsDelivered(tenant, dlr.to, dlr.messageId);
        }
      },
      onMo: async (tenant, mo) => {
        // Une position ou un fichier n'ont pas de texte : `apercuMo` en fabrique un LISIBLE plutôt que de
        // laisser une bulle vide et de jeter les coordonnées.
        const apercu = apercuMo(mo);
        // 1. STOP AVANT tout le reste. Continuer d'écrire après un refus fait suspendre l'agent par
        //    l'opérateur, et l'enregistrement de l'opt-out ne doit dépendre d'aucune étape qui pourrait
        //    échouer après lui.
        if (mo.kind === 'text' && estDemandeArret(mo.text)) {
          const marque = await workflowRuntime.rcsStack.optout.markOptedOut(tenant, mo.from);
          if (!marque) {
            // eslint-disable-next-line no-console
            console.error(`STOP RCS reçu de ${mo.from} (${tenant}) sans fiche contact : rien à désabonner`);
          }
        }
        // 2. Le fil d'inbox : un échange RCS se lit au même endroit qu'un échange WhatsApp, dans le fil unique
        //    du contact. La bulle porte son canal.
        await inboxStore.recordInbound(tenant, {
          phoneNumberId: '',
          waId: mo.from,
          messageId: mo.messageId,
          type: mo.kind === 'suggestion' ? 'button' : mo.kind,
          body: apercu,
          buttonPayload: mo.postbackData,
          profileName: null,
          field: 'messages',
        }, 'rcs');
        // 2 bis. La FICHE CONTACT et les AUTOMATIONS, que le chemin Meta branche depuis toujours et pas
        //    celui-ci. Un client qui écrivait DEVIS en RCS ne déclenchait rien, sans le moindre journal :
        //    l'opérateur croyait son automation cassée. C'est aussi ce qui produisait le « STOP RCS sans
        //    fiche contact » ci-dessus, faute de fiche créée à la première prise de contact.
        //
        //    ⚠️ Le canal part DANS l'événement. Sans lui, le runner conclurait que la fenêtre de service
        //    WhatsApp est ouverte (un entrant vaut preuve, côté Meta) et le scénario déclenché ouvrirait par un
        //    message rapide chez un contact hors fenêtre : refus Meta 131047.
        //
        //    Isolé : ni la fiche ni l'automation ne doivent faire échouer la réception d'un message.
        try {
          const issue = await contactStore.upsertFromInbound(tenant, mo.from, null);
          await enfilerEvenementAutomation(queue, {
            tenantId: tenant,
            event: { kind: 'message', waId: mo.from, body: mo.kind === 'text' ? mo.text : null, isNewContact: issue === 'created', channel: 'rcs' },
          } satisfies AutomationEventJob);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('automations RCS ignorées:', err instanceof Error ? err.message : err);
        }
        // 3. Le parcours. Un bouton tapé porte `btn:<i>` (cf. `normaliserPostbacks`) et choisit sa branche ;
        //    une réponse écrite suit la sortie « envoyé ». Isolé : un scénario qui casse ne doit pas faire
        //    rejouer six fois un rappel dont l'inbox et l'opt-out sont déjà enregistrés.
        try {
          await workflowRuntime.executor.advance(tenant, mo.from, mo.messageId, mo.postbackData, 'rcs');
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('avance de scénario sur réponse RCS ignorée:', err instanceof Error ? err.message : err);
        }
      },
    },
    /**
     * Visuels des messages RCS. Le téléversement rend directement l'URL PUBLIQUE : c'est tout l'intérêt,
     * l'opérateur télécom va chercher l'image lui-même et personne n'a à trouver où l'héberger.
     */
    rcsMedia: {
      list: (tenant) => rcsMediaStore.list(tenant),
      create: async (tenant, input) => {
        const code = newMediaCode();
        const media = await rcsMediaStore.create(tenant, { ...input, code });
        return { media, url: urlImageRcs(adressesApi.racine, code, input.mime) };
      },
      remove: (tenant, id) => rcsMediaStore.remove(tenant, id),
      getByCode: (code) => rcsMediaStore.getByCode(code),
    },
    rcsMessages: {
      list: (tenant) => rcsMessageStore.list(tenant),
      create: (tenant, name, content) => rcsMessageStore.create(tenant, name, content),
      update: (tenant, id, name, content) => rcsMessageStore.update(tenant, id, name, content),
      remove: (tenant, id) => rcsMessageStore.remove(tenant, id),
    },
    // Automations (Lot E) : déclencher un scénario sur un événement (mot-clé, nouveau contact, tag ajouté).
    automations: {
      list: (tenant) => automationStore.list(tenant),
      getById: (id, tenant) => automationStore.getById(id, tenant),
      create: (tenant, input) => automationStore.create(tenant, input),
      update: (id, tenant, patch) => automationStore.update(id, tenant, patch),
      remove: (id, tenant) => automationStore.remove(id, tenant),
      // Un tenant ne peut cibler QUE ses propres scénarios (même garde que la campagne workflow).
      workflowBelongsToTenant: async (wfId, tenant) => (await workflowStore.getById(wfId, tenant)) !== null,
    },
    // Chaine WhatsApp (Channels Me) : publier un post dont le bouton demarre un scenario.
    channelsMe: {
      getConnection: (tenant) => channelsMeConnections.get(tenant),
      getSecrets: (tenant) => channelsMeConnections.getSecrets(tenant),
      upsertConnection: (tenant, c) => channelsMeConnections.upsert(tenant, c),
      markVerified: (tenant) => channelsMeConnections.markVerified(tenant),
      getOrganisation: (cx) => channelsMeClient.getOrganisation(cx),
      listChannels: (cx) => channelsMeClient.listChannels(cx),
      getMessages: (cx) => channelsMeClient.getMessages(cx),
      // 🔴 `m` DOIT ETRE RELAYE ENTIER. Une fleche a un parametre est parfaitement assignable a un contrat
      // qui en declare deux : le second serait avale EN SILENCE, l'image du post disparaitrait sans que le
      // typecheck ne dise rien. Defaut deja paye en production le 2026-09-03.
      createMessage: (cx, m) => channelsMeClient.createMessage(cx, m),
      listLinks: (tenant) => channelsMeLinks.list(tenant),
      createLink: (tenant, l) => channelsMeLinks.create(tenant, l),
      linkById: (tenant, id) => channelsMeLinks.byId(tenant, id),
      // Rattrapage : defait l'automation compagnon quand `createLink` echoue juste apres l'avoir creee
      // (sinon elle reste POSSEDEE, orpheline, invisible et inaccessible depuis l'ecran Automation).
      supprimerAutomationCompagnon: (tenant, automationId) => channelsMeLinks.supprimerAutomationCompagnon(tenant, automationId),
      conversationsParLien: (tenant) => channelsMeLinks.conversationsParLien(tenant),
      listPosts: (tenant) => channelsMePosts.list(tenant),
      createPost: (tenant, p) => channelsMePosts.create(tenant, p),
      // L'automation compagnon du lien. Trois choses se decident ICI et nulle part ailleurs :
      //  - `enabled: false`, parce qu'un lien cree mais jamais publie ne doit rien declencher ;
      //  - `possedePar`, qui met la ligne hors de portee de l'ecran Automation (predicat du store) ;
      //  - `mode: 'contains'`, qui laisse passer un abonne ayant ajoute un mot devant ou derriere la phrase.
      // 🔴 LA MEME NORMALISATION QUE LA CORRESPONDANCE. `normalizeText` est celle qu'applique
      // `matchesTrigger` au corps du message et `keywordsOf` au mot-cle stocke : deux liens que cette
      // fonction rend egaux matcheraient le meme message, donc c'est exactement elle qui doit trancher
      // l'unicite. Une comparaison SQL approchee laisserait passer « Ça m'intéresse » et « ca m interesse ».
      phraseEnConflit: async (tenant, phrase) => {
        const cible = normalizeText(phrase);
        const existantes = await channelsMeLinks.phrasesDesLiens(tenant);
        // 🔴 L'INCLUSION, DANS LES DEUX SENS, PAS L'EGALITE. La comparaison est en mode `contains` : « Je
        // veux le guide » et « Je veux le guide 2026 » sont deux phrases DIFFERENTES, et pourtant un abonne
        // qui appuie sur le second bouton envoie un texte qui contient AUSSI la premiere. Les deux
        // automations matchent, les deux scenarios demarrent, et le second clot le premier : l'abonne voit
        // un parcours commencer puis disparaitre. Sur un post deja publie, c'est sans recours.
        // Ce cas n'existait pas avec le jeton : deux jetons tires ne s'incluent jamais.
        return existantes.some((p) => {
          const n = normalizeText(p);
          return n.includes(cible) || cible.includes(n);
        });
      },
      messagesContenantLaPhrase: (tenant, phrase) => channelsMeLinks.messagesContenantLaPhrase(tenant, phrase),
      creerAutomationCompagnon: (tenant, input) => automationStore.create(tenant, {
        name: input.nom,
        triggerKind: 'keyword',
        // 🔴 `contains` EST CE QUI SAUVE LES POSTS DEJA PUBLIES. Le mot-cle est la PHRASE depuis le
        // 2026-09-07 ; un post distribue avant cette date envoie `phrase (cm-xxxx)`, qui la CONTIENT, donc
        // son bouton continue de declencher. En mode `equals`, tous les posts en circulation seraient morts,
        // sans aucun recours possible.
        triggerConfig: { keywords: [input.motCle], mode: 'contains' },
        conditionGroup: null,
        workflowId: input.workflowId,
        startNodeId: input.startNodeId,
        cooldownSeconds: input.cooldownSeconds,
        enabled: false,
        possedePar: 'channelsme_link',
        maxFiresPerHour: input.maxParHeure,
      }),
      // 🔴 PAR LE STORE DES LIENS, JAMAIS PAR `PgAutomationStore`. Ce dernier exclut de `update`/`remove`
      // toute ligne `possede_par is not null` : ces deux methodes ecrivent leur PROPRE requete sur
      // `automations`, garde miroir `possede_par = 'channelsme_link'` comprise.
      allumerAutomationLien: (tenant, linkId) => channelsMeLinks.allumerAutomation(tenant, linkId),
      eteindreAutomationLien: (tenant, linkId) => channelsMeLinks.eteindreAutomation(tenant, linkId),
      scenarioEtat: async (tenant, wfId) => {
        const wf = await workflowStore.getById(wfId, tenant);
        if (!wf) return 'inconnu';
        // « Aucune version publiee » se lit sur le graphe PUBLIE, le seul que l'executeur lise : un scenario
        // dont il est vide ne demarrerait rien, meme si un brouillon existe a cote.
        return wf.graph.nodes.length > 0 ? 'ok' : 'vide';
      },
      getDisplayPhoneNumber: async (tenant) => (await phoneStatusStore.getPhoneNumber(tenant))?.displayPhoneNumber ?? null,
      // Notification best-effort : `sendTelegram` ne leve jamais et est un no-op si Telegram n'est pas
      // configure. Le jeton d'un lien n'apparait nulle part dans ce message.
      demanderActivation: async ({ tenantId, userId, message }) => {
        await sendTelegram(`[engage-me] demande d’activation Channels Me\nespace ${tenantId}\nutilisateur ${userId ?? 'inconnu'}\n${message.slice(0, 500)}`);
      },
    },
    ops: {
      /**
       * 🔴 L'ARRÊT D'URGENCE D'UN ESPACE. Il ferme la console ET l'API publique (`/v1`, `/mcp`) ; il
       * n'arrête PAS les campagnes déjà enfilées, cf. le runbook de `DEPLOY.md`.
       *
       * ⚠️ LA NOTE EST JOURNALISÉE PAR LA ROUTE (`src/http/ops.ts`, `ops_verrou_espace`), et UNE fois : c'est
       * la seule trace durable du POURQUOI. Ce câblage l'écrivait aussi, par un journal de Fastify qui était
       * muet ; le rendre audible avait doublé chaque ligne.
       */
      /**
       * 🔴 DÉPOSER UN JETON PUBLICITAIRE CRÉÉ À LA MAIN, parce que la fenêtre Meta ne peut pas servir
       * notre PROPRE portefeuille : Meta exige que celui du client soit distinct de celui qui possède
       * l'application, et le grise dans la liste (mesuré le 2026-09-23). Sans cette porte, MessagingMe ne
       * pourrait jamais faire ses propres publicités avec son propre produit.
       *
       * 🔴 LE JETON EST VÉRIFIÉ CHEZ META AVANT D'ÊTRE GARDÉ, par les MÊMES appels que la connexion par
       * l'écran : on refuse un compte ou une Page que ce jeton n'accorde pas, plutôt que de ranger un
       * secret qui ne servirait à rien et qu'on croirait bon. Et il est chiffré ICI, comme partout.
       *
       * ⚠️ IL REMPLACE une connexion existante, là où l'écran la REFUSE. La raison tient à qui fait le
       * geste : l'écran est utilisé par un client qui pourrait écraser son propre jeton sans le savoir,
       * quand `/ops` est notre surface d'exploitation, où remplacer est précisément ce qu'on vient faire.
       */
      deposerJetonPub: async (tenantId, jeton, comptePubId, pageId) => {
        const actifs = await clientPubs.actifsAccordes(jeton);
        const compte = actifs.comptesPub.find((c) => c.id === sansPrefixeAct(comptePubId));
        const page = actifs.pages.find((p) => p.id === pageId);
        if (compte === undefined) throw new Error(`ce jeton n'accorde pas le compte publicitaire ${comptePubId}`);
        if (page === undefined) throw new Error(`ce jeton n'accorde pas la Page ${pageId}`);
        const pageLiee = 'inconnu' as const; // Meta n'expose pas la liaison (cf. `src/meta/pubs.ts`).
        // 🔴 CHIFFRER AVANT DE TOUCHER À QUOI QUE CE SOIT. `encryptSecret` lève sur une
        // `ENCRYPTION_KEY` absente ou mal formée, et cette route n'a PAS le garde-fou `configId === ''`
        // de l'échange : une levée plus bas détruirait la connexion existante sans rien ranger.
        const chiffreNeuf = encryptSecret(jeton, config.ENCRYPTION_KEY);
        // 🔴 RÉVOQUER L'ANCIEN, MAIS SEULEMENT SI C'EST UNE AUTRE ENTITÉ : SINON ON TUE LE NEUF.
        // Tout le raisonnement, les CINQ issues et les mutations qui les gardent vivent dans
        // `retirerAncienAcces` (`src/meta/pubs.ts`), qui s'exécute contre un faux client dans les tests.
        // Ce câblage ne fait que DÉLÉGUER : il n'a plus de décision à relire, donc plus de décision à
        // rater. Trois écritures successives de cette condition ont été prises en défaut ici même.
        const ancien = await connexionsPub.lireJetonChiffre(tenantId);
        const ancienRevoque = await retirerAncienAcces(
          clientPubs,
          ancien === null ? null : decryptSecret(ancien, config.ENCRYPTION_KEY),
          jeton,
        );
        await connexionsPub.remplacer(tenantId, chiffreNeuf, {
          comptePubId: compte.id, compteNom: compte.nom, pageId: page.id, pageNom: page.nom,
          devise: compte.devise, fuseau: compte.fuseau, pageLiee,
        });
        return {
          comptePubId: compte.id, compteNom: compte.nom, pageId: page.id, pageNom: page.nom,
          devise: compte.devise, fuseau: compte.fuseau, pageLiee, ancienRevoque,
        };
      },
      verrouillerEspace: (tenantId, verrouille, _note) => opsStore.verrouillerEspace(tenantId, verrouille),
      getTenantOverview: () => opsStore.getTenantOverview(),
      /**
       * LA GRILLE DE PRIX, UNE POUR TOUS LES ESPACES (lot 8, migration 0168).
       *
       * 🔴 ELLE EST ICI ET PLUS DANS LES REGLAGES DU CLIENT, et c'est le sujet du lot : un client n'a pas a
       * fixer, ni meme a voir, ce qu'on lui facture. C'est la SECONDE ecriture metier de cette surface,
       * apres le rechargement d'un solde, et elle s'y trouve pour la meme raison exactement : le geste ne
       * doit jamais etre atteignable depuis un compte de la console.
       */
      lireGrillePrix: async () => grilleDepuisLigne(await statsStore.grillePrixGlobale()),
      ecrireGrillePrix: (grille, par) => settingsStore.setGrillePrixGlobale(grille, par),
      getGlobalDaily: (days) => opsStore.getGlobalDaily(days),
      getQueueLoad: () => opsStore.getQueueLoad(),
      // L'équité : quels GROUPES attendent le plus. Vide = tout le monde est servi.
      getQueueLoadParGroupe: () => opsStore.getQueueLoadParGroupe(),
      getQueueLatence: (h) => opsStore.getQueueLatence(h),
      // Les jobs MORTS et leur rejeu. Deuxième écriture métier de la surface d'exploitation, assumée pour la
      // même raison que le rechargement de solde : rejouer un traitement mort est un geste d'exploitation,
      // cross-espace, qui suppose qu'on ait corrigé la cause de l'échec.
      listerJobsMorts: (limite) => opsStore.listerJobsMorts(limite),
      reenfiler: (nomDeFile, data) => queue.enqueue(nomDeFile, data),
      oublierJobsMorts: (ids) => opsStore.oublierJobsMorts(ids),
      getWorkerHeartbeat: () => heartbeatStore.get(),
      /**
       * L'attente du pool (lot 7). Deux lectures qui ne se remplacent pas : l'état INSTANTANÉ ne peut être
       * que celui de CE process (l'API voit son propre pool en mémoire), et la COURBE vient de la base, seul
       * canal par lequel le worker peut se montrer.
       *
       * ⚠️ `waitingCount` non nul est le vrai signal : ce n'est pas « à combien du plafond on est » qui
       * compte, c'est « quelqu'un attend-il ».
       */
      etatPoolInstantane: () => ({
        process: 'api',
        total: pool.totalCount,
        libres: pool.idleCount,
        enAttente: pool.waitingCount,
        max: config.DB_POOL_MAX,
        maxMsDepuisDemarrage: Math.round(mesureAttentePool.maxDepuisDemarrage),
      }),
      lireAttentesPool: (minutes) => poolAttentesStore.lireDernieresMinutes(minutes),
      // Le solde prepaye d un workspace pour l agent IA. La RECHARGE est la seule ecriture metier de cette
      // surface, et elle est ici parce qu un client ne doit jamais pouvoir crediter son propre compte.
      //
      // ⚠️ L espace est RESOLU d abord, dans les deux sens. En lecture, un espace inconnu rendrait un solde de
      // zero, que l operateur lirait comme « client a sec » et rechargerait. En ecriture, la cle etrangere
      // leverait, donc un 500 remplace par la page d erreur de Cloudflare, sur la seule route qui ecrit de l
      // argent. `getTenantName` est le meme point de resolution que `/ops/observe`.
      soldeAgent: async (tenantId) => {
        if ((await opsStore.getTenantName(tenantId)) === null) return null;
        return {
          soldeMicroEur: await credits.solde(tenantId),
          mouvements: await credits.mouvements(tenantId, 50),
        };
      },
      // ⚠️ Le jour où un espace se supprimera, CECI passe AVANT : sinon le `on delete cascade` emporte notre
      // ligne et la clé survit chez Vercel, identifiant perdu, donc facturable et irrévocable.
      ...(provisionCle ? { revoquerCleModele: (tenantId: string) => revoquerCleGateway(provisionCle, tenantId) } : {}),
      rechargerAgent: async (tenantId, montant, note) => {
        if ((await opsStore.getTenantName(tenantId)) === null) return null;
        const solde = await credits.crediter(tenantId, montant, note);
        // 🔴 LE PLAFOND DE LA CLE SUIT LE RECHARGEMENT, sinon le client paie et reste bloque : son credit
        // monte chez nous, et le Gateway continue de le couper au plafond d avant. C est le seul endroit ou
        // du credit est AJOUTE, donc le seul endroit ou ce rattrapage a lieu d etre.
        // ⚠️ Ne leve pas et n annule rien : le rechargement est deja ecrit, et un tiers indisponible ne doit
        // pas faire echouer un paiement. Le plafond rattrapera au mouvement suivant.
        if (provisionCle) {
          await remonterPlafondApresRecharge(provisionCle, tenantId, montant, (msg, err) => {
            journaliser('error', msg, { err, tenantId });
          });
        }
        return solde;
      },
      /**
       * Session d'OBSERVATION d'un espace client : un jeton de session en LECTURE SEULE.
       *
       * `userId` porte une valeur PARLANTE et non un identifiant d'utilisateur : le porteur n'a pas de
       * compte dans cet espace, et si cette valeur se retrouvait un jour dans une trace, elle doit se lire
       * pour ce qu'elle est. Durée courte (1 h) : une session d'observation n'a pas à survivre à la journée.
       */
      observerTenant: async (tenantId) => {
        const nom = await opsStore.getTenantName(tenantId);
        if (nom === null) return null;
        const token = await signSession(
          { userId: 'ops-observation', tenantId, role: 'admin', impersonated: true },
          config.AUTH_SECRET,
          '1h',
        );
        return { token, tenantName: nom };
      },
    },
    opsToken: config.OPS_TOKEN,
    support: {
      enabled: !!config.RESEND_API_KEY && !!config.SUPPORT_TO,
      getUserEmail: async (userId) => (await userStore.getById(userId))?.email ?? null,
      sendSupport: async ({ tenantId, userId, email, subject, message }) => {
        const client = new ResendClient(config.RESEND_API_KEY);
        const text = [
          'Nouveau message de support (console MBA)',
          '',
          `Tenant : ${tenantId}`,
          `User : ${userId ?? 'inconnu'}`,
          `Email : ${email ?? 'non fourni'}`,
          '',
          `Sujet : ${subject}`,
          '',
          message,
        ].join('\n');
        await client.send({
          from: config.SUPPORT_FROM,
          to: config.SUPPORT_TO,
          subject: `[Support MBA] ${subject}`,
          text,
          ...(email ? { replyTo: email } : {}),
        });
      },
    },
    apiKeys: {
      audit: auditSink,
      createKey: (tenant, name, scopes) => apiKeyStore.create(tenant, name, scopes),
      listKeys: (tenant) => apiKeyStore.listByTenant(tenant),
      revokeKey: (tenant, id) => apiKeyStore.revoke(tenant, id),
    },
    v1: {
      apiKeys: apiKeyStore,
      /**
       * Le relais du Meta Business Agent (migration 0161). Le MÊME point de passage que l'agent IA
       * (`creerAppelConnecteur`), avec les mêmes lectures paresseuses : un appel de l'agent de Meta passe par
       * les mêmes gardes, et se journalise sous l'appelant `mba`.
       */
      mbaRelais: {
        numeroDuTenant: (t) => repo.getTenantPhoneNumberId(t),
        outilsActifs: (t, c) => toolCatalog.listActifsConsommateur(t, c),
        requete: (t, id) => agentRequetes.parId(t, id),
        // 🔴 PROJECTION, jamais la ligne brute : même règle que `lireContact` du worker. Le numéro, le BSUID
        // et le statut d'opt-in n'ont rien à faire dans ce qui part vers le système du client.
        contact: async (t, waId) => {
          const etat = await contactStore.getContactStateByWaId(t, waId);
          return etat ? { nom: etat.name ?? '', tags: etat.tags, champs: etat.fields } : null;
        },
        appeler: creerAppelConnecteur({
          sources: agentSources,
          requetes: agentRequetes,
          derniereSaisie: (t, waId) => inboxStore.derniereSaisieDuContact(t, waId),
          fuseau: async (t) => (await settingsStore.get(t)).timezone,
        }),
        journal: new PgJournalAppels(pool),
        // La FORME de l'en-tête du numéro, jamais sa valeur. GARDÉ après l'essai réel du relais (décision du
        // 2026-09-21, `wip.md`) : sans lui, une macro que Meta cesserait de remplir serait invisible.
        // eslint-disable-next-line no-console
        journaliserForme: (f) => console.info(`mba-relais: en-tete du numero ${f}`),
        // Borne l'attente d'un ENVOI avant de répondre à Meta, qui coupe un outil vers trois secondes
        // (`DELAI_REPONSE_ENVOI_MS`, `src/http/mba-relais.ts`).
        attendre: (ms) => new Promise((r) => { setTimeout(r, ms); }),
        // Un envoi qui échoue APRÈS « C'est parti » est dit à l'agent de Meta par un événement (les gardes vivent
        // dans le module, testé), comme la réponse « à côté » du lot 4.
        signalerEchecTardif: creerSignalerEchecTardif({
          detenteur: (t, w) => inboxStore.getControlOwner(t, w),
          numero: (t) => repo.getTenantPhoneNumberId(t),
          envoyer: async (t, pn, to, event) => (await metaFactory.mbaClientForTenant(t)).agentEvent(pn, to, event, AbortSignal.timeout(10_000)),
          // eslint-disable-next-line no-console
          journal: (ligne) => console.log(ligne),
        }),
        // Les gestes maison : les MÊMES fonctions que les agents IA et le mini-CRM, aucune réécrite ici.
        maison: {
          poserTag: workflowRuntime.poserTagDepuisAgent,
          ecrireChamp: async (t, waId, champ, valeur) => { await contactStore.mergeFieldsByPhone(t, waId, { [champ]: valeur }); },
          // La même liste que la ligne rouge de l'onglet Outils (`mbaOutils.champs`), sinon l'écran et le relais
          // ne seraient pas d'accord sur ce qui existe.
          champExiste: async (t, champ) => (await fieldStore.list(t)).some((f) => f.key === champ),
          estBloque: (t, waId) => contactStore.isBlockedByWaId(t, waId),
          antiRejeu: new AntiRejeu(DUREE_ANTI_REJEU_MS),
          dernierMessageDuClient: (t, waId) => inboxStore.dernierMessageDuClient(t, waId),
          // Les deux gestes qui ENVOIENT : ils rendent le fil sur toute issue ratée, exception comprise
          // (`src/mba/gestes-envoi.ts`, testé ; revue finale du 2026-09-22).
          ...creerGestesEnvoi({
            graphePublie: async (t, id) => (await workflowStore.getById(id, t))?.graph ?? null,
            fenetreOuverte: async (t, waId) => (await inboxStore.getWindowOpenByWaIds(t, [waId])).get(waId) === true,
            contactId: (t, waId) => contactStore.findIdByWaId(t, waId),
            envoyerDepuisBloc: (t, workflowId, graphe, contact, noeudId) => workflowRuntime.executor.startFromNode(
              t, workflowId, graphe, contact, noeudId, { ignoreHumanControl: true, emitEvents: false },
            ),
            lancerScenario: (t, workflowId, waId, ouverte) => lancerScenarioPourContact(t, workflowId, waId, ouverte),
            rendreLaMain: (t, waId) => workflowRuntime.rendreLaMainApresParcours(t, waId),
            // Expérience du 2026-09-22 : on ne prend le fil qu'une fois le tour de l'agent de Meta fini.
            attendreFinDuTour: creerAttendreFinDuTour({
              dernierMessageDeLAgent: (t, waId) => inboxStore.dernierMessageDeLAgent(t, waId),
              attendre: (ms) => new Promise((r) => { setTimeout(r, ms); }),
              maintenant: () => Date.now(),
              // eslint-disable-next-line no-console
              journal: (ligne) => console.log(ligne),
            }),
            empreinteDuFil: (t, waId) => inboxStore.empreinteDuFil(t, waId),
            estBloque: (t, waId) => contactStore.isBlockedByWaId(t, waId),
          }),
        },
      },
      // Les fiches de l'API publique : identité multi-clés, consentement journalisé, lecture (spec § 2).
      contacts: creerServiceContactsV1({
        contacts: contactStore,
        fields: fieldStore,
        audit: auditSink,
        joignabiliteRcs: async (tenant, e164) => {
          const agentId = await workflowRuntime.rcsStack.agents.agentIdForTenant(tenant);
          if (!agentId) return null;
          // Les DEUX formes de clé du cache (`+33…` des campagnes, chiffres seuls des scénarios et de l'Inbox).
          return joignabiliteRcsToutesFormes(rcsJoignabilite, agentId, e164, Date.now());
        },
      }),
      sends: {
        resolveScenario: (tenant, ref) => resolveScenario(tenant, ref, workflowStore),
        // Cible node : le code `nod_` vit dans le graphe -> scan des scénarios du tenant. Le libellé du bloc
        // (ou son code à défaut) sert à nommer la campagne dans la console.
        resolveNode: async (tenant, code) => {
          const r = await resolveNode(tenant, code, workflowStore);
          // Un code `nod_` est unique : resolveNode ne produit jamais 'ambiguous', seulement not_found.
          if (!r.ok) return { ok: false, reason: 'not_found' };
          const node = r.value.graph.nodes.find((n) => n.id === r.value.nodeId);
          const label = String(node?.data.label ?? '').trim() || code;
          // Le TYPE décide si la fenêtre de service WhatsApp s'applique à cette cible (cf. exigeFenetre24h).
          return { ok: true, value: { workflowId: r.value.workflowId, nodeId: r.value.nodeId, label, type: node?.type ?? null } };
        },
        getWindowOpenByWaIds: (tenant, waIds) => inboxStore.getWindowOpenByWaIds(tenant, waIds),
        getTenantPhoneNumberId: (tenant) => repo.getTenantPhoneNumberId(tenant),
        phoneNumberBelongsToTenant: (pn, tenant) => repo.phoneNumberBelongsToTenant(pn, tenant),
        findContactByPhone: async (tenant, phone) => { const c = await contactStore.findByPhone(tenant, phone); return c ? { id: c.id } : null; },
        createContactByPhone: (tenant, phone) => contactStore.upsertByPhoneReturningId({ tenantId: tenant, phoneE164: phone, profileName: null, fields: {}, optInStatus: 'unknown' }),
        listContactsForBuildByIds: (tenant, ids) => repo.listContactsForBuildByIds(tenant, ids),
        createSend: (input, recipients) => repo.createWithRecipients(input, recipients),
        enqueue: (campaignId, tenantId, count, rate) =>
          enqueueCampaignRun(queue, {
            campaignId,
            tenantId,
            pendingCount: count,
            resolvedRatePerMinute: resolveRatePerMinute(rate, config.CAMPAIGN_DEFAULT_RATE_PER_MINUTE, plafondLePlusBas(config)),
          }),
        idempotencyClaim: (tenant, key) => idempotencyStore.claim(tenant, key),
        idempotencyComplete: (tenant, key, sendId, response) => idempotencyStore.complete(tenant, key, sendId, response),
        idempotencyRelease: (tenant, key) => idempotencyStore.release(tenant, key),
        getSendDetail: (sendId, tenant) => repo.getCampaignDetail(sendId, tenant),
      },
      /**
       * `POST /v1/messages` : un simple texte dans la fenêtre de 24 h (lot 7 du 2026-09-23).
       *
       * 🔴 CE BLOC NE FAIT QUE BRANCHER, il ne décide de rien. Les quatre gestes (fenêtre, désabonnement,
       * envoi, trace) vivent dans `repondreDansLaFenetre`, partagé avec la console et le serveur MCP.
       *
       * 🔴 ET `estDesabonne` EST BRANCHÉE ICI, ce qui n'était vrai que du seul MCP jusqu'à ce lot. La règle
       * est « une MACHINE ne parle pas à quelqu'un qui a dit STOP » : elle se lisait `origine === 'mcp'`,
       * donc en liste d'appelants, et l'API publique serait passée à travers sans qu'aucun test ne tombe.
       * Elle demande désormais l'inverse (tout ce qui n'est pas un opérateur humain), et la dépendance est
       * REQUISE par le type depuis le lot 3 du plan du 2026-09-14 : l'oublier ne compile pas.
       */
      messages: {
        repondre: {
          getConversationContext: (id, tenant) => inboxStore.getConversationContext(id, tenant),
          getTenantPhoneNumberId: (tenant) => repo.getTenantPhoneNumberId(tenant),
          sendReply: async (tenant, phoneNumberId, to, text) => {
            const client = await metaFactory.clientForTenant(tenant, phoneNumberId); // token PAR TENANT (B1)
            return (await client.sendText(to, text)).messageId;
          },
          estDesabonne: (tenant, waId) => contactStore.estDesabonneParWaId(tenant, waId),
          recordOutbound: (id, body, msgId, origine, type, cat, name, sender, canal, redaction) =>
            inboxStore.recordOutbound(id, body, msgId, origine, type, cat, name, sender, canal, redaction),
          // ⚠️ `app_human` comme pour un agent tiers, et pour la même raison : ce qui compte est que le
          // scénario cesse d'avancer tout seul et que l'agent de Meta cesse de répondre, ce que cette
          // valeur produit exactement. QUI a parlé est porté par l'ORIGINE du message (`api`, 0166), là où
          // ça ne coûte aucune migration du chemin chaud.
          takeControl: async (tenant, waId) => { await inboxStore.setControlOwner(tenant, waId, 'app_human'); },
        },
        findContactByPhone: async (tenant, phone) => { const c = await contactStore.findByPhone(tenant, phone); return c ? { id: c.id } : null; },
        // LA MÊME fonction que le bouton « Ouvrir la conversation » du mini-CRM : elle refuse un contact
        // supprimé comme un contact bloqué, ce qui EST la garde de blocage de cette route.
        ouvrirConversation: (tenant, contactId) => inboxStore.ouvrirConversationDuContact(tenant, contactId),
      },
      /**
       * Serveur MCP (`POST /mcp`) : les MÊMES fonctions que la console, jamais des variantes.
       *
       * Chaque ligne ci-dessous est déjà branchée plus haut pour les routes de l'inbox et du mini-CRM. C'est
       * exactement l'intention : un outil MCP n'est qu'un second appelant. Le jour où une garde change (la
       * fenêtre de 24 h, la prise de fil, le scope tenant), elle change pour les deux d'un coup.
       */
      mcp: {
        listConversations: (tenant, opts) => inboxStore.listConversations(tenant, opts),
        getMessages: (id) => inboxStore.getMessages(id),
        getConversationContext: (id, tenant) => inboxStore.getConversationContext(id, tenant),
        getControlOwner: (tenant, waId) => inboxStore.getControlOwner(tenant, waId),
        getAssignee: (tenant, id) => inboxStore.getAssignee(tenant, id),
        setAssignee: (tenant, id, assignee, par) => inboxStore.setAssignee(tenant, id, assignee, par),
        getTenantPhoneNumberId: (tenant) => repo.getTenantPhoneNumberId(tenant),
        sendReply: async (tenant, phoneNumberId, to, text) => {
          const client = await metaFactory.clientForTenant(tenant, phoneNumberId); // token PAR TENANT (B1)
          return (await client.sendText(to, text)).messageId;
        },
        /**
         * 🔴 CE COMMENTAIRE A AFFIRME « BRANCHEE ICI ET NULLE PART AILLEURS » ET C ETAIT FAUX, avant meme le
         * lot 7 (corrige le 2026-09-23). Il disait que l exemption de l operateur tenait a l ABSENCE de
         * cette dependance sur le cablage de la console, « rendue structurelle ». Or elle y est branchee
         * depuis que l envoi de MODELE depuis l Inbox en a eu besoin, et le type l exige partout depuis le
         * 2026-09-15 : il y a TROIS branchements dans ce fichier, pas un.
         *
         * Ce qui exempte l operateur est la CONDITION, dans `repondreDansLaFenetre` : la garde ne se pose
         * que sur une origine machine. Une justification fausse est pire qu aucune parce qu elle se
         * recopie, et celle-ci l avait deja ete dans `todo.md`.
         */
        estDesabonne: (tenant, waId) => contactStore.estDesabonneParWaId(tenant, waId),
        recordOutbound: (id, body, msgId, origine, type, cat, name, sender, canal, redaction) => inboxStore.recordOutbound(id, body, msgId, origine, type, cat, name, sender, canal, redaction),
        // ⚠️ `app_human` pour un agent TIERS, et c'est un choix : `ControlOwner` n'a que trois valeurs, et ce
        // qui compte ici est que le scénario cesse d'avancer TOUT SEUL et que MBA cesse de répondre, ce que
        // `app_human` produit exactement. La distinction « qui a parlé » est portée là où elle sert et où
        // elle ne coûte pas de migration du chemin chaud : l'ORIGINE du message (`mcp`, migration 0101).
        takeControl: async (tenant, waId) => { await inboxStore.setControlOwner(tenant, waId, 'app_human'); },
        chercherContacts: (tenant, filtres, limit, offset) => contactStore.query(tenant, filtres, limit, offset),
        contactParTelephone: (tenant, phone) => contactStore.findByPhone(tenant, phone),
        ajouterTags: (tenant, waId, tags) => contactStore.addTagsByPhoneReturningNew(tenant, waId, tags),
        listerMembres: async (tenant) => (await userStore.list(tenant)).map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role })),
      },
    },
  });

  /**
   * L'attente du pool, versée en base une fois par minute (lot 7 du plan post-audit, migration 0109).
   *
   * L'API a SON pool, distinct de celui du worker : deux lignes par minute, jamais agrégées, sinon on perdrait
   * justement l'information qui dit lequel des deux souffre. Un `registreDeTaches` serait démesuré pour une
   * seule minuterie ici ; elle est donc posée à la main, `unref` (elle ne doit pas retenir le process) et
   * arrêtée dans l'arrêt propre.
   */
  const minuteriePoolAttentes = setInterval(() => {
    void viderVersLaBase(poolAttentesStore, mesureAttentePool, 'api', new Date(), (err) => {
      // eslint-disable-next-line no-console
      console.error('pool-attentes: écriture impossible (migration 0109 passée ?):', err instanceof Error ? err.message : err);
    });
  }, 60_000);
  minuteriePoolAttentes.unref?.();

  installGracefulShutdown(async () => {
    clearInterval(minuteriePoolAttentes);
    await app.close();
    await queue.stop();
    await pool.end();
  });
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  // eslint-disable-next-line no-console
  console.log(`messagingme-mba api en écoute sur :${config.PORT}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
