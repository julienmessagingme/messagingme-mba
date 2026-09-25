import './charger-env';
import { config } from './config';
import { PgBossQueue } from './queue/pgboss';
import { pool, mesureAttentePool } from './db/pool';
import { PgTrackedLinkStore } from './links/tracked-links.pg';
import { fabriquerJeton } from './links/jeton-contact';
import { PgAuditStore } from './audit/store.pg';
import { PgTestRunStore } from './agent/test-runs.pg';
import { RETENTION_ESSAIS_JOURS } from './agent/test-runs';
import { PgWorkflowNodeEventStore } from './workflow/node-events.pg';
import { PgConversationStatsStore } from './stats/conversation-stats.pg';
import { todayParis, addDays } from './stats/range';
import { handleWebhookJob } from './webhooks/handler';
import { PgEventStore } from './webhooks/store';
import {
  PgCampaignRepo,
  PgCampaignStore,
  PgRecipientStore,
  PgQualityProvider,
} from './campaign/store.pg';
import { campaignRunJob, type CapacitesMoteur } from './campaign/run-job';
import { PgCampaignRunLock } from './campaign/run-lock';
import { runCampaignScheduleSweep } from './campaign/schedule-sweep';
import { runCampaignRepriseSweep } from './campaign/reprise-sweep';
import { runWorkflowWakeSweep } from './workflow/wake-sweep';
import { runTourBloqueSweep } from './agent/tour-bloque-sweep';
import { SORTIE_ECHEC } from './agent/sorties';
import { runRetrySweep } from './campaign/retry-sweep';
import { fenetreDeRattrapageOuverte } from './lib/heures-ouvrees';
import { creerNoteurJoignabilite } from './contacts/joignabilite.pg';
import { creerNoteurEnvois } from './campaign/envois.pg';
import { alimenterCampagnesWebhook, type WebhookFeedDeps } from './campaign/webhook-feed';
import { assignerReponse } from './inbox/assignation-campagne';
import { relanceurDeCampagnes } from './campaign/enqueue';
import { plafondDuCanal, plafondLePlusBas } from './campaign/pacing';
import { flagContactUnreachable } from './crm/hubspot-service';
import { PgApiIdempotencyStore } from './api/idempotency-store.pg';
import { DUREE_CLE_IDEMPOTENCE_MS } from './api/idempotence';
import { PgInboxStore } from './inbox/store.pg';
import { PgArriveesPubStore } from './pubs/arrivees.pg';
import { PgTarifsMetaStore } from './pubs/tarifs-meta.pg';
import { PgPublicitesStore } from './pubs/publicites.pg';
import { PgPubConnexionStore } from './pubs/connexion.pg';
import { MetaPubsClient } from './meta/pubs';
import { MetaPubsCreationClient } from './meta/pubs-creation';
import { balayerLesPubs } from './pubs/suivi';
import { estJetonRefuse } from './meta/graph';
import { PgTenantSettingsStore } from './settings/store.pg';
import { runControlSweep } from './inbox/control-sweep';
import { runHandoffSweep } from './mba/handoff-sweep';
import { lireHandoffEnabled, ecrireHandoffEnabled } from './mba/handoff';
import { PgFlowStore } from './flow/store.pg';
import { PgContactStore } from './crm/contact-store.pg';
import { SOURCE_STOP_WHATSAPP } from './crm/consentement';
import { PgUserFieldStore } from './crm/field-store.pg';
import {
  ensureFieldByKey,
  CTWA_AD_ID_FIELD_KEY, CTWA_AD_ID_FIELD_LABEL, CTWA_AD_TITLE_FIELD_KEY, CTWA_AD_TITLE_FIELD_LABEL,
} from './crm/fields';
import { PgWorkflowStore, grapheEditable } from './workflow/store.pg';
import { blocDesigne } from './workflow/test-token';
import { PgAutomationStore } from './automation/store.pg';
import { runAutomations } from './automation/runner';
import { PgWebhookStore } from './webhook-entrant/store.pg';
import { runDateSweep } from './automation/date-sweep';
import { balayerRisque, jourABalayer } from './engagement/balayage';
import { depsBalayageRisque } from './engagement/cablage';
import { AUTOMATION_EVENT_QUEUE, enfilerEvenementAutomation, parseAutomationEventJob, type AutomationEventJob } from './automation/event-job';
import type { AutomationTriggerKind } from './automation/match';
import { buildWorkflowRuntime } from './workflow/wiring';
import { AGENT_TURN_QUEUE, parseAgentTurnJob } from './agent/turn-job';

/** Messages de conversation donnés au cerveau à chaque tour. Borné : le contexte se paie à CHAQUE appel de
 *  modèle, et un fil bavard ferait payer au client une conversation qu'il a déjà réglée. */
const MESSAGES_DE_CONTEXTE = 30;
import { runTurn, type RunTurnDeps } from './agent/run-turn';
import { PgAgentStore } from './agent/agent-store.pg';
import { PgToolCatalog, PgJournalAppels } from './agent/catalog.pg';
import { PgKnowledgeStore } from './agent/knowledge.pg';
import { balayerVectorisation, creerRechercheSemantique } from './agent/recherche';
import { PgDepotAide } from './aide/fiches.pg';
import { GatewayChatClient } from './agent/llm/chat-client';
import { creerCerveauGateway } from './agent/brain.gateway';
import { PgCleGatewayStore } from './agent/cles-gateway.pg';
import { lireContexteAvecReglages } from './agent/contexte';
import { PgCreditStore } from './agent/credits.pg';
import { PgSourceStore } from './agent/sources.pg';
import { PgRequeteStore } from './agent/requetes.pg';
import { creerAnnonceOptOut, creerTravailPousseeOptOut, FILE_POUSSEE_OPTOUT } from './crm/poussee-optout';
import { cacheCourt } from './lib/cache-court';
import { PgIntegrationBatchStore } from './signaux/integration-batch.pg';
import { PgSignauxStore } from './signaux/store.pg';
import { completerSignal } from './signaux/completer';
import {
  creerEmetteur, creerPuitsSignauxMeta, annoncerAussiAuxSignaux, signalAnalyse, DUREE_CACHE_ESPACES_ACTIFS_MS,
} from './signaux/emetteur';
import { FILE_SIGNAUX_BATCH, pousserVersBatch } from './signaux/batch';
import { creerTravailSignauxBatch } from './signaux/travail-batch';
import { creerResolveurHttp } from './agent/resolvers/http';
import { creerResolveurMcp } from './agent/resolvers/mcp';
import { creerResolveurMba } from './agent/resolvers/mba';
import { creerEscaladeVersHumain } from './agent/escalade';
import { PgEmailAccountStore } from './email/account-store.pg';
import { PgEmailTemplateStore } from './email/template-store.pg';
import { EmailAccountResolver } from './email/resolver';
import { buildTransport as buildEmailTransport } from './email/smtp';
import { PgConversationAnalysisStore } from './analysis/store.pg';
import { analyzeConversationJob } from './analysis/job';
import { runAnalysisSweep } from './analysis/sweep';
import { AnthropicClient } from './analysis/llm-client';
import { getEnrichment } from './analysis/enrichment';
import { pushAnalysisJob } from './analysis/push-job';
import { hubspotCatchupJob } from './analysis/catchup-job';
import { makeOnAnalyzed, postAnalysis } from './analysis/connector-push';
import { PgPhoneStatusStore } from './account/store.pg';
import { PgNumeroDelieStore } from './account/numero-delie.pg';
import { creerGardeNumeroDelie } from './meta/numero-delie';
import { pullFromInfo, pullFromError } from './account/pull';
import { creerNoteDeQualite } from './campaign/note-qualite';
import { creerNumeroDeLEspace } from './meta/numero-espace';
import { runPhoneStatusSweep, type PhoneProblem } from './account/status-sweep';
import { PgOpsStore } from './ops/store.pg';
import { PgErreursLivraisonStore } from './ops/erreurs-livraison.pg';
import { PgEchecsMessagesStore } from './delivery/echecs-messages.pg';
import { PgPoolAttentesStore, viderVersLaBase } from './ops/pool-attentes.pg';
import { creerDlqSweep } from './ops/dlq-sweep';
import { creerWebhooksMuetsSweep } from './ops/webhooks-muets-sweep';
import { MetaClientFactory } from './meta/factory';
import { arbitreDeDebit } from './meta/arbitre-debit';
import { arbitreDeDebitPartage, depsPorteDebitPg } from './meta/arbitre-debit-partage';
import { MetaCredentialsResolver } from './meta/credentials';
import { PgEmbeddedSignupStore } from './account/es-store.pg';
import { decryptSecret, encryptSecret } from './crypto/secretbox';
import { FetchTransport } from './meta/http';
import { DryRunSender } from './campaign/dry-run-sender';
import type { MessageSender } from './campaign/engine';
import type { Campaign } from './campaign/types';
import { PgWorkerHeartbeatStore } from './ops/heartbeat-store.pg';
import { sendTelegram } from './ops/telegram';
import { installGracefulShutdown } from './shutdown';
import { registreDeTaches } from './worker/taches';
import { tenter } from './lib/tenter';
import { messageDe, texteDe } from './lib/erreur';

async function main(): Promise<void> {
  // Le worker est la SEULE instance qui supervise (défaut pg-boss conservé) : c'est lui qui dépile, donc lui qui
  // doit récupérer les jobs expirés. `flowIntervalSeconds: 60` espace la maintenance « flow » (défaut 5 s), qui ne
  // sert ici aucun chemin sensible : ce projet n'utilise pas de jobs bloquants/parents. Gain mesuré : ~16 000
  // requêtes/jour de moins sur une base Supabase facturée à l'egress.
  // `ecouteNotifications: true` : le worker est la SEULE instance qui dépile, donc la seule qui a besoin d'être
  // réveillée. L'API ne fait qu'empiler, un écouteur y consommerait une connexion dédiée pour rien : c'est le
  // même raisonnement que la supervision, coupée de son côté. Ce qui se joue ici est le plafond de débit des
  // entrants mesuré le 2026-09-02 : sans réveil, une rafale se vide à la cadence de l'horloge, pas à celle du
  // traitement.
  const queue = new PgBossQueue(config.DATABASE_URL, config.PGBOSS_SCHEMA, {
    max: config.PGBOSS_MAX,
    connectionTimeoutMillis: config.DB_CONN_TIMEOUT_MS,
    flowIntervalSeconds: 60,
    ecouteNotifications: true,
  });
  // L'enfilement d'un run de campagne au débit RÉSOLU, partagé par les cinq chemins de relance du worker.
  const relancerCampagne = relanceurDeCampagnes(queue, config);

  // Alerte Telegram throttlée (mémoire process) sur les signaux d'erreur d'un worker VIVANT. Le cas « worker
  // MORT » (crash-loop au boot) n'est VOLONTAIREMENT pas auto-alerté ici : un process qui meurt ne peut pas
  // throttler ses alertes entre redémarrages (la map en mémoire est perdue à chaque restart) -> il spammerait
  // le chat. Ce cas est couvert par la STALENESS du heartbeat (worker_heartbeat.beat_at qui cesse d'avancer),
  // lue par /ops et le cron watcher (qui, lui, déduplique via son fichier d'état).
  const ALERT_THROTTLE_MS = 5 * 60_000;
  const lastAlertAt = new Map<string, number>();
  const alert = (key: string, text: string): void => {
    const now = Date.now();
    const prev = lastAlertAt.get(key);
    if (prev !== undefined && now - prev < ALERT_THROTTLE_MS) return;
    lastAlertAt.set(key, now);
    void sendTelegram(`[mba-worker] ${text}`); // no-op si TELEGRAM_* absent, ne throw jamais
  };

  // Idem côté worker, et c'est ici que ça comptait le plus : le worker est le SEUL composant qui envoie les
  // messages, et un event `error` non capté le tuait pendant que l'API continuait de répondre 200 sur /health.
  queue.onError((err) => {
    const msg = texteDe(err);
    // eslint-disable-next-line no-console
    console.error('[pg-boss:worker]', msg);
    alert('pgboss', `erreur pg-boss : ${msg}`);
  });

  // L'écouteur de notifications peut ne pas s'établir (connexion coupée, pooler en mode transaction). pg-boss
  // le signale par un AVERTISSEMENT et retombe sur le sondage seul, ce qui reste correct mais rend les entrants
  // deux fois plus lents à démarrer. Un repli muet serait pire que le repli lui-même : on croirait l'écouteur
  // actif. On le journalise et on ALERTE, au même titre qu'une erreur.
  queue.onWarning((avertissement) => {
    const msg = avertissement instanceof Error ? avertissement.message : JSON.stringify(avertissement);
    // eslint-disable-next-line no-console
    console.warn('[pg-boss:worker] avertissement', msg);
    alert('pgboss-avertissement', `avertissement pg-boss : ${msg}`);
  });
  await queue.start();

  // Heartbeat worker (item 4.9) : le worker est le seul process qui envoie, et rien ne prouvait qu'il vit.
  // Il écrit un signal de vie best-effort ; /ops/overview en lit l'âge. Prouve que le PROCESS tourne (event loop
  // non bloqué), PAS que pg-boss dépile — pour « files gelées » c'est le backlog de /ops qui sert.
  const heartbeatStore = new PgWorkerHeartbeatStore(pool);
  const instanceId = `${process.env.HOSTNAME ?? 'host'}:${process.pid}`;
  const beat = async (boot: boolean): Promise<void> => {
    try {
      await heartbeatStore.beat(instanceId, boot);
    } catch (err) {
      // best-effort ABSOLU : une écriture heartbeat qui throw tuerait le worker. On log, on continue.
      // eslint-disable-next-line no-console
      console.error('heartbeat erreur (best-effort):', messageDe(err));
    }
  };
  await beat(true);
  // Registre des tâches périodiques : programmer et arrêter deviennent le MÊME geste. Avant, dix-sept
  // minuteries étaient arrêtées une par une dans l'arrêt propre, et trois y avaient déjà échappé.
  const taches = registreDeTaches();
  taches.programmer('heartbeat', config.HEARTBEAT_INTERVAL_MS, () => beat(false));
  /**
   * L'échec d'un balayage, au format de TOUS les balayages : `<journal> erreur: <message>` dans les journaux,
   * puis l'alerte throttlée `<texte> en échec : <message>` sous sa clé. Passé à `programmer` (`enEchec`).
   */
  const echecDeBalayage = (journal: string, cle: string, texte = journal) => (err: unknown): void => {
    // eslint-disable-next-line no-console
    console.error(`${journal} erreur:`, messageDe(err));
    alert(cle, `${texte} en échec : ${messageDe(err)}`);
  };

  /**
   * L'attente du pool, versée en base une fois par minute (lot 7 du plan post-audit, migration 0109).
   *
   * 🔴 C'est le SEUL canal par lequel ce process peut se montrer : `/ops` est servi par l'API, qui voit son
   * propre pool en mémoire et jamais celui du worker. Best-effort de bout en bout, une mesure ne doit jamais
   * faire tomber ce qu'elle mesure.
   */
  const poolAttentes = new PgPoolAttentesStore(pool);
  taches.programmer('pool-attentes', 60_000, async () => {
    await viderVersLaBase(poolAttentes, mesureAttentePool, 'worker', new Date(), (err) => {
      // eslint-disable-next-line no-console
      console.error('pool-attentes: écriture impossible:', messageDe(err));
    });
  });

  // File webhook (Loop 1). Le PgRecipientStore applique les statuts de livraison ; le
  // PgInboxStore enregistre les messages entrants (réponses / taps de boutons) en conversations ;
  // le report Flow -> user fields (flowStore.findByRef + contactStore.mergeFieldsByPhone) est ISOLÉ
  // dans handleWebhookJob (ne fait jamais échouer le job partagé avec les statuts).
  const eventStore = new PgEventStore(pool);
  const recipientStore = new PgRecipientStore(pool);
  const inboxStore = new PgInboxStore(pool);
  // Lot 1 des publicités Click-to-WhatsApp : ce qui se perd si on ne le garde pas à la réception.
  const arriveesPubStore = new PgArriveesPubStore(pool);
  const tarifsMetaStore = new PgTarifsMetaStore(pool);
  // Lot 3 : où va le lead. Les deux dépôts se lisent sur le chemin chaud d'un message entrant (deux requêtes
  // sur clé), le client Meta ne sert qu'à résoudre une publicité JAMAIS VUE, une fois, puis on mémorise.
  const publicitesStore = new PgPublicitesStore(pool);
  const connexionsPubStore = new PgPubConnexionStore(pool);
  const clientPubs = new MetaPubsClient(config.META_APP_ID, config.META_APP_SECRET, config.META_GRAPH_VERSION);
  // Le client qui PILOTE les publicites : il lit leurs statuts et leur depense pour le balayage du suivi.
  const clientPubsCreation = new MetaPubsCreationClient(config.META_APP_ID, config.META_APP_SECRET, config.META_GRAPH_VERSION);
  /**
   * LA CADENCE DU SUIVI, en millisecondes.
   *
   * 🔴 QUINZE MINUTES, ET CE N'EST PAS UN NOMBRE CHOISI PAR NOUS : c'est la cadence a laquelle Meta
   * rafraichit lui-meme la depense d'une campagne (spec, « Ce que dit Meta »). Interroger plus souvent
   * relirait le MEME chiffre en consommant du quota sur un compte en niveau « Limited ».
   *
   * ⚠️ PAS DE VARIABLE D'ENVIRONNEMENT, delibere : un reglage se derege, et celui-ci n'a aucune raison
   * de varier d'une instance a l'autre puisqu'il decrit le comportement d'un TIERS.
   */
  const SUIVI_PUBS_INTERVALLE_MS = 15 * 60 * 1000;
  // Le journal des erreurs. Le worker n'en LIT jamais : il y écrit les échecs d'avance de scénario, qui
  // n'avaient aucun domicile et disparaissaient dans un `console.error` (lot 4 du plan post-audit).
  const erreursLivraison = new PgErreursLivraisonStore(pool);
  // Les échecs de livraison des MESSAGES LIBRES (lot 3 de l'API publique, migration 0175) : écrits par les
  // deux files qui voient des accusés, purgés par le balayage de rétention.
  const echecsMessages = new PgEchecsMessagesStore(pool);
  const settingsStore = new PgTenantSettingsStore(pool);
  const flowStore = new PgFlowStore(pool);
  /**
   * LES SIGNAUX (spec 2026-09-24, § 8) : ce que la console remonte vers l'outil d'un client.
   *
   * 🔴 L'ÉMETTEUR EST CONSTRUIT AVANT LE DÉPÔT DES CONTACTS, qui l'appelle à chaque désabonnement. Il ne
   * connaît aucun outil : chaque adaptateur est une DESTINATION (sa file, ses espaces actifs lus à travers
   * un cache court, qui rattrape un branchement fait depuis l'écran en une minute au plus).
   */
  const integrationBatch = new PgIntegrationBatchStore(pool);
  const espacesBatch = cacheCourt<ReadonlySet<string>>(DUREE_CACHE_ESPACES_ACTIFS_MS);
  const emetteur = creerEmetteur({
    destinations: [{ file: FILE_SIGNAUX_BATCH, espacesActifs: () => espacesBatch.lire('actifs', () => integrationBatch.espacesActifs()) }],
    enfiler: (file, job, opts) => queue.enqueue(file, job, opts),
    // eslint-disable-next-line no-console
    log: (m) => console.warn(m),
  });
  /**
   * Le numéro Meta -> son espace, pour les ACCUSÉS, qui ne portent que le numéro. Consulté seulement quand un
   * espace au moins a branché un outil. ⚠️ Seules les réponses POSITIVES restent en cache : une réponse nulle
   * deviendrait fausse à l'instant où un client branche son premier numéro (leçon de `src/meta/numero-espace.ts`).
   */
  const espaceDuNumero = cacheCourt<string | null>(5 * 60_000);
  const puitsSignaux = creerPuitsSignauxMeta({
    emetteur,
    tenantDuNumero: async (pnid) => {
      const t = await espaceDuNumero.lire(pnid, () => inboxStore.phoneNumberTenant(pnid));
      if (t === null) espaceDuNumero.invalider(pnid);
      return t;
    },
  });
  /**
   * 🔴 LA MEME ANNONCE QUE COTE API, ET C'EST OBLIGATOIRE. Le mot-cle « stop » d'un message entrant est
   * traite ICI, dans le worker : monter l'annonce uniquement cote API aurait couvert la fiche contact et
   * l'action en masse, et laisse le chemin le plus important, celui ou la personne elle-meme refuse, muet.
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
  // Sert à déclarer les champs « Pub » la première fois qu'un contact arrive par une publicité : sans
  // définition, la valeur serait écrite mais invisible dans le CRM, donc infiltrable et insegmentable.
  const fieldStore = new PgUserFieldStore(pool);
  const auditStore = new PgAuditStore(pool);
  const essaisStore = new PgTestRunStore(pool);
  const nodeEventStore = new PgWorkflowNodeEventStore(pool);
  // Instancié ICI pour le seul balayage de rétention des clics (lot 4) : l'API a le sien, et ces stores ne
  // sont que des enveloppes autour du pool partagé.
  const trackedLinkStore = new PgTrackedLinkStore(pool);
  const repo = new PgCampaignRepo(pool);
  const transport = new FetchTransport();
  const dryRun = config.DRY_RUN === 'true';

  // Résolution du token Meta PAR TENANT (B1). En SOMMEIL tant qu'aucun WABA n'a de credentials propres : le
  // résolveur retombe alors sur config.META_ACCESS_TOKEN -> comportement identique au token global d'avant.
  // Le WABA de l'espace, UNE lecture par process au lieu d'une par construction de client Meta : le cache de
  // jeton est indexe par WABA, donc cette requete-la etait payee AVANT lui, a chaque envoi. Seules les
  // reponses positives entrent en cache (voir le module).
  const wabaDeLEspace = creerNumeroDeLEspace((t) => repo.getTenantWabaId(t));
  const qualiteStore = new PgQualityProvider(pool);
  const noteDeQualite = creerNoteDeQualite((pn) => qualiteStore.getRating(pn));
  const esStore = new PgEmbeddedSignupStore(pool);
  const phoneStatusStore = new PgPhoneStatusStore(pool);
  // Le numéro délié (migration 0180) : la garde des envois (mise en cache, `NUMERO_DELIE_TTL_MS`) et l'écart
  // des entrants du webhook (lu à chaque lot, sans cache : une lecture par clé primaire).
  const numeroDelieStore = new PgNumeroDelieStore(pool);
  const gardeNumeroDelie = creerGardeNumeroDelie((pn) => numeroDelieStore.estDelie(pn));
  const metaCredentials = new MetaCredentialsResolver({
    getWabaIdForTenant: wabaDeLEspace,
    getCredentialsByWaba: (w) => esStore.getCredentialsByWaba(w),
    markTokenInvalid: (w) => esStore.markTokenInvalid(w),
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
    numeroDelie: (pn) => gardeNumeroDelie.estDelie(pn),
  });

  // Exécuteur de workflows : quand un contact répond, on avance son run (blocs tag/field/template -> inbox).
  const workflowStore = new PgWorkflowStore(pool);
  const automationStore = new PgAutomationStore(pool);

  // Node « Envoi de mail » : boîtes SMTP + modèles (scopés tenant), résolveur de transport à cache PAR PROCESS
  // (comme metaCredentials/metaFactory ci-dessus, l'API a le sien dans index.ts). L'invalidation posée par les
  // routes email (process API) ne traverse donc pas jusqu'ici : un compte modifié y garde son ancien transport
  // jusqu'au prochain redémarrage du worker, écart déjà assumé pour les autres caches de ce module.
  const emailAccounts = new PgEmailAccountStore(pool);
  const emailTemplates = new PgEmailTemplateStore(pool);
  const emailResolver = new EmailAccountResolver({
    getDecrypted: (t, id) => emailAccounts.getDecrypted(t, id),
    buildTransport: buildEmailTransport,
  });

  // Exécuteur de scénarios + ce qui l'accompagne. Câblage PARTAGÉ avec l'API (`workflow/wiring.ts`) : elle
  // doit lancer un scénario depuis l'Inbox avec exactement la même sémantique. Un second câblage recopié
  // serait le troisième doublon de cette famille, après le constructeur de composants Meta et la préparation
  // des visuels de carousel, qui ont chacun cassé la prod le 2026-08-15.
  const {
    executor: workflowExecutor, runStore, templateVarInfo, prepareCarouselMedia, prepareHeaderMedia, buildEvalContext, rcsStack,
    releaseThreadChezMeta, remiseMbaSurAccuse, remiseMbaSiPersonneNeSuit, reprendreLeFilPourLApp, agentSessions, envoyerTexteAgent, poserTagDepuisAgent,
  } = buildWorkflowRuntime({
    pool, queue, dryRun, repo, contactStore, inboxStore, settingsStore, workflowStore, metaCredentials, metaFactory,
    rcsProvider: config.RCS_PROVIDER,
    emailTemplates, emailResolver,
  });

  /**
   * La mémoire de joignabilité WhatsApp d'un contact (migration 0133), écrite par ses DEUX sources.
   *
   * ⚠️ UN SEUL NOTEUR POUR LES DEUX, et c'est délibéré : le moteur de campagne pose le « oui » sur un envoi
   * accepté, le balayage de relance pose le « non » au second échec 131026. Deux fabrications séparées
   * seraient deux endroits où la requête peut diverger, alors que la péremption suppose une date posée de la
   * même façon des deux côtés.
   */
  const noterJoignabiliteContact = creerNoteurJoignabilite(pool);
  const noterEnvoiCampagne = creerNoteurEnvois(pool);

  /**
   * Campagnes AU FIL DE L'EAU : un contact arrive par un webhook entrant, il devient destinataire des
   * campagnes vivantes qui s'en nourrissent, et le run part. Aucun chemin d'envoi propre : on INSCRIT, puis
   * `runCampaign` fait le reste avec sa cadence et ses garde-fous.
   */
  const webhookFeedDeps: WebhookFeedDeps = {
    listRunning: (tenant, webhookId) => repo.listRunningByWebhook(tenant, webhookId),
    contact: (tenant, waId) => repo.contactForBuildByWaId(tenant, waId),
    insertRecipient: (campaignId, r) => repo.insertWebhookRecipient(campaignId, r),
    // Un seul arrivant enfilé : `pendingCount` à 1 suffit à dimensionner l'expiration du job, et le débit
    // résolu est le MÊME que celui du run réel (sinon pg-boss rejouerait le job en parallèle).
    enqueueRun: (c) => relancerCampagne({ campaignId: c.id, tenantId: c.tenantId, pendingCount: 1, ratePerMinute: c.ratePerMinute }),
  };

  // Automations (Lot E) : un événement (message entrant) démarre un scénario. Réutilise TEL QUEL l'exécuteur
  // ci-dessus, donc hérite gratuitement de ses gardes (fil détenu par un humain/MBA, ouverture hors fenêtre 24 h).
  const automationRunnerDeps = {
    // Contact bloqué : son message est enregistré et lisible, mais il ne déclenche plus aucun scénario.
    contactBloque: (tenant: string, waId: string) => contactStore.isBlockedByWaId(tenant, waId),
    listEnabled: (tenant: string, kinds: readonly AutomationTriggerKind[]) => automationStore.listEnabled(tenant, kinds),
    lastFiredAt: (id: string, waId: string) => automationStore.lastFiredAt(id, waId),
    markFired: (id: string, waId: string, marqueur?: string) => automationStore.markFired(id, waId, marqueur),
    clearFired: (id: string, waId: string) => automationStore.clearFired(id, waId),
    firedSince: (id: string, since: Date) => automationStore.firedSince(id, since),
    maxFiresPerHour: config.AUTOMATION_MAX_FIRES_PER_HOUR,
    evalContext: buildEvalContext,
    startWorkflow: async (tenant: string, workflowId: string, waId: string, opts: {
      startNodeId: string | null; windowOpen: boolean; reprendLaMain: boolean;
    }) => {
      const wf = await workflowStore.getById(workflowId, tenant);
      if (!wf) return false;
      // Le contact existe déjà (l'upsert d'inbound a tourné juste avant) : on relie le run à sa fiche si on la trouve.
      const contactId = await contactStore.findIdByWaId(tenant, waId);
      const contact = { waId, contactId };
      // Démarrage UNITAIRE (un contact, sur un événement) : les tags posés par ce parcours publient à leur
      // tour, contrairement à une campagne. L'anti-rebond du runner borne l'enchaînement.
      //
      // 🔴 `ignoreHumanControl` N'EST PAS POSÉ POUR TOUTES LES AUTOMATIONS, seulement pour celles qui
      // naissent d'un geste EXPLICITE du contact : un BOUTON DE CHAÎNE, et depuis le lot 3 des publicités un
      // CLIC SUR UNE PUBLICITÉ. Le runner a déjà tranché (`reprendLaMain`). Le poser partout ferait écrire un
      // scénario dans le fil d'un client pendant qu'un opérateur lui répond, sur n'importe quel mot-clé.
      // `tests/campagne-controle-humain.test.ts` garde les DEUX sens de cette distinction.
      const unitaire = { emitEvents: true, ignoreHumanControl: opts.reprendLaMain };
      if (opts.startNodeId) return workflowExecutor.startFromNode(tenant, workflowId, wf.graph, contact, opts.startNodeId, unitaire);
      // Fenêtre PROUVÉE ouverte (le contact vient d'écrire) -> le scénario peut ouvrir par un message rapide ou
      // un formulaire, ce que le Lot D a rendu possible et que l'écran Automation annonce. Sinon, garde normale.
      return opts.windowOpen
        ? workflowExecutor.startInWindow(tenant, workflowId, wf.graph, contact, unitaire)
        : workflowExecutor.start(tenant, workflowId, wf.graph, contact, undefined, unitaire);
    },
    defaultCooldownSeconds: config.AUTOMATION_COOLDOWN_SECONDS,
  };

  // File `automation-event` (E.2) : les événements qui ne viennent PAS du webhook (tag posé depuis l'API,
  // analyse de conversation terminée). L'API ne sait pas démarrer un scénario, elle publie ; le worker exécute.
  // Un payload inexploitable est ignoré proprement plutôt que de faire boucler la file jusqu'à la DLQ.
  // ⚠️ Cette file reste à UN job en vol, donc ses événements sont ordonnés par construction. Le jour où on lui
  // donne de la concurrence (lot 8, ou une charge qui l'exige), il faudra poser une clé de groupe
  // `tenant:waId` à l'ENFILEMENT, sur les six sites qui publient ici — sinon deux événements du même contact
  // démarreraient deux scénarios en parallèle. Les deux se posent ensemble, comme sur la file des entrants.
  await queue.work(AUTOMATION_EVENT_QUEUE, async (data) => {
    const job = parseAutomationEventJob(data);
    if (!job) {
      // eslint-disable-next-line no-console
      console.error('automation-event: payload inexploitable, ignoré');
      return;
    }
    await runAutomations(job.tenantId, job.event, automationRunnerDeps);

    // Second consommateur du MÊME événement : les campagnes AU FIL DE L'EAU nourries par ce webhook. Elles
    // sont indépendantes du scénario (une adresse peut alimenter les deux, ou seulement l'un des deux), d'où
    // l'appel séparé plutôt qu'une branche dans `runAutomations`, qui ne sait rien des campagnes.
    //
    // Isolé dans son propre try : un souci de campagne ne doit pas faire échouer l'événement, donc rejouer le
    // scénario déjà démarré. Une campagne perdue se rattrape au balayage (destinataires en attente), un
    // scénario démarré deux fois ne se rattrape pas.
    /**
     * TROISIÈME CONSOMMATEUR DU MÊME ÉVÉNEMENT : la QUALIFICATION d'un lead publicitaire (lot 3, spec § 3.4).
     *
     * 🔴 POURQUOI ICI ET PAS DANS UNE BRANCHE DE `runAutomations`. Poser un tag et démarrer un scénario sont
     * deux effets indépendants du même fait : un espace peut vouloir l'un, l'autre, ou les deux. Le runner
     * ne sait rien des publicités, et lui apprendre les campagnes le rendrait dépendant d'un domaine qui ne
     * le regarde pas, exactement comme pour les campagnes au fil de l'eau juste en dessous.
     *
     * ⚠️ ISOLÉ DANS SON PROPRE `try`, pour la même raison que sa voisine : une qualification ratée ne doit
     * pas faire échouer l'événement, donc rejouer un scénario DÉJÀ démarré. Un compteur d'entonnoir en
     * retard se rattrape en regardant la conversation ; un scénario parti deux fois, non.
     *
     * ⚠️ ELLE NE VOIT QUE LES CHEMINS UNITAIRES, et c'est voulu : l'action en masse, l'import CSV et l'outil
     * MCP n'émettent pas `tag_added` (invariant du dépôt : un chemin de masse n'émet jamais), donc ils ne
     * qualifient personne. L'écran de la publicité le dit.
     */
    if (job.event.kind === 'tag_added') {
      try {
        const campagne = await arriveesPubStore.qualifier(job.tenantId, job.event.waId, job.event.tag);
        // eslint-disable-next-line no-console
        if (campagne !== null) console.log(`qualification pub : lead qualifié sur la campagne ${campagne}`);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('qualification pub : échec', messageDe(err));
      }
    }

    if (job.event.kind === 'webhook') {
      try {
        const r = await alimenterCampagnesWebhook(job.tenantId, job.event.webhookId, job.event.waId, webhookFeedDeps);
        // eslint-disable-next-line no-console
        if (r.inscrits > 0 || r.ecartes > 0) console.log(`webhook-feed: ${r.inscrits} inscrit(s), ${r.ecartes} écarté(s), ${r.deja} déjà destinataire(s)`);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('webhook-feed: échec', messageDe(err));
        alert('webhook-feed', `alimentation d'une campagne au fil de l'eau en échec : ${messageDe(err)}`);
      }
    }
    // Groupe = l'ESPACE (lot 6 du plan post-audit). Une rafale d'automations d'un client gelait tous les
    // autres : cette file traitait UN job à la fois pour la flotte entière. Les deux options vont ensemble,
    // `groupConcurrency` étant un no-op tant que `concurrency` vaut 1.
  }, { concurrency: config.AUTOMATION_EVENT_CONCURRENCY, groupConcurrency: 1 });

  await queue.work('webhook', async (data) => {
    await handleWebhookJob(data, {
      store: eventStore,
      delivery: recipientStore,
      /**
       * 🔴 LES DEUX FILES QUI VOIENT DES STATUTS LA REÇOIVENT, celle-ci et `webhook-status`. Un accusé peut
       * arriver par l'une ou par l'autre selon le lot que Meta nous envoie : la câbler sur une seule ferait
       * dépendre la remise du fil d'un découpage qui ne nous appartient pas. C'est le motif « une capacité
       * câblée sur un consommateur sur deux », déjà payé plusieurs fois dans ce dépôt.
       */
      remiseMba: remiseMbaSurAccuse,
      // 🔴 SUR LES DEUX FILES qui voient des accusés, pour la raison écrite juste au-dessus : le tarif est la
      // seule source de « Meta ne facture pas ce message ».
      tarifsMeta: tarifsMetaStore,
      // 🔴 SUR LES DEUX FILES qui voient des accusés, comme le tarif : un échec arrive par l'une ou par l'autre.
      echecsLibres: echecsMessages,
      // 🔴 LES SIGNAUX (spec 2026-09-24, § 8), SUR LES DEUX FILES qui voient des accusés, pour la raison écrite
      // au-dessus de `remiseMba` ; la réponse, elle, n'arrive que par celle-ci.
      signauxAccuse: puitsSignaux.accuse,
      signalReponse: puitsSignaux.reponse,
      /**
       * 🔴 SUR CETTE FILE ET PAS SUR L'AUTRE, contrairement à `remiseMba` juste au-dessus. Un message
       * ENTRANT n'arrive jamais par `webhook-status` : le receveur n'y route que les lots d'accusés purs.
       * La câbler là-bas serait un câblage mort, et la câbler ici est le seul endroit où elle voit ce
       * qu'elle attend.
       */
      remiseMbaEntrant: {
        phoneNumberTenant: (pnid) => inboxStore.phoneNumberTenant(pnid),
        remettre: (t, waId) => remiseMbaSiPersonneNeSuit(t, waId),
      },
      inbox: inboxStore,
      // Les entrants d'un numéro délié (migration 0180) sont écartés AVANT tout, sur cette file seulement : la
      // file des accusés n'en reçoit jamais, et les accusés, eux, sont gardés. SANS cache, délibérément : une
      // lecture par clé primaire par lot, et « Relier » prend effet au message suivant.
      numerosDelies: (ids) => numeroDelieStore.numerosDelies(ids),
      // L'arrivée publicitaire (`ctwa_clid` compris) : un message ENTRANT n'arrive que par cette file.
      arriveesPub: {
        phoneNumberTenant: (pnid) => inboxStore.phoneNumberTenant(pnid),
        enregistrer: (t, w, a) => arriveesPubStore.enregistrer(t, w, a),
      },
      /**
       * OÙ VA CE LEAD (lot 3). Sur CETTE file seulement, pour la même raison que l'arrivée qu'il annote : un
       * message entrant n'arrive jamais par `webhook-status`.
       *
       * 🔴 LES DEUX MOITIÉS VONT ENSEMBLE, et le type l'impose (`WebhookJobDeps`). Écrire l'arrivée sans
       * router le lead ne produirait aucune erreur : la ligne serait là, et chaque lead partirait dans les
       * automations ordinaires, y compris ceux d'une pub qui confie ses leads à l'agent de Meta.
       */
      routagePub: {
        phoneNumberTenant: (pnid) => inboxStore.phoneNumberTenant(pnid),
        campagneConnue: (t, adId) => publicitesStore.campagneConnue(t, adId),
        resoudreChezMeta: async (t, adId) => {
          // Sans connexion publicitaire, rien à demander : l'espace n'a pas de jeton, et un appel anonyme
          // serait refusé. La campagne reste inconnue, donc le chemin ordinaire, comme avant ce lot.
          const chiffre = await connexionsPubStore.lireJetonChiffre(t);
          if (chiffre === null) return null;
          const campagneId = await clientPubs.campagneDeLaPub(adId, decryptSecret(chiffre, config.ENCRYPTION_KEY));
          // ⚠️ ON NE MÉMORISE QUE LES SUCCÈS. Écrire un échec figerait une panne réseau en verdict permanent,
          // et le lead suivant de la même publicité n'aurait plus aucune chance d'être routé.
          if (campagneId !== null) await publicitesStore.memoriserPub(t, adId, campagneId);
          return campagneId;
        },
        publiciteDeLaCampagne: (t, campagneId) => publicitesStore.pubDeLaCampagne(t, campagneId),
        contactBloque: (t, waId) => contactStore.isBlockedByWaId(t, waId),
        // LA MÊME lecture que l'exécuteur de scénario et que l'agent, sur le MÊME dépôt : deux lectures
        // différentes du même fait finiraient par ne plus dire la même chose.
        estDesabonne: (t, waId) => contactStore.estDesabonneParWaId(t, waId),
        // 🔴 LE GESTE QUI EXISTE, CÂBLÉ ET PAS RECOPIÉ : `take` avec un seul rejeu, puis l'état local à
        // `app_workflow`. En écrire un second exemplaire en ferait le quatrième de cette famille.
        reprendreLeFil: (t, waId) => reprendreLeFilPourLApp(t, waId),
        // 🔴 LE FILET DU FIL PRIS POUR RIEN. On prend le fil AVANT de savoir si l'automation va réellement
        // démarrer ; quand elle ne démarre pas, ce geste le rend. `remiseMbaSiPersonneNeSuit` porte déjà
        // les deux gardes utiles : rien ne part si l'agent de Meta est éteint, ni si un parcours attend.
        rendreLeFil: (t, waId) => remiseMbaSiPersonneNeSuit(t, waId),
        noterIssue: (t, messageId, v) => arriveesPubStore.noterIssue(t, messageId, v),
      },
      // Acteur `null` : c'est le contact lui-même qui a coché, via WhatsApp. Aucun humain de l'équipe n'a agi,
      // et le journal doit le dire plutôt que d'attribuer le geste à personne en silence.
      flowMapping: { lookup: flowStore, writer: contactStore, audit: (tenant, actor, action, target, detail) => auditStore.record(tenant, actor, action, target, detail) },
      workflowAdvance: {
        phoneNumberTenant: (pnid) => inboxStore.phoneNumberTenant(pnid),
        advance: (t, w, m, bp) => workflowExecutor.advance(t, w, m, bp),
        // 🔴 Une avance qui échoue était acquittée en SILENCE (lot 4 du plan post-audit) : le job se terminait
        // en succès, donc aucun rejeu, aucune DLQ, aucune trace, et le contact restait bloqué sur son bloc.
        // Elle atterrit désormais dans le journal des erreurs, celui que l'écran montre déjà.
        journaliserEchec: (e) => erreursLivraison.enregistrerEchecAvance(e),
      },
      // Auto-création de fiche depuis l'inbound (par numéro OU BSUID) : les clients qui écrivent sans
      // partager leur numéro (post-octobre) atterrissent quand même dans le CRM. Isolé dans processInbound.
      // Le résultat ('created') est le signal « 1er message d'un contact inconnu » : le handler le capture
      // pour le déclencheur d'automation `new_contact`. Ne PAS le jeter.
      inboundContactUpsert: async (tenant, m) => {
        const issue = await contactStore.upsertFromInbound(tenant, m.waId, m.profileName);
        // 🔴 L'origine PUBLICITAIRE, posée sur la fiche AU PASSAGE. Meta ne l'envoie que sur le premier
        // message après le clic : ici ou jamais. Isolé dans son propre try : une fiche créée vaut mieux
        // qu'une fiche perdue parce que l'écriture d'un champ a échoué.
        if (m.referral) {
          try {
            await ensureFieldByKey(fieldStore, tenant, CTWA_AD_ID_FIELD_KEY, CTWA_AD_ID_FIELD_LABEL, 'text');
            await ensureFieldByKey(fieldStore, tenant, CTWA_AD_TITLE_FIELD_KEY, CTWA_AD_TITLE_FIELD_LABEL, 'text');
            await contactStore.mergeFieldsByPhone(tenant, m.waId, {
              [CTWA_AD_ID_FIELD_KEY]: m.referral.adId,
              ...(m.referral.titre ? { [CTWA_AD_TITLE_FIELD_KEY]: m.referral.titre } : {}),
            });
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error('origine publicitaire non posée sur la fiche:', messageDe(err));
          }
        }
        return issue;
      },
      // Pré-câblage MBA : bascules de contrôle et messages de l'agent Meta. Inerte tant que MBA n'est
      // activé nulle part, mais déjà branché pour que le premier test réel soit OBSERVABLE.
      handover: {
        phoneNumberTenant: (pnid) => inboxStore.phoneNumberTenant(pnid),
        // Sans `only` : Meta fait autorité sur qui détient le fil, notre état ne fait que refléter le sien.
        setControlOwner: (t, w, o) => inboxStore.setControlOwner(t, w, o),
        marquerEscalade: (t, w) => inboxStore.marquerEscalade(t, w),
        // `origine: 'mba'` et pas `'ia'` : l'agent de Meta EST une IA, mais garder les deux valeurs
        // distinctes en base coûte zéro et permet de dire un jour laquelle des deux a parlé. Le
        // regroupement en un seul thème « IA » se fait à l'affichage (`THEME_DE_ORIGINE`).
        recordAgentMessage: (t, w, body, messageId) =>
          inboxStore.recordOutboundByWaId(t, w, { body, messageId, type: 'mba', origine: 'mba' }),
      },
      // Automations (Lot E) : un message entrant peut DÉMARRER un scénario (mot-clé, 1er message d'un nouveau
      // contact). `isNewContact` est injecté par le handler (il vient de l'upsert ci-dessus). La garde de
      // contrôle du fil est celle de l'executor : un scénario déclenché n'écrit pas dans un fil tenu par un humain.
      triggers: {
        phoneNumberTenant: (pnid) => inboxStore.phoneNumberTenant(pnid),
        // 🔴 `opts` VIENT DE L'APPELANT, JAMAIS D'UN LITTÉRAL POSÉ ICI. C'est le routage publicitaire qui
        // décide « seule celle-là » ; le poser en dur à `null` rendrait le lot 3 inopérant sans qu'aucun
        // type ne bouge, et un lead de publicité redeviendrait ramassable par n'importe quel mot-clé.
        run: (tenant, ev, opts) => runAutomations(tenant, ev, automationRunnerDeps, opts),
      },
      // Jetons de test d'un scénario (Lot F) : le testeur envoie le mot de son lien wa.me / QR depuis son
      // propre téléphone. C'est LUI qui ouvre la fenêtre 24 h, donc le scénario peut démarrer en session.
      testTokens: {
        phoneNumberTenant: (pnid) => inboxStore.phoneNumberTenant(pnid),
        findByTestToken: async (token) => {
          const wf = await workflowStore.findByTestToken(token);
          return wf ? { workflowId: wf.id, tenantId: wf.tenantId } : null;
        },
        markConversationTest: (tenant, waId) => inboxStore.markConversationTest(tenant, waId),
        // Un testeur qui relance son lien veut repartir du DÉBUT : on clôt le parcours resté en attente,
        // sinon il resterait orphelin (l'avance ne retrouve qu'un run à la fois par contact).
        startTestRun: async (tenant, workflowId, waId, nodeId) => {
          const wf = await workflowStore.getById(workflowId, tenant);
          if (!wf) return false;
          const contactId = await contactStore.findIdByWaId(tenant, waId);
          // 🔴 LE TEST JOUE LE BROUILLON (lot 7), et c'est le seul chemin d'exécution qui le fait. Essayer sa
          // version avant de la mettre en ligne est TOUTE la raison d'être du brouillon : jouer le publié ici
          // obligerait à publier pour tester, ce qui rend le bouton « Publier » inutile.
          //
          // 🔴 ET IL LE FIGE DANS LE PARCOURS (migration 0151). Le démarrage jouait le brouillon, mais les
          // trois points de reprise relisaient le PUBLIÉ : un test qui atteignait un bloc d'attente et
          // recevait une réponse changeait de version en cours de route, en silence, et se figeait sans un
          // mot si son bloc courant n'existait pas dans le publié. C'est le SEUL appelant qui fige, et c'est
          // voulu : figer le graphe de chaque destinataire d'une campagne recopierait le même objet autant
          // de fois qu'elle a de contacts.
          const graphe = grapheEditable(wf);
          // 🔴 `ignoreHumanControl` : UN JETON DE TEST REPREND LE FIL, QUEL QUE SOIT SON DÉTENTEUR (décision de
          // Julien, 2026-09-16, après son essai réel). Sans lui, l'agent de Meta gardait le fil et répondait au
          // testeur à la place du scénario : « quand y a un jeton, le MBA ne marche pas ». C'est le même geste
          // que le lancement depuis l'Inbox et que la campagne, pour la même raison : le déclencheur est un
          // humain qui tient le téléphone, pas un automatisme. La prise échoue lisiblement si Meta la refuse.
          const options = { emitEvents: true, figerLeGraphe: true, ignoreHumanControl: true };
          // ⚠️ AUCUNE GARDE « ce bloc existe-t-il ? » ICI, et c'est délibéré : `runFrom` la porte déjà pour ses
          // quatre chemins de démarrage, elle journalise, et elle rend une raison lisible. La redoubler ici
          // serait une seconde vérité à tenir alignée à la main, sur un chemin où la première est éprouvée.
          return nodeId === null
            ? workflowExecutor.startInWindow(tenant, workflowId, graphe, { waId, contactId }, options)
            // `blocDesigne` rend l'identifiant EXACT du bloc, en tolérant la casse du suffixe ; il rend le
            // suffixe tel quel quand rien ne correspond, et c'est alors `runFrom` qui refuse, lisiblement.
            : workflowExecutor.startFromNode(tenant, workflowId, graphe, { waId, contactId }, blocDesigne(graphe, nodeId), options);
        },
      },
      // Mesure par bloc : les accuses Meta (delivre / lu / echec) retrouvent ici le bloc qui a envoye le
      // message. Un identifiant hors scenario (inbox, campagne) ne cree rien.
      nodeEvents: nodeEventStore,
      // 🔴 OPT-OUT PAR MOT-CLE sur WhatsApp (STOP, desabonner...). Le RCS le faisait depuis toujours, pas
      // WhatsApp : un contact qui repondait STOP restait `opted_in` et recevait la campagne suivante. La
      // source `whatsapp_stop` distingue ce refus de ceux poses a la main dans le mini-CRM, ce qui compte
      // le jour ou il faut prouver d ou vient un desabonnement.
      // Le wamid du STOP suit jusqu'au signal : un STOP redelivre par Meta garde le meme `em_event_id`.
      inboundOptOut: (tenant, waId, messageId) => contactStore.setOptInByWaId(tenant, waId, 'opted_out', SOURCE_STOP_WHATSAPP, messageId),
      /**
       * RÉPARTITION D'UNE RÉPONSE DE CAMPAGNE (`campaigns.assignation`, migration 0134).
       *
       * 🔴 LE TOUR DE RÔLE SE JOUE ICI, À L'ARRIVÉE DE LA RÉPONSE, ET PAS AU LANCEMENT. Répartir cinq
       * mille conversations d'avance attribuerait des conversations qui n'existeront jamais : la plupart
       * des destinataires ne répondent pas, et les compteurs de charge de l'équipe afficheraient une
       * répartition imaginaire.
       *
       * ⚠️ Les quatre dépendances sont des requêtes du dépôt, aucune n'est réécrite ici : c'est la règle
       * (`src/inbox/assignation-campagne.ts`) qui décide, et elle est éprouvée sans base.
       */
      inboundAssignation: (tenant, waId) => assignerReponse(tenant, waId, {
        campagneDeLaReponse: (t, w) => repo.campagneAssignanteDuContact(t, w),
        membres: (t) => inboxStore.membresAffectables(t),
        prendreUnRang: (t, campaignId) => repo.prendreUnRangDeTourDeRole(t, campaignId),
        assigner: (t, w, userId) => inboxStore.assignerSiLibre(t, w, userId),
        /**
         * 🔴 CE QUI REND « LA CONVERSATION ARRIVE DANS L'INBOX » VRAI (migration 0144). Sans ce geste, la
         * phrase était fausse sur tout espace ayant l'agent de Meta allumé : il est le répondeur PRIMAIRE
         * du numéro, donc il répondait au contact avant que l'équipe ne voie quoi que ce soit, et
         * l'assignation ne faisait que ranger une conversation qu'un robot avait déjà menée.
         *
         * ⚠️ ON RÉUTILISE LE GESTE DU SCÉNARIO, on n'en écrit pas un second : `reclaimControl` porte déjà
         * la prise du fil chez Meta, son rejeu unique sur échec transitoire et l'écriture de notre colonne
         * dans le bon ordre. Le recopier ici en ferait le troisième exemplaire de cette famille, après le
         * constructeur de composants Meta et la préparation des visuels de carousel, qui ont chacun cassé
         * la production le 2026-08-15.
         */
        prendreLeFil: (t, w) => reprendreLeFilPourLApp(t, w),
      }),
    });
    // 🔴 CONCURRENCE DES ENTRANTS (lot 3 du programme II), et les deux options vont ENSEMBLE.
    // `concurrency` seul remettrait le désordre entre deux messages d'un même contact ; `groupConcurrency`
    // seul serait un NO-OP (pg-boss n'a rien à répartir tant qu'un seul job est en vol). Le groupe est le
    // COUPLE numéro + contact, posé à l'enfilement par le receveur (`cleDeContact`).
    //
    // ⚠️ La garantie est LOCALE au process. Avec un second worker, deux jobs du même contact pourraient
    // repartir en parallèle : c'est le lot 8, et c'est écrit là plutôt que découvert ce jour-là.
  }, { concurrency: config.WEBHOOK_CONCURRENCY, groupConcurrency: 1 });

  /**
   * File des ACCUSÉS DE LIVRAISON (lot 6). Le receveur y aiguille tout payload qui ne contient QUE des
   * `statuses`. Une campagne de 5 000 messages en produit trois par destinataire : sur une file unique, cette
   * rafale de quinze mille jobs passait DEVANT la réponse d'un vrai client.
   *
   * MÊME fonction de traitement, avec les seules dépendances de livraison : rien n'est dupliqué, et un accusé
   * qui arriverait dans un payload mixte reste traité par la file des entrants, qui les gère aussi.
   *
   * ⚠️ Conséquence assumée : l'ordre relatif entre un accusé et un message entrant n'est plus garanti. Ils
   * touchent des lignes différentes (un accusé met à jour un envoi par son `message_id`, un entrant crée une
   * conversation), donc aucun invariant n'en dépend. Le dire ici parce que ça ne se devine pas.
   *
   * Pas de concurrence : deux accusés du MÊME message (sent puis delivered) doivent s'appliquer dans l'ordre,
   * et c'est la sérialisation de la file qui le garantit aujourd'hui.
   */
  await queue.work('webhook-status', async (data) => {
    // Trois dépendances NOMMÉES là où il y avait sept `undefined` d'affilée : ce qui est absent l'est
    // volontairement (aucune conversation, aucune automation, aucun scénario ne se déclenche sur un accusé),
    // et ça se lit maintenant sans compter les virgules.
    await handleWebhookJob(data, { store: eventStore, delivery: recipientStore, nodeEvents: nodeEventStore, remiseMba: remiseMbaSurAccuse, tarifsMeta: tarifsMetaStore, echecsLibres: echecsMessages, signauxAccuse: puitsSignaux.accuse });
  });

  // File campaign-run (Loop 5). DRY_RUN=true : sender de démo (aucun appel Meta). Sinon : token résolu PAR TENANT
  // (B1), avec intercepteur d'auth (un token révoqué invalide le WABA au lieu de brûler des appels).
  const dryRunSender = new DryRunSender();
  // ⚠️ LE NUMÉRO EST CELUI QUE LE RUN A RÉSOLU, PAS `campaign.phoneNumberId` : une campagne RCS a la
  // colonne vide (migration 0056) et son repli WhatsApp part du numéro de l'espace. Lire la campagne ici
  // enverrait ce repli depuis un identifiant vide.
  const senderFor = async (campaign: Campaign, phoneNumberId: string): Promise<MessageSender> =>
    dryRun ? dryRunSender : metaFactory.senderForTenant(campaign.tenantId, phoneNumberId);

  // 🔴 DRAPEAU D'ARRÊT (R4). Levé par SIGTERM, lu par le moteur à CHAQUE destinataire : un run de campagne
  // s'arrête alors à la frontière d'un envoi, rend son verrou, et laisse la campagne `running` avec ses
  // destinataires en attente. Le balayage de reprise la relance au redémarrage. Sans lui, un déploiement
  // tuait le run en plein envoi et la campagne se figeait sans la moindre erreur visible.
  let arretDemande = false;

  // Concurrence de la file de campagnes (lot 5) : plusieurs runs EN PARALLÈLE, mais un seul par ESPACE
  // (`localGroupConcurrency: 1`, le groupe étant le tenant, posé à l'enfilement). Un client n'attend donc plus
  // la campagne d'un AUTRE, et deux campagnes du même client restent sérialisées — elles partagent de toute
  // façon un seul numéro, donc un seul budget d'envoi.
  //
  // 🔴 Ceci n'est sûr QUE parce que le frein par numéro du lot 4 est en place. Sans lui, deux runs en
  // parallèle doubleraient le débit réel du numéro, ce que Meta observe et sanctionne.
  await queue.work('campaign-run', async (data) => {
    await campaignRunJob(data, {
      getCampaign: (id) => repo.getCampaign(id),
      senderFor,
      recipients: recipientStore,
      campaigns: new PgCampaignStore(pool),
      // La note de qualite du numero, lue une fois par process et non par destinataire. Elle commande une mise
      // en PAUSE de la campagne : la justification du cache est dans le module, et elle tient a un chiffre
      // mesure (la colonne n'est rafraîchie que toutes les 20 minutes par le balayage `statut-numeros`).
      quality: { getRating: noteDeQualite },
      // Frein par défaut des campagnes sans ratePerMinute (0 = opt-out). Injecté ICI seulement : les tests de
      // câblage de run-job ne le passent pas, donc une campagne à rate null y reste en opt-out (aucun frein).
      defaultRatePerMinute: config.CAMPAIGN_DEFAULT_RATE_PER_MINUTE,
      // 🔴 LE PLAFOND DU CANAL, et c'est le SEUL câblage qui bride vraiment un envoi. Les enfileurs
      // n'estiment qu'une durée ; ici on exécute. `plafondDuCanal` lit le canal de LA campagne en cours,
      // donc une campagne RCS cesse d'hériter du plafond que Meta impose à un numéro WhatsApp.
      plafondDeDebit: (canal) => plafondDuCanal(canal, config),
      // Revalide l'appartenance du numéro juste avant d'envoyer (défense contre une réaffectation). Injecté ICI
      // seulement : absent en test/e2e, la garde est sautée (pas de rupture des fixtures sans ligne phone_numbers).
      phoneNumberBelongsToTenant: (pn, tenant) => repo.phoneNumberBelongsToTenant(pn, tenant),
      // Canal RCS : sender construit à partir de l'agent et du message FIGÉS sur la campagne. null -> la
      // campagne est mise en pause avec sa raison, elle ne repart jamais sur le chemin WhatsApp.
      rcsSenderFor: (campaign, message) => rcsStack.senderForCampaign(campaign, message),
      // Le numéro de l'espace, pour un étage WhatsApp de REPLI sur une campagne qui n'en porte pas (une
      // campagne RCS). Le MÊME que l'écran de création aurait choisi : le premier par `created_at`.
      numeroDuTenant: (tenant) => repo.getTenantPhoneNumberId(tenant),
      // 🔴 LE STORE, PAS LA GARDE : la pause `numero_delie` s'écrit en une instruction qui relit la base, justement
      // parce que la garde met sa réponse en cache 5 s et peut dire « délié » juste après « Relier » (cf.
      // `RunJobDeps.pauserSiNumeroDelie`).
      pauserSiNumeroDelie: (id, tenant, pn) => numeroDelieStore.pauserCampagne(id, tenant, pn),
      // SÉRIALISATION des runs (R1-bis) : un seul run vivant par campagne. Injectée ICI seulement, comme les
      // gardes voisines : absente en test/e2e, le comportement historique est conservé mot pour mot.
      serialisation: {
        verrou: new PgCampaignRunLock(pool),
        enAttente: async (id) => (await repo.getRunSizing(id))?.pendingCount ?? 0,
        // On ne relance QUE s'il reste vraiment du travail. Un doublon d'enfilement (double clic sur
        // « Lancer ») marque une relance qui n'a rien à envoyer : elle ferait clignoter le statut de la
        // campagne (completed -> running -> completed) pour rien.
        relancer: async (id) => {
          const sizing = await repo.getRunSizing(id);
          if (!sizing || sizing.pendingCount === 0) return;
          await relancerCampagne({ campaignId: id, ...sizing });
        },
      },
      /**
       * 🔴 LES CAPACITÉS DU MOTEUR, EN UN SEUL BLOC (constat C1 de l'audit externe du 2026-09-02).
       *
       * Elles étaient à plat, et `run-job` les recopiait une par une dans les options du moteur : deux
       * listes à tenir alignées à la main, dont l'oubli ne produisait aucune erreur. C'est ce qui a fait
       * échouer toutes les campagnes à lien tracé le 2026-09-02 (131008), `boutonsTraces` étant câblée ici
       * et absente du contrat. Elles voyagent maintenant ensemble, transmises d'un seul geste.
       *
       * ⚠️ ET LE TYPE FERMÉ NE SUFFISAIT PAS, contrairement à ce que ce commentaire a affirmé pendant un jour.
       * Mesuré au compilateur, pas raisonné : une propriété en trop écrite DIRECTEMENT dans ce littéral est
       * refusée (TS2353), mais la même introduite par un SPREAD passe sans un mot, et un `satisfies` posé sur
       * le littéral EXTÉRIEUR n'y change rien. Seul un `satisfies` sur l'objet INTÉRIEUR du spread la voit,
       * d'où celui du bloc `...(dryRun ? {} : (...))` ci-dessous. C'est précisément là que vivaient
       * `boutonsTraces` et `jetonsPourContacts` le jour de la panne : la garde manquait à l'endroit exact où
       * le trou s'était ouvert.
       *
       * La règle générale : **le contrôle des propriétés en trop ne traverse pas un spread.** Un câblage qui
       * construit ses dépendances par spread n'a aucune garde tant qu'on ne la pose pas SUR le spread.
       */
      moteur: {
      arretDemande: () => arretDemande,
      // Les horaires d'ouverture de l'espace, pour une campagne cochée « uniquement pendant les heures
      // ouvrées ». Le moteur ne les demande QUE si la campagne porte le drapeau, et une seule fois par run :
      // ce câblage n'ajoute donc aucune requête aux campagnes qui ne s'en servent pas.
      horairesOuvres: async (tenant: string) => {
        const s = await settingsStore.get(tenant);
        return { timeZone: s.timezone, businessHours: s.businessHours };
      },
      // Le run rend la main au bout de ce délai et se réenfile : la file reste équitable entre clients.
      dureeMaxMs: config.CAMPAIGN_RUN_MAX_MS,
      // Campagne workflow : démarre le workflow (blocs sync + 1er template) pour chaque destinataire.
      // firstTemplateParams = variables du 1er template déjà résolues par contact (paramMapping de la campagne).
      // Renvoie false si le run n'a pas démarré (scénario supprimé entre-temps, fil détenu par un humain/MBA,
      // ou graphe devenu non lançable) -> la campagne marque le destinataire en échec au lieu de le compter envoyé.
      startWorkflow: async (tenant, workflowId, waId, contactId, firstTemplateParams) => {
        const wf = await workflowStore.getById(workflowId, tenant);
        if (!wf) return false;
        // Campagne : c'est un envoi VOULU par un opérateur, donc « fil repris par un humain » ne le bloque pas
        // (l'opérateur EST celui qui a la main), et le scénario reprend la conduite du fil pour pouvoir avancer.
        return workflowExecutor.start(tenant, workflowId, wf.graph, { waId, contactId }, firstTemplateParams, { ignoreHumanControl: true });
      },
      // Campagne NODE (/v1/sends) : démarre le workflow au bloc ciblé, et l'executor n'applique pas la garde de
      // fenêtre (startFromNode). La fenêtre de 24 h n'a été vérifiée destinataire par destinataire, à la création
      // de l'envoi, que si le bloc ouvre par un message de session (`ouvertureApi`) ; un bloc qui ouvre par un
      // template ou un RCS n'en a pas besoin.
      startWorkflowFromNode: async (tenant, workflowId, startNodeId, waId, contactId) => {
        const wf = await workflowStore.getById(workflowId, tenant);
        if (!wf) return false;
        return workflowExecutor.startFromNode(tenant, workflowId, wf.graph, { waId, contactId }, startNodeId, { ignoreHumanControl: true });
      },
      // Cartes du carousel du template (image + boutons de chaque carte), relues UNE fois par run et servies
      // par le même cache court que les variables. null = template sans carousel -> envoi inchangé.
      // Absente en DRY_RUN : la dep est optionnelle et ce mode ne doit déclencher AUCUN appel Meta.
      ...(dryRun ? {} : ({
        getTemplateCarousel: async (tenant: string, name: string, language: string) => {
          const lu = (await templateVarInfo(tenant, name, language))?.carousel;
          // Visuels préparés UNE fois par run : ils sont identiques pour tous les destinataires.
          return lu ? { cards: await prepareCarouselMedia(tenant, lu.cards) } : null;
        },
        // En-tête média : Meta l'exige à CHAQUE envoi, l'image du template ne servant qu'à sa validation. Même
        // cache, même préparation UNE fois par run. `mediaId: null` = préparation échouée -> le moteur refuse
        // la campagne entière avec une raison lisible, au lieu de collectionner les 132012 un par un.
        /**
         * ATTRIBUTION DES CLICS (migration 0106) : quels boutons de ce template portent un suffixe variable.
         *
         * ⚠️ Seuls les liens CONFIRMES et marques `avec_jeton` comptent. Un lien reserve mais refuse par Meta
         * ne decrit aucun bouton reel, et un lien d avant le 2026-09-02 n a pas de variable dans son URL :
         * lui envoyer un composant ferait echouer l appel avec un 132000.
         */
        boutonsTraces: async (tenant: string, name: string, _language: string) => {
          const liens = await trackedLinkStore.listByTemplates(tenant, [name]);
          return liens.filter((l) => l.avecJeton && l.cardIndex === null).map((l) => l.buttonIndex);
        },
        jetonsPourContacts: (tenant: string, ids: readonly string[]) =>
          trackedLinkStore.jetonsPourContacts(tenant, ids, fabriquerJeton),
        getTemplateHeaderMedia: async (tenant: string, name: string, language: string) => {
          const info = await templateVarInfo(tenant, name, language);
          if (!info?.headerFormat) return null;
          const mediaId = info.headerMediaUrl ? await prepareHeaderMedia(tenant, info.headerMediaUrl) : null;
          return { headerFormat: info.headerFormat, mediaId };
        },
        /**
         * Ce contact est joignable en WhatsApp (migration 0133).
         *
         * 🔴 DANS LE BLOC NON-DRY_RUN, AVEC LES APPELS META, ET C'EST LA RAISON D'ÊTRE DE SA PLACE. En
         * DRY_RUN aucun message ne part vraiment : le faux sender réussit, le destinataire passe `sent`, et
         * une capacité câblée ici écrirait « joignable » sur des numéros que personne n'a jamais sollicités.
         * Une mesure inventée est pire qu'une mesure absente, puisque `inconnu` n'exclut personne.
         */
        noterJoignabilite: noterJoignabiliteContact,
      } satisfies Partial<CapacitesMoteur>)),
      // Journalise le template envoyé (campagne DIRECTE) dans le fil de conversation.
      recordOutbound: (tenant: string, waId: string, msg: Parameters<typeof inboxStore.recordOutboundByWaId>[2]) =>
        inboxStore.recordOutboundByWaId(tenant, waId, msg),
      /**
       * Journalise CHAQUE tentative d'envoi (migration 0134).
       *
       * 🔴 HORS DU BLOC `dryRun`, ET C'EST UNE DIFFÉRENCE DE NATURE AVEC `noterJoignabilite`, PAS UN
       * OUBLI. Cette dernière est une MESURE SUR LE MONDE (« ce numéro a WhatsApp »), qu'un faux sender
       * inventerait de toutes pièces ; ce journal-ci enregistre CE QUE LE PRODUIT A FAIT, et en DRY_RUN
       * le produit résout réellement ses destinataires (`campaign_recipients` est bien écrite). Le
       * couper là ferait dire deux choses différentes aux deux tables, dans le seul mode où on les
       * compare à la main. Même place, et pour la même raison, que `recordOutbound` juste au-dessus.
       */
      noterEnvoi: noterEnvoiCampagne,
      },
    });
  }, { concurrency: config.CAMPAIGN_RUN_CONCURRENCY, groupConcurrency: 1 });

  /**
   * File optout-poussee : prevenir le systeme du client qu une personne a refuse (tache 7 du centre de
   * Securite, migration 0139).
   *
   * 🔴 INCONDITIONNELLE, contrairement a `push-analysis`. La file est enfilee par l API comme par le worker
   * des qu un opt-out est ecrit, sans regarder aucun reglage : c est le HANDLER qui relit le branchement et
   * ne fait rien s il n y en a pas. L inverse (ne pas consommer quand personne n est branche) laisserait
   * s empiler des jobs que personne ne depile, exactement le trou que `agent-turn` a vecu plusieurs jours.
   *
   * ⚠️ Concurrence 1, par defaut : un client peut desabonner des milliers de personnes d un geste, et
   * frapper son propre systeme en parallele ne lui rendrait pas service.
   */
  await queue.work(FILE_POUSSEE_OPTOUT, creerTravailPousseeOptOut({
    sources: new PgSourceStore(pool),
    requetes: new PgRequeteStore(pool),
    requeteConfiguree: async (tenant) => (await settingsStore.get(tenant)).optoutRequestId,
    /**
     * 🔴 LE JOURNAL (migration 0142), ET C EST LE CAS LE PLUS IMPORTANT DES TROIS. Un refus non pousse est
     * invisible du client : il croit son CRM prevenu, et il repond d un manquement qu il ne peut pas voir.
     * Les reessais de pg-boss puis la DLQ sont NOTRE filet, pas le sien.
     */
    journalAppels: new PgJournalAppels(pool),
    libelleRequete: async (t, id) => (await new PgRequeteStore(pool).parId(t, id))?.label ?? null,
    derniereSaisie: (t, waId) => inboxStore.derniereSaisieDuContact(t, waId),
    fuseau: async (t) => (await settingsStore.get(t)).timezone,
    // Relue a chaque appel, comme pour le bloc « Appel HTTP » d un scenario : la fiche a pu bouger entre le
    // refus et la reprise du job.
    projectionContact: (t, waId) => contactStore.projectionPourTiers(t, waId),
    // eslint-disable-next-line no-console
    log: (m) => console.warn(m),
  }));

  /**
   * File signaux-batch (spec 2026-09-24, § 8) : pousser les signaux vers Batch, un job (de 1 à
   * `SIGNAUX_PAR_JOB` signaux d'un même espace) à la fois par espace.
   *
   * 🔴 INCONDITIONNELLE, comme `optout-poussee` : le travail relit le réglage et ne fait rien s'il n'y en a pas.
   * Ne pas consommer quand personne n'est branché laisserait s'empiler des jobs que personne ne dépile.
   *
   * ⚠️ Groupée par ESPACE (le `groupId` posé par l'émetteur) : la rafale d'un client ne passe pas devant les
   * autres. Dans un espace, la PRIORITÉ (`PRIORITE_SIGNAL`) fait passer réponses, clics, désabonnements et
   * analyses devant un arriéré d'accusés. Les DEUX options de concurrence vont ensemble, `groupConcurrency`
   * étant un no-op tant que `concurrency` vaut 1. Deux en vol restent loin des 300 mises à jour par seconde
   * que Batch accepte.
   */
  const signauxStore = new PgSignauxStore(pool);
  await queue.work(FILE_SIGNAUX_BATCH, creerTravailSignauxBatch({
    reglage: async (t) => {
      const s = await integrationBatch.secrets(t);
      if (s === null) return null;
      return {
        cles: {
          cleRest: decryptSecret(s.cleRestChiffree, config.ENCRYPTION_KEY),
          cleProjet: decryptSecret(s.cleProjetChiffree, config.ENCRYPTION_KEY),
        },
        envoyerResume: s.envoyerResume,
        suspendu: s.refusClesLe !== null,
      };
    },
    completer: (t, s) => completerSignal(signauxStore, t, s),
    pousser: (requete, cles) => pousserVersBatch(requete, cles, transport),
    noterSansIdentifiant: (t, n) => integrationBatch.noterSansIdentifiant(t, n),
    suspendre: async (t) => {
      await integrationBatch.suspendre(t);
      espacesBatch.invalider('actifs');
    },
    journal: new PgJournalAppels(pool),
    // eslint-disable-next-line no-console
    log: (m) => console.warn(m),
  }), { concurrency: 2, groupConcurrency: 1 });

  // File analyze-conversation (Pièce 1). INERTE tant que CONVERSATION_ANALYSIS_ENABLED != 'true' : aucun worker,
  // aucun balayage, aucun appel LLM, zéro coût. Le déclencheur (balayage d'inactivité) est REMPLAÇABLE (temps réel plus tard).
  if (config.CONVERSATION_ANALYSIS_ENABLED === 'true') {
    const analysisStore = new PgConversationAnalysisStore(pool);
    const llmClient = new AnthropicClient(config.LLM_API_KEY, config.LLM_MODEL, config.LLM_MAX_TOKENS, transport);
    // Point de sortie (Pièce 2) : pousser l'analyse au connecteur mm-hubspot via un job SÉPARÉ `push-analysis`
    // (durable + DLQ). INERTE si CONNECTOR_PUSH_URL vide -> onAnalyzed = no-op, aucune file push, zéro appel réseau.
    const pushEnabled = config.CONNECTOR_PUSH_URL !== '';
    if (pushEnabled) {
      await queue.work('push-analysis', (data) =>
        pushAnalysisJob(data, {
          // Refetch FRAIS (F3-a) : le payload ne porte qu'une référence, on relit l'analyse courante ICI.
          getStoredAnalysis: (id) => analysisStore.getStored(id),
          getEnrichment: (id) => getEnrichment(pool, id),
          // GATE + décision de rattrapage en UN snapshot : connected (pousse ou non) + pausedAt (marque ou non).
          getHubspotGateStatus: (tenantId, line) => phoneStatusStore.getHubspotGateStatus(tenantId, line),
          post: (event) => postAnalysis(event, { url: config.CONNECTOR_PUSH_URL, secret: config.CONNECTOR_PUSH_SECRET, transport }),
          // Skip en pause -> marque à rattraper (décision prise par le job sur le snapshot) ; post réussi -> efface la marque.
          markPendingCatchup: (id) => analysisStore.markPendingCatchup(id),
          clearPendingCatchup: (id) => analysisStore.clearPendingCatchup(id),
          // eslint-disable-next-line no-console
          log: (m) => console.log(m),
        }),
      );
      // Rattrapage (F3-a) : à la reprise après pause, re-enfile un push (ref seule) par conversation marquée. Même
      // gating d'inertie que push-analysis (dans le if(pushEnabled)) : si le push est off, le catch-up n'est pas consommé.
      await queue.work('hubspot-catchup', (data) =>
        hubspotCatchupJob(data, {
          listPendingCatchup: (tenantId) => analysisStore.listConversationIdsPendingCatchup(tenantId),
          enqueuePush: (ref) => queue.enqueue('push-analysis', ref),
          // eslint-disable-next-line no-console
          log: (m) => console.log(m),
        }),
      );
      // FILET DE SÉCURITÉ (F3-a) : indépendamment d'une reprise, relance périodiquement le rattrapage pour tout
      // tenant dont un numéro est RECONNECTÉ mais garde des marques pending_catchup (reprise dont l'enqueue avait
      // échoué, ou marque posée juste après que le catch-up de reprise ait déjà listé). Rend le rattrapage
      // éventuellement complet SANS dépendre d'un futur clic de reprise. best-effort + unref : ne tue pas le worker.
      const catchupSweep = async (): Promise<void> => {
        const tenants = await analysisStore.listTenantsReadyForCatchup();
        // ⚠️ Aucune dédup de file (cf. `Queue.enqueue`) : ce balayage peut enfiler un rattrapage pour un
        // tenant qui en a déjà un en vol. Sans dommage ici, le job relit l'état frais et re-pousse ce qui
        // reste marqué, mais ce n'est pas gratuit (appels connecteur redondants).
        for (const tenantId of tenants) await queue.enqueue('hubspot-catchup', { tenantId });
        // eslint-disable-next-line no-console
        if (tenants.length > 0) console.log(`hubspot-catchup-sweep: ${tenants.length} tenant(s) relancé(s)`);
      };
      taches.programmer('hubspot-rattrapage', config.HUBSPOT_CATCHUP_SWEEP_INTERVAL_MS, catchupSweep, { immediat: true, enEchec: echecDeBalayage('hubspot-catchup-sweep', 'sweeper:hubspot-catchup') });
    }
    const pushAnalyzed = makeOnAnalyzed({
      enabled: pushEnabled,
      // Enfile une RÉFÉRENCE (pas le snapshot) : le handler push-analysis refetch l'état frais (F3-a).
      enqueue: (stored) => queue.enqueue('push-analysis', { conversationId: stored.conversationId, tenantId: stored.tenantId }),
      // eslint-disable-next-line no-console
      onError: (err) => console.error('push-analysis enqueue échoué (best-effort):', messageDe(err)),
    });

    // TROIS consommateurs du même point de sortie : le push connecteur (Pièce 2), les signaux (lot 6 de l'API
    // publique) et, depuis E.2, les automations « conversation analysée » (relancer un client mécontent, par
    // exemple). Chacun est isolé :
    // un échec de l'un ne prive pas l'autre, et aucun ne fait échouer le job d'analyse lui-même.
    const onAnalyzed: typeof pushAnalyzed = async (stored) => {
      // Chaque consommateur a SON try/catch ici : l'isolation devient une propriété de cette composition, et
      // non un pari sur le fait que l'appelé avale ses erreurs. Sans ça, un push qui lèverait sauterait
      // l'automation ET ferait rejouer le job d'analyse, donc re-facturerait l'appel LLM.
      await tenter('push connecteur ignoré (best-effort):', () => pushAnalyzed(stored));
      try {
        // 🔴 AVANT L'AUTOMATION, qui SORT de la fonction (`if (!ctx) return;`) quand la conversation n'a pas de
        // contexte : placé après, le signal disparaîtrait dans ce cas-là, en silence. Il ne relit rien ici,
        // la fiche et l'analyse se relisent au moment de pousser.
        await emetteur.emettreSignal(stored.tenantId, signalAnalyse(stored.conversationId));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('signal « conversation analysée » ignoré (best-effort):', messageDe(err));
      }
      try {
        // L'analyse identifie une CONVERSATION ; le moteur de scénario raisonne par wa_id.
        const ctx = await inboxStore.getConversationContext(stored.conversationId, stored.tenantId);
        if (!ctx) return;
        await runAutomations(
          stored.tenantId,
          { kind: 'analysis', waId: ctx.waId, sentiment: stored.sentiment, resolved: stored.resolved },
          automationRunnerDeps,
        );
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('automation « conversation analysée » ignorée (best-effort):', messageDe(err));
      }
    };

    // Groupe = l'ESPACE (lot 6 du plan post-audit). Sur cette file, l'équité compte bien plus que le débit :
    // un client qui importe dix mille contacts déclenche dix mille analyses, et sans groupe elles passent
    // toutes AVANT la première analyse de tous les autres clients.
    const onConversationReady = (conversationId: string, tenantId: string): Promise<void> =>
      queue.enqueue('analyze-conversation', { conversationId, tenantId }, { groupId: tenantId });
    await queue.work('analyze-conversation', (data) =>
      analyzeConversationJob(data, {
        store: analysisStore,
        llm: llmClient,
        onAnalyzed, // Pièce 2 : push connecteur (inerte si URL vide) ; consommé aussi par la pièce 3 plus tard
        model: { provider: 'anthropic', model: config.LLM_MODEL },
      }),
      // ⚠️ Les DEUX options vont ensemble : `groupConcurrency` est un no-op tant que `concurrency` vaut 1,
      // donc poser le groupe seul aurait donné une équité qu'on croirait active et qui ne le serait pas.
      { concurrency: config.ANALYZE_CONVERSATION_CONCURRENCY, groupConcurrency: 1 },
    );
    const analysisSweep = (): Promise<void> =>
      runAnalysisSweep({
        store: analysisStore,
        enqueue: onConversationReady,
        staleMs: config.CONVERSATION_ANALYSIS_STALE_MS,
        inactivityMs: config.CONVERSATION_INACTIVITY_MS,
        batch: config.CONVERSATION_ANALYSIS_BATCH,
        // eslint-disable-next-line no-console
        log: (m) => console.log(m),
        onError: (m, err) => {
          // eslint-disable-next-line no-console
          console.error(`${m}:`, messageDe(err));
          // Comme tous les autres balayages : un echec qui ne vit que dans les logs est un echec que
          // personne ne lira. L'alerte est throttlee a cinq minutes par cle, donc une panne persistante
          // n'inonde rien.
          alert('sweeper:analyse-conversations', `analyse de conversations en echec : ${messageDe(err)}`);
        },
      });
    taches.programmer('analyse-conversations', config.CONVERSATION_ANALYSIS_SWEEP_INTERVAL_MS, analysisSweep, { immediat: true });
  }

  // Sweeper : récupère périodiquement les destinataires bloqués en 'sending'.
  const sweep = async (): Promise<void> => {
    const n = await recipientStore.reclaimStale(config.STALE_SENDING_MS);
    // eslint-disable-next-line no-console
    if (n > 0) console.log(`sweeper: ${n} destinataire(s) 'sending' bloqué(s) -> 'pending'`);
  };
  taches.programmer('reclaim', config.RECLAIM_INTERVAL_MS, sweep, { immediat: true, enEchec: echecDeBalayage('sweeper', 'sweeper:reclaim', 'sweeper reclaim') });

  // Sweeper de PLANIFICATION : enfile les campagnes programmées dues (scheduled_at <= maintenant). Miroir du
  // sweeper d'analyse. Toutes les 60 s (granularité suffisante pour un lancement programmé). C'est `markRunning`
  // SEUL (garde sur le statut) qui empêche de re-lister la campagne au tour d'après : l'enfilement, lui, ne
  // déduplique rien (cf. `Queue.enqueue`). Entre l'enqueue et le markRunning, une seconde instance worker
  // enfilerait donc un second run. Sans objet aujourd'hui (le compose fige une instance), à revoir avec R11.
  const scheduleSweep = async (): Promise<void> => {
    const n = await runCampaignScheduleSweep({
      listDue: () => repo.listDueScheduled(),
      enqueueRun: (id, tenantId, expireInSeconds) => queue.enqueue('campaign-run', { campaignId: id }, { expireInSeconds, groupId: tenantId }),
      markRunning: (id) => repo.markScheduledRunning(id),
      defaultRatePerMinute: config.CAMPAIGN_DEFAULT_RATE_PER_MINUTE,
      plafondLePlusBas: plafondLePlusBas(config),
      onError: (m, err) => {
        // eslint-disable-next-line no-console
        console.error(`${m}:`, messageDe(err));
        // MÊME clé que l'échec global ci-dessous : le throttle de 5 min est alors partagé, donc dix
        // campagnes qui échouent d'un coup font UNE alerte, pas dix. Le détail par campagne reste au log.
        alert('sweeper:schedule', `${m} : ${messageDe(err)}`);
      },
    });
    // eslint-disable-next-line no-console
    if (n > 0) console.log(`schedule-sweep: ${n} campagne(s) programmée(s) lancée(s)`);
  };
  taches.programmer('campagnes-programmees', 60_000, scheduleSweep, { immediat: true, enEchec: echecDeBalayage('schedule-sweep', 'sweeper:schedule') });

  /**
   * 🔴 BALAYAGE DE REPRISE APRÈS UN PLAFOND DE DÉBIT (migration 0103).
   *
   * Une campagne qui touche un plafond de cadence Meta se met en pause sans perdre personne, mais RIEN ne la
   * repartait : il fallait un clic, alors que le texte affiché à l'opérateur promettait une reprise
   * automatique. Ce balayage rend cette phrase vraie.
   *
   * Il ne touche QUE les pauses de débit. Une pause de QUALITÉ n'a pas d'échéance et ne sera jamais reprise
   * par une machine : Meta juge alors le numéro, et relancer sans rien changer peut coûter le numéro.
   */
  const plafondSweep = async (): Promise<void> => {
    const n = await runCampaignRepriseSweep({
      reprendreDues: () => repo.reprendreCampagnesDues(),
      getRunSizing: (id) => repo.getRunSizing(id),
      enqueueRun: (id, tenantId, expireInSeconds) => queue.enqueue('campaign-run', { campaignId: id }, { expireInSeconds, groupId: tenantId }),
      defaultRatePerMinute: config.CAMPAIGN_DEFAULT_RATE_PER_MINUTE,
      plafondLePlusBas: plafondLePlusBas(config),
      onError: (m, err) => {
        // eslint-disable-next-line no-console
        console.error(`${m}:`, messageDe(err));
        alert('sweeper:reprise', `${m} : ${messageDe(err)}`);
      },
    });
    // eslint-disable-next-line no-console
    if (n > 0) console.log(`reprise-sweep: ${n} campagne(s) reprise(s) apres un plafond de debit`);
  };
  taches.programmer('campagnes-reprise-plafond', 60_000, plafondSweep, { immediat: true, enEchec: echecDeBalayage('reprise-sweep', 'sweeper:reprise') });

  /**
   * 🔴 BALAYAGE DE REPRISE : relance toute campagne GELÉE (R4).
   *
   * Une campagne est gelée quand elle est `running`, qu'il lui reste des destinataires en attente, et qu'AUCUN
   * run ne tourne. C'est ce qui arrive à chaque déploiement : le worker est tué en plein envoi (SIGKILL vers
   * 10 s, un run de deux heures n'a aucune chance), et plus rien ne la reprenait. Chaque interruption
   * consommait un rejeu pg-boss ; à la sixième la campagne était figée POUR TOUJOURS, sans la moindre erreur
   * visible. C'est le constat R4 de l'audit du 25 août, et c'est ce balayage qui le ferme.
   *
   * « Aucun run ne tourne » se lit sur le verrou d'exécution, dont le bail est court et renouvelé : un process
   * mort le laisse expirer en deux minutes.
   *
   * ⚠️ Il REMPLACE le balayage du fil de l'eau, qui n'en était qu'un cas particulier (les campagnes nourries
   * par un webhook). L'ancien ne savait pas voir qu'un run tournait déjà et empilait un job de plus par
   * minute ; celui-ci ne relance que ce qui est réellement à l'arrêt.
   *
   * Coût : une requête indexée par minute, et zéro enfilement quand rien n'est gelé.
   */
  const repriseSweep = async (): Promise<void> => {
    const gelees = await repo.listCampagnesGelees();
    for (const c of gelees) {
      try {
        await relancerCampagne({ campaignId: c.id, tenantId: c.tenantId, pendingCount: c.pendingCount, ratePerMinute: c.ratePerMinute });
      } catch (err) {
        // Par campagne : une file qui refuse un job ne doit pas empêcher les autres de repartir.
        // eslint-disable-next-line no-console
        console.error(`reprise: enfilement impossible pour ${c.id}`, messageDe(err));
      }
    }
    // eslint-disable-next-line no-console
    if (gelees.length > 0) console.log(`reprise: ${gelees.length} campagne(s) relancée(s) après interruption`);
  };
  taches.programmer('campagnes-gelees', 60_000, repriseSweep, { immediat: true, enEchec: echecDeBalayage('reprise', 'sweeper:reprise', 'balayage de reprise des campagnes') });

  // Sweeper de RÉVEIL : reprend les parcours endormis sur un bloc « Attente » arrivé à échéance. Même patron
  // que le sweeper de planification. La granularité du délai vaut cet intervalle : une attente de 5 min repart
  // entre 5 et 6 min, ce que l'UI annonce comme « environ ».
  // Garde de RÉ-ENTRANCE : celle du registre, qui couvre aussi la passe de démarrage (`immediat`). Sans elle,
  // une passe lente (lot de 50 reprises + relances Meta) verrait la suivante re-claimer des runs dont le bail
  // a expiré.
  const wakeSweep = async (): Promise<void> => {
    const n = await runWorkflowWakeSweep({
      claimDue: (limit) => runStore.claimDueSleeping(limit),
      // Bloc QUESTION resté sans réponse : son échéance vit sur un run `waiting`, invisible du claim
      // ci-dessus. Sans cette ligne, la sortie « pas de réponse » ne partirait JAMAIS, en silence.
      claimDueQuestions: (limit) => runStore.claimDueQuestions(limit),
      resume: (run) => workflowExecutor.resume(run),
      closeStale: () => runStore.closeStaleSleeping(),
    });
    // eslint-disable-next-line no-console
    if (n > 0) console.log(`wake-sweep: ${n} parcours repris après attente`);
  };
  taches.programmer('reveil-parcours', config.WORKFLOW_WAKE_SWEEP_INTERVAL_MS, wakeSweep, { immediat: true, enEchec: echecDeBalayage('wake-sweep', 'sweeper:wake') });

  /**
   * BALAYAGE DES TOURS D'AGENT MORTS EN VOL (constat A1 de l'audit externe du 2026-09-02).
   *
   * 🔴 Monté ICI, HORS du bloc `if (gatewayAgent)`, et c'est délibéré : ce balayage existe précisément pour
   * nettoyer quand le chemin de l'agent est cassé. Le suspendre à la présence d'une clé de Gateway reviendrait
   * à éteindre le filet le jour d'une rotation de clé ratée, c'est-à-dire exactement quand des tours meurent
   * en vol. Il est de toute façon INERTE sans agent : aucune session ne porte alors de tour en vol.
   *
   * Garde de ré-entrance : celle du registre, comme les autres balayages.
   */
  const toursBloquesSweep = async (): Promise<void> => {
    await runTourBloqueSweep({
      reclamer: (age, limite) => agentSessions.reclamerToursBloques(age, limite, SORTIE_ECHEC),
      // Le parcours reprend par la branche RÉELLEMENT DUE, portée par la ligne réclamée : `sortie:echec`
      // pour une session encore `en_cours` (elle n'en a pas d'autre), la sortie déjà décidée pour une
      // session close dont l'application a échoué. La session est DÉJÀ close à ce stade, donc
      // `sortirDuBlocAgent` ne fait plus que faire avancer le run, et ne fait rien s'il a déjà avancé.
      sortir: (t) => workflowExecutor.sortirDuBlocAgent(t.tenantId, t.waId, t.sessionId, t.sortie).then(() => {}),
      // La sortie est passée : la marque tombe, et la ligne cesse d'être réclamable. Sans ce câblage, la
      // même session reviendrait à chaque passage, la sortie n'y ferait rien de plus, mais le balayage
      // travaillerait pour rien et son compte annoncerait des parcours remis en route qui l'étaient déjà.
      sortieAppliquee: (t) => agentSessions.sortieAppliquee(t.tenantId, t.sessionId),
      // eslint-disable-next-line no-console
      log: (m) => console.warn(m),
    });
  };
  taches.programmer('tours-agent-bloques', 60_000, toursBloquesSweep, { immediat: true, enEchec: echecDeBalayage('tours-bloques-sweep', 'sweeper:tours-bloques') });

  // Auto-relance des échecs (F6) : 131049 (fenêtre matinale Europe/Paris, 1 relance) + 131026 (1 relance puis
  // injoignable au 2e échec). Le sweep lui-même ne touche QUE ce que la campagne autorise depuis la migration
  // 0165 (sa case « Réessayer »), ou, pour une campagne créée avant, le réglage d'espace `auto_retry_enabled`,
  // qui n'a plus d'écran (`listAutoRetry`, `src/campaign/store.pg.ts`).
  //
  // 🔴 IL N'EST PLUS GATÉ PAR HUBSPOT, et c'est une correction, pas un élargissement de confort. Il était monté
  // sous `if (config.HUBSPOT_SERVICE_URL)` parce que le flag injoignable en dépendait : conséquence non voulue,
  // un espace SANS HubSpot n'avait AUCUNE relance automatique, ni des 131049 ni des 131026, alors que ces deux
  // mécanismes n'ont rien à voir avec un CRM. Seul l'appel HubSpot reste conditionnel désormais.
  const isMorningParis = (nowMs: number): boolean => {
    const h = Number(new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false }).format(new Date(nowMs)));
    return h >= 8 && h < 12; // « début de journée »
  };
  {
    // ⚠️ L'ORDRE « flag PUIS clôture » DE `runRetrySweep` REPOSE SUR UN FLAG QUI PEUT ÉCHOUER : quand HubSpot
    // n'est pas configuré, il devient une fonction qui ne fait RIEN et qui RÉUSSIT. Un no-op qui réussit laisse
    // l'ordre vrai (rien à flaguer, donc rien qui puisse rater), là où un no-op qui throw bloquerait la clôture
    // de tous les injoignables des espaces sans CRM.
    const flagUnreachable = config.HUBSPOT_SERVICE_URL
      ? async (tenantId: string, e164: string): Promise<void> => {
          await flagContactUnreachable({ baseUrl: config.HUBSPOT_SERVICE_URL, secret: config.HUBSPOT_SERVICE_SECRET, transport }, tenantId, e164);
        }
      : async (): Promise<void> => {};
    const retrySweep = async (): Promise<void> => {
      const res = await runRetrySweep({
        isMorningWindow: () => isMorningParis(Date.now()),
        list131049: () => repo.listRetry131049(Date.now()),
        list131026: () => repo.listRetry131026(),
        list131026SecondFail: () => repo.listRetry131026SecondFail(),
        resetForRetry: (id) => repo.resetForRetry(id),
        markUnreachableDone: (id) => repo.markUnreachableDone(id),
        // 🔴 DIMENSIONNER l'expiration, comme les trois autres enfileurs de cette file. Cet appel était le
        // SEUL à passer par `queue.enqueue` nu : il retombait donc sur le défaut de 15 minutes, alors qu'une
        // relance de plus de ~450 destinataires (à 30/min) dure plus longtemps que ça. Le job expirait en
        // plein envoi, pg-boss le rejouait, et le run reparti en parallèle appliquait SON propre limiteur de
        // débit : le débit réel doublait. Le plafond de 23 h posé par le lot « journée 1 » ne protégeait pas
        // ce chemin, qui n'en passait simplement pas.
        enqueueRun: async (id) => {
          const sizing = await repo.getRunSizing(id);
          // Campagne introuvable (supprimée entre la liste et la relance) : rien à réenfiler.
          if (!sizing) return;
          await relancerCampagne({ campaignId: id, ...sizing });
        },
        flagUnreachable,
        noterJoignabilite: noterJoignabiliteContact,
        // La bascule d'étage : seules les campagnes à repli y passent, et il n'y en a aucune tant
        // qu'une chaîne à plus d'un étage n'est pas créable. Le câblage est posé maintenant pour que
        // le jour où elle le sera, il n'y ait plus qu'à lui apprendre à envoyer le bon contenu.
        listCandidatsBascule: () => repo.listCandidatsBascule(),
        basculerEtage: (id, rang) => repo.basculerEtage(id, rang),
        // L'horaire du RATTRAPAGE, distinct de celui de l'envoi initial (`business_hours_only`, lu
        // par le moteur). Ici c'est l'espace qui parle, pas la campagne : la campagne dit seulement
        // si elle s'en affranchit (`rattrapage_hors_horaires`), et cette réponse-là voyage avec le
        // destinataire.
        fenetreOuverte: async (tenant: string) => {
          const s = await settingsStore.get(tenant);
          return fenetreDeRattrapageOuverte(new Date(), s.timezone, s.businessHours);
        },
      });
      // eslint-disable-next-line no-console
      if (res.retried > 0 || res.flagged > 0 || res.bascules > 0) console.log(`retry-sweep: ${res.retried} relancé(s), ${res.flagged} injoignable(s), ${res.bascules} bascule(s) d'étage`);
    };
    taches.programmer('auto-relance-echecs', config.AUTO_RETRY_SWEEP_INTERVAL_MS, retrySweep, { immediat: true, enEchec: echecDeBalayage('retry-sweep', 'sweeper:retry') });
  }

  // Sweeper de CONTRÔLE : rend la main au scénario quand plus personne ne s'occupe d'une conversation.
  // Il n'existe AUCUN release automatique côté Meta : sans ce balayage, un opérateur qui ferme son onglet
  // (ou un worker qui meurt) gèlerait la conversation indéfiniment, scénario muet et client sans réponse.
  // C'est la soupape de la capacité de gel, elle part donc dans le même déploiement qu'elle.
  const controlSweep = async (): Promise<void> => {
    const rendues = await runControlSweep({
      /**
       * 🔴 LES DEUX ARGUMENTS, ET LE SECOND MANQUAIT (mesuré en production le 2026-09-15).
       *
       * Cette flèche n'en déclarait qu'UN. Le balayage appelle pourtant
       * `listHeldControl(undefined, timeouts.app_workflow)` : TypeScript accepte une flèche à un
       * paramètre là où le contrat en déclare deux, et le second était AVALÉ EN SILENCE. Le magasin
       * retombait donc sur son défaut `ageScenarioMs = 0`, or son SQL teste `$2::bigint > 0` : la
       * branche qui ramasse les fils tenus par un scénario ne se déclenchait JAMAIS.
       *
       * 🔴 CONSÉQUENCE MESURÉE : la soupape des 24 h sur `app_workflow`, écrite le 2026-09-14, n'a
       * jamais rien ramassé. Avec 0 elle rendait 0 conversation ; avec la valeur prévue, 10, toutes
       * gelées depuis. Un parcours terminé gardait le fil INDÉFINIMENT, pas 24 h.
       *
       * ⚠️ C'est exactement le piège écrit dans le CLAUDE.md du dépôt (« une flèche à deux paramètres
       * est assignable à un contrat qui en déclare trois, et le troisième est avalé en silence »), et
       * il s'est reproduit ici. Aucun test ne pouvait le voir : ils montent tous un faux `listHeldControl`
       * dont ils contrôlent la signature.
       */
      listHeldControl: (limit, ageScenarioMs) => inboxStore.listHeldControl(limit, ageScenarioMs),
      setControlOwner: (t, w, o, opts) => inboxStore.setControlOwner(t, w, o, opts),
      // Défauts du serveur, appliqués aux clients qui n'ont rien réglé.
      timeouts: { app_human: config.CONTROL_HUMAN_TIMEOUT_MS, mba: config.CONTROL_MBA_TIMEOUT_MS, app_workflow: config.CONTROL_WORKFLOW_TIMEOUT_MS },
      // Réglage par client du gel humain : c'est lui qui décide combien de temps on laisse un
      // opérateur travailler tranquille avant que la conversation reparte.
      handbackMsByTenant: (ids) => settingsStore.handbackMsByTenant(ids),
      // Destination : l'agent de Meta chez les clients qui l'ont allumé, le scénario chez les autres. Plus
      // rien à arbitrer, la règle se déduit de l'état du compte.
      mbaActifParTenant: (ids) => settingsStore.mbaActifParTenant(ids),
      /**
       * 🔴 LE VERDICT DE `rendreLeFil` EST RELAYÉ DEPUIS LE 2026-09-15, il était JETÉ ICI.
       *
       * Le commentaire d'avant l'assumait : « le verdict est IGNORÉ ici, et seulement ici : le balayage est
       * best-effort, un fil ne doit pas rester gelé pour toujours à cause d'un hoquet réseau. » C'est
       * précisément ce best-effort qui a produit l'incident : neuf conversations annonçant `mba` alors que
       * Meta pensait le contraire, donc deux systèmes qui se croyaient chacun déchargés du client.
       *
       * ⚠️ Et la crainte ne se réalisait pas : refuser d'écrire ne GÈLE rien. La conversation reste dans
       * l'état où elle est, donc VISIBLE dans « À traiter », et ce balayage repasse toutes les cinq minutes.
       */
      /**
       * ⚠️ LE BALAYAGE VEUT SAVOIR SI META A CONFIRMÉ, et rien d'autre : « aucun numéro » comme
       * « conversation de test » veulent dire « ne compte pas celle-là comme rendue ». C'est bien un
       * booléen ici, DÉRIVÉ du verdict à trois états plutôt que confondu avec lui : c'est cette confusion
       * qui a fait annoncer comme rendus des fils que l'application détenait encore.
       */
      releaseToMba: async (tenant, waId) => (await releaseThreadChezMeta(tenant, waId)) === 'rendu',
    });
    // eslint-disable-next-line no-console
    if (rendues > 0) console.log(`control-sweep: ${rendues} conversation(s) rendue(s) au scénario`);
  };
  taches.programmer('reprise-controle', config.CONTROL_SWEEP_INTERVAL_MS, controlSweep, { immediat: true, enEchec: echecDeBalayage('control-sweep', 'sweeper:control') });

  // Passage de main de l'agent selon les heures d'ouverture. Meta n'a AUCUNE notion d'horaires : sans ce
  // balayage, un agent qui passe la main la passe aussi à 3 h du matin, et le client lit « un conseiller
  // arrive » quand personne n'est là. Ne concerne que les tenants ayant choisi ce mode ; les deux autres
  // choix sont écrits une fois, au moment du choix.
  const cibleHandoff = {
    clientFor: (tenant: string) => metaFactory.mbaClientForTenant(tenant),
    phoneNumberFor: (tenant: string) => repo.getTenantPhoneNumberId(tenant),
  };
  const handoffSweep = async (): Promise<void> => {
    const bascules = await runHandoffSweep({
      tenantsHandoffSurHoraires: () => settingsStore.tenantsHandoffSurHoraires(),
      lireHandoffEnabled: (tenant) => lireHandoffEnabled(cibleHandoff, tenant),
      ecrireHandoffEnabled: (tenant, enabled) => ecrireHandoffEnabled(cibleHandoff, tenant, enabled),
    });
    // eslint-disable-next-line no-console
    if (bascules > 0) console.log(`handoff-sweep: ${bascules} tenant(s) basculé(s) sur les heures d'ouverture`);
  };
  taches.programmer('handoff-mba', config.CONTROL_SWEEP_INTERVAL_MS, handoffSweep, { immediat: true, enEchec: echecDeBalayage('handoff-sweep', 'sweeper:handoff') });

  // Sweeper d'idempotence API : purge les clés plus vieilles que leur durée de vie (`DUREE_CLE_IDEMPOTENCE_MS`),
  // la MÊME que celle du claim. Le store la prend pour plancher : une purge plus courte ferait envoyer deux fois.
  const idempotencyStore = new PgApiIdempotencyStore(pool);
  const webhookStore = new PgWebhookStore(pool);
  const idempotencySweep = async (): Promise<void> => {
    const n = await idempotencyStore.sweepOlderThan(DUREE_CLE_IDEMPOTENCE_MS);
    // eslint-disable-next-line no-console
    if (n > 0) console.log(`idempotency-sweep: ${n} clé(s) d'idempotence purgée(s)`);
  };
  taches.programmer('idempotence-api', 60 * 60 * 1000, idempotencySweep, { immediat: true, enEchec: echecDeBalayage('idempotency-sweep', 'sweeper:idempotency') });

  // RGPD : le dernier payload d'un webhook entrant est du JSON TIERS, donc potentiellement des données
  // personnelles qu'on n'a pas demandées. Il n'existe que pour construire le mapping dans l'écran et pour
  // déboguer ; passé une semaine sans appel, il n'a plus d'utilité et il est effacé.
  const webhookPayloadSweep = async (): Promise<void> => {
    const n = await webhookStore.purgeStalePayloads(config.WEBHOOK_PAYLOAD_RETENTION_DAYS);
    // eslint-disable-next-line no-console
    if (n > 0) console.log(`webhook-payload-sweep: ${n} payload(s) dormant(s) effacé(s)`);
  };
  taches.programmer('retention-payloads-webhooks', 6 * 60 * 60 * 1000, webhookPayloadSweep, { immediat: true, enEchec: echecDeBalayage('webhook-payload-sweep', 'sweeper:webhook-payload') });

  // RGPD, et croissance non bornée (PLAN.md 5.2) : `webhook_events` garde le payload COMPLET de chaque
  // événement Meta reçu depuis le premier jour, donc le texte des messages entrants et le numéro de qui
  // écrit. Elle n'a jamais eu de purge. Elle ne sert qu'à l'idempotence (fenêtre de quelques minutes) et au
  // débogage d'un incident ; passé la rétention, elle ne garde plus que des données personnelles.
  //
  // Toutes les heures et non toutes les six : la première purge d'une table qui n'en a jamais eu s'étale sur
  // plusieurs passages (l'effacement est borné pour ne pas tenir un verrou ni gonfler le WAL d'un coup).
  const webhookEventsSweep = async (): Promise<void> => {
    const n = await eventStore.purgeOlderThan(config.WEBHOOK_EVENTS_RETENTION_DAYS);
    // eslint-disable-next-line no-console
    if (n > 0) console.log(`webhook-events-sweep: ${n} événement(s) Meta effacé(s) (rétention ${config.WEBHOOK_EVENTS_RETENTION_DAYS} j)`);
  };
  taches.programmer('retention-evenements-meta', 60 * 60 * 1000, webhookEventsSweep, { immediat: true, enEchec: echecDeBalayage('webhook-events-sweep', 'sweeper:webhook-events') });

  /**
   * LES AGREGATS JOURNALIERS, ECRITS AVANT QUE LA PURGE N EFFACE CE QUI LES PRODUIT.
   *
   * 🔴 L ORDRE EST LE SUJET DE CE BLOC, ET IL EST MECANIQUE, PAS DOCUMENTAIRE. Supprimer une
   * conversation supprime son analyse EN CASCADE. Descendre la retention a 90 jours avec une table
   * d agregats vide effacerait donc des mois d historique SANS jamais l avoir agrege, et c est
   * irrecuperable : on ne reconstruit pas une analyse qu on ne reanalyse pas. Le balayage est donc
   * ATTENDU ici, et la purge ne part PAS si il a echoue.
   *
   * 🔴 UN SEUL PASSAGE COUVRE TOUT, ET C EST CE QUI SUPPRIME LA FENETRE DANGEREUSE. Un balayage qui ne
   * traiterait que « la veille » laisserait, au premier demarrage apres le changement de retention,
   * tout l historique anterieur sans agregat. Ici une seule instruction recalcule chaque journee
   * encore presente, de TOUS les espaces, en `on conflict do update` : idempotente et rejouable.
   *
   * ⚠️ UNE TACHE PROGRAMMEE ET PAS UNE FILE pg-boss, contrairement a ce que le plan annoncait. Les
   * autres retentions de ce worker sont des taches programmees ; inscrire ce balayage dans
   * `BASE_QUEUES` ferait chercher a `/ops` une file qui n existe pas.
   *
   * ⚠️ 400 JOURS EN ARRIERE AU MINIMUM, un peu plus que la plage maximale d un ecran (366) : ce qui sort
   * de la fenetre d affichage n a aucun lecteur, et remonter plus loin SANS RAISON ferait balayer la
   * table d analyses entiere a chaque passage pour des journees que personne ne demandera.
   *
   * 🔴 MAIS LA FENETRE DESCEND PLUS BAS DES QUE LA DONNEE L EXIGE, ET C EST UNE CORRECTION DE REVUE
   * (2026-09-17). 400 etait un nombre en dur, alors qu un espace peut regler sa retention jusqu a 3650
   * jours et que le levier d urgence peut suspendre la purge aussi longtemps qu on veut. Dans ces deux
   * cas, des analyses de plus de 400 jours SURVIVENT, sortent de la fenetre, et seraient effacees le jour
   * ou la purge reprend sans avoir jamais ete agregees : perdues pour toujours, sans une erreur. La borne
   * basse est donc desormais le PLUS ANCIEN JOUR ENCORE PRESENT quand il est plus vieux que 400 jours.
   *
   * ⚠️ ELLE NE GROSSIT QUE QUAND LE RISQUE EXISTE : tant que rien ne depasse 400 jours, elle vaut 400
   * jours, et le cout ne bouge pas. Elle s etend exactement de ce qui pourrait etre perdu, jamais plus.
   */
  const conversationStatsStore = new PgConversationStatsStore(pool, true, config.CONVERSATION_RETENTION_DAYS);
  const agregatsSweep = async (): Promise<number> => {
    const jusqua = todayParis();
    const plancher = addDays(jusqua, -400);
    // `null` = aucune analyse en base, il n y a donc rien a agreger plus loin que le plancher.
    const plusAncien = await conversationStatsStore.plusAncienJourAnalyse();
    const depuis = plusAncien !== null && plusAncien < plancher ? plusAncien : plancher;
    return conversationStatsStore.ecrireAgregats({ from: depuis, to: jusqua });
  };

  /**
   * 🔴 CE DRAPEAU EST LA GARDE, ET IL EXISTE PARCE QU UN COMMENTAIRE NE GARDE RIEN. Une premiere
   * redaction attrapait l erreur du balayage et affirmait en commentaire que « la purge ne partira
   * pas » : le `catch` la laissait partir. Une justification fausse est pire qu aucune, parce qu elle
   * sera crue. Ici, l echec du balayage EMPECHE reellement la purge de ce demarrage.
   *
   * ⚠️ LE WORKER DEMARRE QUAND MEME : l inbox, les campagnes et les scenarios ne doivent pas s arreter
   * parce qu un agregat manque. Ce qui est suspendu, c est la seule operation IRREVERSIBLE.
   */
  let agregatsAJour = false;
  try {
    const n = await agregatsSweep();
    agregatsAJour = true;
    // eslint-disable-next-line no-console
    if (n > 0) console.log(`agregats-analyse: ${n} journee(s) ecrite(s) ou mise(s) a jour`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('agregats-analyse erreur:', messageDe(err));
    alert('sweeper:agregats-analyse', `agregats-analyse en echec, la purge des conversations est SUSPENDUE pour ce demarrage : ${messageDe(err)}`);
  }
  taches.programmer('agregats-analyse', 6 * 60 * 60 * 1000, async () => {
    try {
      const n = await agregatsSweep();
      agregatsAJour = true;
      // eslint-disable-next-line no-console
      if (n > 0) console.log(`agregats-analyse: ${n} journee(s) ecrite(s) ou mise(s) a jour`);
    } catch (err) {
      // ⚠️ Le drapeau retombe : un balayage en echec doit SUSPENDRE la purge, pas seulement au
      // demarrage. Sans cela, une panne qui dure verrait la purge continuer a effacer sans trace.
      agregatsAJour = false;
      // eslint-disable-next-line no-console
      console.error('agregats-analyse erreur:', messageDe(err));
      alert('sweeper:agregats-analyse', `agregats-analyse en echec, la purge des conversations est SUSPENDUE : ${messageDe(err)}`);
    }
  });
  // RGPD (PLAN.md 5.2, lot 2) : les CONVERSATIONS et, par cascade, leurs messages et leur analyse
  // qualitative. C'est la rétention la plus lourde de conséquence du dépôt, parce qu'elle efface du contenu
  // que le client voit dans son inbox : d'où une durée quatre fois supérieure au plancher demandé, et un
  // journal qui dit combien sont parties à chaque passage.
  //
  // Toutes les 6 heures : la rétention se compte en mois, la minute de balayage n'a aucune importance, et
  // l'effacement est borné par passage de toute façon.
  const conversationSweep = async (): Promise<void> => {
    /**
     * 🔴 LA SEULE OPERATION IRREVERSIBLE DU DEPOT NE PART PAS SANS SA CONTREPARTIE. Si le balayage des
     * agregats a echoue, effacer une conversation detruirait aussi son analyse EN CASCADE, sans que
     * rien n en garde la trace. On saute ce passage : la retention se compte en mois, six heures de
     * retard ne coutent rien, quand un effacement ne se rattrape jamais.
     */
    if (!agregatsAJour) {
      // eslint-disable-next-line no-console
      console.warn('conversation-retention-sweep: SAUTE, les agregats journaliers ne sont pas a jour.');
      return;
    }
    const n = await inboxStore.purgeConversationsOlderThan(config.CONVERSATION_RETENTION_DAYS);
    // eslint-disable-next-line no-console
    if (n > 0) console.log(`conversation-retention-sweep: ${n} conversation(s) effacée(s) (rétention ${config.CONVERSATION_RETENTION_DAYS} j)`);
  };
  taches.programmer('retention-conversations', 6 * 60 * 60 * 1000, conversationSweep, { immediat: true, enEchec: echecDeBalayage('conversation-retention-sweep', 'sweeper:conversation-retention') });

  /**
   * Les QUATRE dernières tables qui grossissaient sans fin (lot 4 du programme II).
   *
   * 🔴 UN SEUL balayage, mais quatre étapes INDÉPENDANTES : chacune a son `try`, donc une base qui refuse une
   * purge n'empêche pas les trois autres de passer. Les regrouper dans une tâche unique évite quatre entrées
   * de plus dans le registre pour un travail qui se compte en millisecondes et qui a la même cadence.
   *
   * ⚠️ Les deux natures ne font PAS la même chose, et c'est voulu :
   *  - les événements de blocs sont ANONYMISÉS, jamais supprimés. Ils SONT la mesure des tableaux, et il n'y a
   *    aucune statistique rétroactive : les effacer viderait l'historique du client pour retirer un numéro.
   *  - les parcours terminés, les clics et le journal sont SUPPRIMÉS. Personne ne les relit.
   */
  const retentionSweep = async (): Promise<void> => {
    const etape = async (nom: string, quoi: string, faire: () => Promise<number>): Promise<void> => {
      try {
        const n = await faire();
        // eslint-disable-next-line no-console
        if (n > 0) console.log(`retention-sweep: ${n} ${quoi}`);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`retention-sweep (${nom}) erreur:`, messageDe(err));
        alert(`sweeper:retention:${nom}`, `retention-sweep ${nom} en échec : ${messageDe(err)}`);
      }
    };
    await etape('blocs', `événement(s) de bloc anonymisé(s) (au-delà de ${config.NODE_EVENTS_ANONYMISATION_DAYS} j)`,
      () => nodeEventStore.anonymiserAnciens(config.NODE_EVENTS_ANONYMISATION_DAYS));
    await etape('parcours', `parcours terminé(s) effacé(s) (au-delà de ${config.WORKFLOW_RUNS_RETENTION_DAYS} j)`,
      () => runStore.purgeTerminesOlderThan(config.WORKFLOW_RUNS_RETENTION_DAYS));
    await etape('clics', `clic(s) tracé(s) effacé(s) (au-delà de ${config.TRACKED_CLICKS_RETENTION_DAYS} j)`,
      () => trackedLinkStore.purgeClicsOlderThan(config.TRACKED_CLICKS_RETENTION_DAYS));
    await etape('audit', `entrée(s) de journal effacée(s) (au-delà de ${config.AUDIT_LOG_RETENTION_DAYS} j)`,
      () => auditStore.purgeOlderThan(config.AUDIT_LOG_RETENTION_DAYS));
    // Les échecs d'avance sont de l'EXPLOITATION, pas une preuve : ils se purgent, contrairement au journal
    // d'audit qui, lui, est immuable par construction.
    await etape('avances', `échec(s) d’avance effacé(s) (au-delà de ${config.AVANCE_ECHECS_RETENTION_DAYS} j)`,
      () => erreursLivraison.purgeEchecsAvanceOlderThan(config.AVANCE_ECHECS_RETENTION_DAYS));
    // Les échecs de messages libres (migration 0175) : même nature, même rétention que les échecs d'avance.
    await etape('messages', `échec(s) de message libre effacé(s) (au-delà de ${config.AVANCE_ECHECS_RETENTION_DAYS} j)`,
      () => echecsMessages.purgerAvant(config.AVANCE_ECHECS_RETENTION_DAYS));
    await etape('pool', `minute(s) d’attente du pool effacée(s) (au-delà de ${config.POOL_ATTENTES_RETENTION_DAYS} j)`,
      () => poolAttentes.purgeOlderThan(config.POOL_ATTENTES_RETENTION_DAYS));
    // Les essais du bac a sable. Retention COURTE et en dur (14 j) : ce ne sont pas des conversations de
    // clients, ils ne portent ni contact ni `wa_id`, seulement ce que l'administrateur a tape lui-meme.
    await etape('essais', `essai(s) d’agent effacé(s) (au-delà de ${RETENTION_ESSAIS_JOURS} j)`,
      () => essaisStore.purger(RETENTION_ESSAIS_JOURS));
  };
  taches.programmer('retention-generale', 6 * 60 * 60 * 1000, retentionSweep, { immediat: true });

  // Déclencheur « X avant la date d'un champ » : le seul qui ne répond pas à un événement mais à
  // l'écoulement du temps. Il PUBLIE dans la file, il ne démarre rien : le scénario part par le chemin
  // commun, donc avec les mêmes garde-fous que les autres déclencheurs.
  const dateSweep = async (): Promise<void> => {
    const n = await runDateSweep({
      tenants: () => automationStore.tenantsAvecDeclencheurDate(),
      automations: (tenant) => automationStore.listEnabled(tenant, ['avant_date']),
      timeZone: async (tenant) => (await settingsStore.get(tenant)).timezone,
      candidats: (tenant, autoId, cle, basse, haute) => automationStore.contactsDusPourDate(tenant, autoId, cle, basse, haute),
      publish: async (tenantId, event) => { await enfilerEvenementAutomation(queue, { tenantId, event } satisfies AutomationEventJob); },
      toleranceMinutes: config.AUTOMATION_DATE_TOLERANCE_MINUTES,
      // eslint-disable-next-line no-console
      log: (m) => console.log(m),
    });
    // eslint-disable-next-line no-console
    if (n > 0) console.log(`date-sweep: ${n} échéance(s) publiée(s)`);
  };
  taches.programmer('automations-avant-date', config.AUTOMATION_DATE_SWEEP_INTERVAL_MS, dateSweep, { immediat: true, enEchec: echecDeBalayage('date-sweep', 'sweeper:date') });

  /**
   * LE RISQUE DE DÉSENGAGEMENT, UNE FOIS PAR NUIT ET PAR ESPACE (lot 7 de l'API publique, spec § 19).
   *
   * La tâche passe tous les quarts d'heure, et ne balaye qu'entre 3 h et 6 h (Paris), une fois par jour
   * (`jourABalayer`). Chaque espace est isolé (`balayerRisque`) : une panne d'un espace est dans son bilan et
   * dans ce journal, le suivant passe. Le câblage est PARTAGÉ avec `/ops` (`src/engagement/cablage.ts`).
   *
   * 🔴 C'EST LE SEUL CHEMIN DE MASSE QUI ÉMET UN ÉVÉNEMENT D'AUTOMATION (`risque_eleve`), par exception décidée :
   * ses trois bornes sont écrites au point d'émission (`src/engagement/balayage.ts`).
   */
  const depsRisque = depsBalayageRisque({
    pool,
    file: queue,
    emetteur,
    automationsActives: (t, kinds) => automationStore.listEnabled(t, kinds),
    // eslint-disable-next-line no-console
    journal: (m) => console.warn(m),
  });
  let dernierJourRisque: string | null = null;
  const risqueSweep = async (): Promise<void> => {
    const jour = jourABalayer(new Date(), dernierJourRisque);
    if (jour === null) return;
    const bilans = await balayerRisque(depsRisque);
    // APRÈS le tour des espaces : une liste d'espaces illisible (base indisponible) sera retentée au quart
    // d'heure suivant, tant que la fenêtre de nuit est ouverte.
    dernierJourRisque = jour;
    const enEchec = bilans.filter((b) => b.erreur !== undefined);
    const total = bilans.reduce((s, b) => ({
      evalues: s.evalues + b.evalues, transitions: s.transitions + b.transitions,
      declenches: s.declenches + b.declenches, auDelaDuPlafond: s.auDelaDuPlafond + b.auDelaDuPlafond,
    }), { evalues: 0, transitions: 0, declenches: 0, auDelaDuPlafond: 0 });
    // eslint-disable-next-line no-console
    console.log(`risque-sweep ${jour}: ${bilans.length} espace(s), ${total.evalues} fiche(s), ${total.transitions} changement(s) de niveau, ${total.declenches} automation(s) « risque élevé », ${total.auDelaDuPlafond} au-delà du plafond, ${enEchec.length} espace(s) en échec`);
    for (const b of bilans) {
      // eslint-disable-next-line no-console
      if (b.transitions > 0 || b.erreur !== undefined) console.log(`risque-sweep ${jour}: ${JSON.stringify(b)}`);
    }
    if (enEchec.length > 0) alert('sweeper:risque', `risque-sweep : ${enEchec.length} espace(s) en échec, dont ${enEchec[0]!.tenantId} : ${enEchec[0]!.erreur}`);
  };
  taches.programmer('risque-desengagement', 15 * 60_000, risqueSweep, { enEchec: echecDeBalayage('risque-sweep', 'sweeper:risque') });

  // Sorti de la garde META_ACCESS_TOKEN ci-dessous : la surveillance des files ne touche pas Meta, et un
  // déploiement sans token Meta ne doit pas devenir aveugle aux messages perdus.
  const opsStore = new PgOpsStore(pool, config.PGBOSS_SCHEMA);

  // Surveillance des DEAD LETTER QUEUES. Un job qui épuise ses rejeux y atterrit, et RIEN ne les consomme :
  // sans cette alerte, la perte est totalement silencieuse. Constaté le 2026-08-25 : un message client entrant
  // dormait dans `webhook-dlq` depuis le 2026-08-17, jamais signalé. Cadence 5 min, alignée sur le throttle
  // d'alerte ; le balayage n'alerte QUE sur une hausse (cf. `dlq-sweep.ts`), sinon la condition étant permanente
  // il enverrait un Telegram toutes les 5 minutes à vie.
  const dlqSweep = creerDlqSweep({
    queueLoad: () => opsStore.getQueueLoad(),
    // Clé d'alerte PAR FILE : deux DLQ qui se remplissent en même temps doivent produire deux messages, sinon
    // le throttle de 5 min en masquerait une. La dédup sur la répétition est faite par le balayage lui-même.
    alert: (queue, m) => alert(`dlq:${queue}`, m),
  });
  // `creerDlqSweep` porte AUSSI sa propre garde de RÉ-ENTRANCE, en plus de celle du registre : elle est
  // indissociable du compteur qu'elle protège, et testable là-bas.
  const dlqSweepGarde = async (): Promise<void> => {
    const n = await dlqSweep();
    // Une alerte qui part sans laisser de trace est indiagnosticable : si le Telegram n'arrive pas, rien ne
    // dit si elle a été émise. C'est précisément le défaut que ce lot corrige ailleurs (le balayage des
    // campagnes programmées était muet). Même forme que les autres sweepers : on ne logue que l'effet.
    // eslint-disable-next-line no-console
    if (n > 0) console.log(`dlq-sweep: ${n} file(s) d'échec en hausse, alerte émise`);
  };
  taches.programmer('files-echec', 5 * 60_000, dlqSweepGarde, { immediat: true, enEchec: echecDeBalayage('dlq-sweep', 'sweeper:dlq') });

  /**
   * « Les webhooks arrivent, mais plus rien ne s'écrit. »
   *
   * 🔴 LA SEULE SONDE DU PARC QUI VÉRIFIE UN EFFET, PAS UNE RÉPONSE. Pendant deux jours (2026-09-08 au
   * 2026-09-10), l'agent de Meta a répondu aux clients à notre place et nous n'avons rien enregistré :
   * UptimeRobot vert, `/health` à 200, conteneurs `healthy`, jobs « terminés avec succès ». Un extracteur
   * qui ne trouve rien rend un tableau vide, ce qui n'est pas une erreur. Le détail du raisonnement (et
   * pourquoi on compare les REÇUS aux ENREGISTRÉS) est dans `ops/webhooks-muets-sweep.ts`.
   *
   * Cadence 5 min sur une fenêtre de 60 min : le silence se constate sur la durée, pas sur l'instant.
   */
  const webhooksMuets = creerWebhooksMuetsSweep({
    recus: (min) => opsStore.webhooksRecusDepuis(min),
    enregistres: (min) => opsStore.evenementsWebhookDepuis(min),
    alert: (msg) => alert('webhooks-muets', msg),
  });
  taches.programmer('webhooks-muets', 5 * 60_000, async () => { await webhooksMuets(); }, {
    immediat: true,
    // eslint-disable-next-line no-console
    enEchec: (err) => console.error('webhooks-muets-sweep erreur:', messageDe(err)),
  });

  // Sweeper de STATUT/QUALITÉ des numéros (item 4.10). Le pull live n'était branché QUE dans la route Accueil :
  // quality_rating/status ne se rafraîchissaient qu'à l'ouverture de la page par un admin. Ce balayage les
  // rafraîchit tous (cross-tenant, lecture Graph seule) et alerte sur jeton invalide / numéro non connecté /
  // qualité rouge. Palliatif par polling (le temps réel = webhook quality, non câblé, cf. migration 0004).
  // GATE : sans token Meta global, aucun pull possible (mêmes conditions que la route, index.ts) -> pas de sweep
  // (évite un faux « AUTH » sur un client vide en dev/test). alertedPhones dédup par TRANSITION (perdu au restart).
  if (config.META_ACCESS_TOKEN) {
    const alertedPhones = new Map<string, PhoneProblem>();
    const statusSweep = async (): Promise<void> => {
      const n = await runPhoneStatusSweep({
        listNumbers: () => opsStore.listNumbersForStatusSweep(),
        // Pull PAR TENANT (B1, repli global en sommeil) + waba_id DE LA LIGNE (bon WABA en multi-WABA). Un échec
        // devient un PullResult (pullFromError -> authError), jamais un throw : la garde d'auth reste dérivable.
        pull: async (num) => {
          try {
            const client = await metaFactory.phoneClientForTenant(num.tenantId);
            const info = await client.get(num.id);
            const waba = num.wabaId ? await client.getWabaHealth(num.wabaId).catch(() => undefined) : undefined;
            return pullFromInfo(info, waba);
          } catch (err) {
            return pullFromError(err);
          }
        },
        save: (id, patch) => phoneStatusStore.saveStatus(id, patch),
        alert: (msg) => { void sendTelegram(`[mba-worker] ${msg}`); },
        alertedState: alertedPhones,
      });
      // eslint-disable-next-line no-console
      if (n > 0) console.log(`phone-status-sweep: ${n} alerte(s) de statut numéro`);
    };
    taches.programmer('statut-numeros', config.PHONE_STATUS_SWEEP_INTERVAL_MS, statusSweep, { immediat: true, enEchec: echecDeBalayage('phone-status-sweep', 'sweeper:phone-status') });
  }

  /**
   * LE SUIVI DES PUBLICITÉS (lot 3, commit 3, spec § 3.5) : deux appels par compte connecté, toutes les
   * quinze minutes, pour relire statuts, motifs de refus, dépense et clics.
   *
   * 🔴 QUINZE MINUTES, ET LE CHIFFRE VIENT DE META, PAS DE NOUS : c'est la cadence à laquelle il rafraîchit
   * lui-même la dépense d'une campagne. Interroger plus souvent relirait le MÊME chiffre en consommant du
   * quota sur un compte en niveau « Limited », c'est-à-dire en rapprochant le client du jour où Meta bride
   * aussi ses créations.
   *
   * ⚠️ IL NE TOURNE QUE SI LES PUBLICITÉS SONT CONFIGURÉES. Sans `META_ADS_CONFIG_ID`, aucun espace ne peut
   * s'être connecté, donc ce balayage ne trouverait rien et n'appellerait rien : le monter quand même serait
   * une requête toutes les quinze minutes pour confirmer qu'il n'y a rien à faire.
   */
  if (config.META_ADS_CONFIG_ID) {
    const suivrePubs = async (): Promise<void> => {
      const bilan = await balayerLesPubs({
        espacesASuivre: () => publicitesStore.espacesASuivre(),
        campagnesASuivre: (t) => publicitesStore.campagnesASuivre(t),
        jeton: async (t) => {
          const chiffre = await connexionsPubStore.lireJetonChiffre(t);
          return chiffre === null ? null : decryptSecret(chiffre, config.ENCRYPTION_KEY);
        },
        lireCampagnes: (ids, jeton) => clientPubsCreation.lireCampagnes(ids, jeton),
        lireDepenses: (ids, jeton) => clientPubsCreation.lireDepenses(ids, jeton),
        noterSuivi: (t, campagneId, v) => publicitesStore.noterSuivi(t, campagneId, {
          statutMeta: v.etat?.statut ?? null,
          motifRefus: v.etat?.motifRefus ?? null,
          debut: v.etat?.debut ?? null,
          fin: v.etat?.fin ?? null,
          budgetTotal: v.etat?.budgetTotal ?? null,
          depense: v.depense?.depense ?? null,
          clics: v.depense?.clics ?? null,
        }),
        marquerJetonRejete: (t) => connexionsPubStore.marquerJetonRejete(t),
        // 🔴 SUR LE CODE DE META, JAMAIS SUR LA PHRASE : un message se reformule, et une garde qui lit une
        // phrase casse en silence le jour où Meta la réécrit.
        estJetonRefuse,
        alerter: (sujet, message) => { alert(sujet, message); },
      });
      if (bilan.campagnes > 0 || bilan.jetonsRejetes > 0) {
        // eslint-disable-next-line no-console
        console.log(`suivi-pubs: ${bilan.campagnes} campagne(s) relue(s) sur ${bilan.espaces} espace(s), ${bilan.jetonsRejetes} jeton(s) rejeté(s)`);
      }
    };
    taches.programmer('suivi-pubs', SUIVI_PUBS_INTERVALLE_MS, suivrePubs, { immediat: true });
  }


  // ---------- File `agent-turn` : LE TOUR D'AGENT, en production (dettes D2 et D4) ----------
  //
  // 🔴 CE QUI CHANGE ICI, ET POURQUOI C'EST LE DERNIER VERROU. Tout le bloc agent existait sans être branché
  // nulle part : la file n'avait aucun consommateur, donc un bloc agent posé dans un scénario était traversé
  // comme un PASSE-PLAT, le parcours continuait, et personne ne voyait rien. Ce sont les résolveurs RÉELS
  // qui sont câblés ici, pas ceux du bac à sable de la console : poser un tag écrit vraiment, envoyer un
  // bloc part vraiment chez le contact.
  //
  // ⚠️ Sans clé de Gateway, la file n'est PAS consommée. C'est délibéré : un consommateur qui échouerait à
  // chaque job enverrait les tours en DLQ et perdrait les conversations, alors qu'un job qui attend repart
  // dès que la clé est posée.
  // ⚠️ MEME resolveur de cle par espace que dans l'API : c'est ICI que passent les tours d'agent des vrais
  // clients, donc l'essentiel de la depense. Le cabler d'un seul cote aurait attribue le bac a sable et
  // laisse la production dans le pot commun, ce qui est le pire des deux mondes (on croirait mesurer).
  const clesGatewayWorker = new PgCleGatewayStore(
    pool,
    (clair) => encryptSecret(clair, config.ENCRYPTION_KEY),
    (chiffre) => decryptSecret(chiffre, config.ENCRYPTION_KEY),
  );
  const gatewayAgent = config.AI_GATEWAY_API_KEY
    ? new GatewayChatClient(config.AI_GATEWAY_API_KEY, undefined, async (tenant) => (await clesGatewayWorker.lire(tenant))?.cle ?? null)
    : null;
  if (gatewayAgent) {
    const agentStore = new PgAgentStore(pool);
    const toolCatalog = new PgToolCatalog(pool);
    const journalAppels = new PgJournalAppels(pool);
    const knowledgeStore = new PgKnowledgeStore(pool);
    // Les fiches du mode d emploi de la console (migration 0131). Elles sont vectorisees par le MEME
    // balayage que la connaissance des agents, juste en dessous.
    const depotAide = new PgDepotAide(pool);
    const rechercheSemantique = creerRechercheSemantique();
    /**
     * LE BALAYAGE QUI VECTORISE, seul endroit du depot qui calcule un vecteur de fiche. Il rattrape les
     * fiches neuves, celles dont le texte a change (leur vecteur est efface a l'edition) et celles d'un
     * ancien modele. Cadence courte : une fiche creee est trouvable par les MOTS a la seconde, par le SENS
     * au passage suivant.
     */
    if (rechercheSemantique) {
      const vectoriser = async (): Promise<void> => {
        try {
          const n = await balayerVectorisation(knowledgeStore, rechercheSemantique, config.AGENT_EMBED_MODEL);
          // eslint-disable-next-line no-console
          if (n > 0) console.log(`vectorisation: ${n} fiche(s) vectorisee(s)`);
          /**
           * 🔴 LES FICHES DU MODE D EMPLOI AUSSI, et les oublier ici rendait MUETTE la moitie semantique du
           * bot d aide : la colonne `embedding` d `aide_fiches` serait restee nulle pour toujours,
           * `chercherParVecteur` aurait toujours rendu une liste vide, et le rappel se serait reduit au plein
           * texte. Le bot aurait continue de repondre, ce qui est le pire : on perd exactement le cas pour
           * lequel le semantique existe, le client qui ne dit pas << campagne >> mais << envoyer un message a
           * toute ma liste >>. Releve a la revue du lot, le 2026-09-11.
           *
           * ⚠️ MEME MODELE que la connaissance des agents (`AGENT_EMBED_MODEL`) : les deux colonnes ont la
           * meme dimension par construction, et en prendre un autre ici rendrait les deux bases
           * incomparables sans qu aucune erreur ne le signale.
           */
          const na = await balayerVectorisation(depotAide, rechercheSemantique, config.AGENT_EMBED_MODEL);
          // eslint-disable-next-line no-console
          if (na > 0) console.log(`vectorisation: ${na} fiche(s) d aide vectorisee(s)`);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('vectorisation: lot ignore :', messageDe(err));
          // 🔴 ALERTE, comme les dix-neuf autres balayages. Ce catch etait le SEUL a ne journaliser que dans
          // les logs, parce qu'il a ete ecrit alors que la migration 0110 n'etait pas encore passee : un
          // echec etait ALORS attendu, et alerter aurait fait du bruit. Elle est passee le 2026-09-02, donc
          // un echec veut desormais dire que la base de connaissance CESSE d'etre vectorisee : l'agent
          // retombe sur la recherche par mots, en silence, et personne ne l'apprend. L'alerte est throttlee
          // a cinq minutes, un echec persistant n'inonde donc rien.
          alert('sweeper:vectorisation', `vectorisation en echec : ${messageDe(err)}`);
        }
      };
      taches.programmer('vectorisation', 60_000, vectoriser, { immediat: true });
    }
    const credits = new PgCreditStore(pool);
    const agentSources = new PgSourceStore(pool);
    // Les REQUETES de connecteur (migration 0105) : un appel mis au point une fois dans la bibliotheque du
    // workspace, que l'outil d'un agent DESIGNE au lieu de le redecrire.
    const agentRequetes = new PgRequeteStore(pool);

    // L'escalade vers un humain : trois effets dans un ordre contre-intuitif, que `escalade.ts` explique.
    const escaladerVersHumain = creerEscaladeVersHumain({
      sessions: agentSessions,
      sortirDuBlocAgent: (t, waId, sessionId, sortie) => workflowExecutor.sortirDuBlocAgent(t, waId, sessionId, sortie),
      /**
       * ⚠️ AUCUN AFFECTATAIRE ICI, ET CE N EST PAS LE MEME CHEMIN. Celle-ci est l escalade de l AGENT IA
       * (`src/agent/escalade.ts`), qui decide lui-meme de passer la main : personne n a designe de membre. Le
       * bloc « passer a un humain » d un scenario, lui, passe par `buildWorkflowRuntime`
       * (`src/workflow/wiring.ts`), qui affecte. Deux contrats voisins qui portent le meme nom : les
       * confondre reviendrait a affecter une conversation a personne, ou a chercher longtemps pourquoi
       * l affectation ne prend pas.
       */
      // 🔴 LE BOOLÉEN EST RENDU, IL N'EST PLUS AVALÉ (revue du 2026-09-18). `setControlOwner` ne rend `true`
      // que s'il a VRAIMENT basculé `app_workflow` vers `app_human`, et c'est la seule chose qui permette au
      // tour de savoir que sa garde de détenteur est fausse à cause de LUI. Le jeter ici rendait muette la
      // dernière phrase de l'agent quand l'équipe est fermée : la question à poser à un câblage est
      // « que suppose-t-il du module que je viens de changer ? », et celui-ci en suppose la réponse.
      // 🔴 `escalade: true` DEPUIS LE 2026-09-23 (arbitrage de Julien, les TROIS chemins) : un agent IA qui passe
      // la main promet la même chose que l'agent de Meta, donc la conversation entre dans « À traiter » tout de
      // suite et n'est pas rendue tant que personne n'a répondu. Le booléen rendu reste ce qu'il était.
      escalateToHuman: (t, waId) => inboxStore.setControlOwner(t, waId, 'app_human', { only: ['app_workflow'], escalade: true }),
    });

    // Les VRAIS outils maison. À comparer à `resolvers/simulation.ts`, qui sert le bac à sable : ici chaque
    // dépendance touche le monde réel, et c'est exactement ce qui les sépare.
    const resolveurMba = creerResolveurMba({
      envoyerBloc: ({ tenantId, waId, runId, workflowId, code }) =>
        workflowExecutor.envoyerBlocDepuisAgent(tenantId, waId, { runId, workflowId, code }),
      escaladerVersHumain,
      // Trois effets, pas un : le contact, le référentiel Tags, et la file d'automations. L'outil promet au
      // client de pouvoir « déclencher une automation », et un appel direct au store le ferait mentir.
      poserTag: poserTagDepuisAgent,
      // ⚠️ La CLÉ vient du modèle. La portée est bornée aux champs libres du contact COURANT (jamais l'opt-in,
      // jamais un autre contact), et la parade contre une injection est l'énumération fermée que la console
      // propose sur ce paramètre.
      ecrireChamp: async (t, waId, cle, valeur) => { await contactStore.mergeFieldsByPhone(t, waId, { [cle]: valeur }); },
      connaissance: knowledgeStore,
      // Le rappel vectoriel et le verdict du reranker (migration 0110). `null` sans cle du Gateway : la
      // recherche retombe alors sur le plein texte, comportement d'avant.
      ...(rechercheSemantique ? { recherche: rechercheSemantique } : {}),
    });

    // UN seul cerveau pour toutes les conversations de tous les clients : le contexte du tour est passé à
    // l'appel, jamais figé ici (`creerCerveauGateway`).
    const cerveau = creerCerveauGateway({
      completer: (i) => gatewayAgent.completer(i),
      // Point de lecture PARTAGÉ avec le bac à sable de la console : un champ ajouté d'un seul côté ferait
      // diverger ce que le modèle voit selon qu'on teste ou qu'on est en production.
      contexte: (t, agentId) => lireContexteAvecReglages({ agents: agentStore, outils: toolCatalog, reglages: settingsStore }, t, agentId),
      // Le Gateway facture en dollars, tous nos compteurs sont en micro-euros : la conversion se fait a l
      // entree, une seule fois, avec le taux commercial de la configuration.
      tauxEurParDollar: config.EUR_PER_USD,
      outils: {
        catalogue: toolCatalog,
        /**
         * LES GESTES DU MOMENT (migration 0158), exécutés par NOUS et pas par le modèle.
         *
         * 🔴 IL RÉUTILISE LES MÊMES IMPLÉMENTATIONS QUE LES ACTIONS `poser_tag` et `ecrire_variable`, jamais
         * une seconde écriture : deux chemins vers `contacts` finiraient par diverger sur la borne, la
         * normalisation ou l'isolation, et le jour où l'un gère l'opt-in et pas l'autre, c'est le mini-CRM
         * qui ment.
         */
        executerGeste: async (t, waId, geste) => {
          if (geste.type === 'tag') await poserTagDepuisAgent(t, waId, geste.valeur);
          else await contactStore.mergeFieldsByPhone(t, waId, { [geste.champ]: geste.valeur });
        },
        // Le VRAI journal, contrairement au bac à sable : cette table est le grand livre de facturation
        // autant que la trace d'audit, et une session existe bien ici pour la référencer.
        journal: journalAppels,
        // 🔴 Les deux familles qui EXISTENT. `mcp` n'a volontairement aucun résolveur : l'exécuteur refuse
        // alors proprement (`erreur_protocole`) plutôt que d'appeler dans le vide. Le résolveur `http` relit
        // sa source à chaque appel, donc une source désactivée cesse d'être appelée tout de suite.
        resolveurs: {
          mba: resolveurMba,
          http: creerResolveurHttp({
            sources: agentSources,
            requetes: agentRequetes,
            // Chargées PARESSEUSEMENT par le résolveur : ces deux fonctions ne sont appelées que si la requête
            // déclare une variable qui les réclame. Un connecteur qui n'envoie qu'un numéro ne coûte donc
            // aucune requête de plus.
            derniereSaisie: (t, waId) => inboxStore.derniereSaisieDuContact(t, waId),
            fuseau: async (t) => (await settingsStore.get(t)).timezone,
          }),
          /**
           * 🔴 SANS CETTE LIGNE, UN OUTIL `origin = 'mcp'` ARRÊTE LE TOUR. L'exécuteur dispatche sur
           * `resolveurs[outil.origin]` et rend `erreur_protocole` avec `fatal: true` quand il n'en trouve
           * pas. C'est la question à poser à un câblage, qui n'a par construction aucun dépendant : « que
           * suppose-t-il du module que je viens de changer ? ». Ici, que les trois origines déclarées dans
           * `OrigineOutil` ont chacune leur résolveur.
           */
          mcp: creerResolveurMcp({ sources: agentSources }),
        },
        compterAppel: (t, sessionId) => agentSessions.compterAppel(t, sessionId),
      },
      // 🔴 PROJECTION, jamais la ligne brute : `mba_lire_contact` la rend TELLE QUELLE au modèle, donc au
      // fournisseur (`projectionPourTiers`).
      lireContact: (t, waId) => contactStore.projectionPourTiers(t, waId),
      alerter: (m) => { alert('agent', m); },
    });

    const agentTurnDeps: RunTurnDeps = {
      sessions: agentSessions,
      brain: cerveau,
      // 🔴 Le solde PREPAYE du workspace : lu avec les autres plafonds (donc avant l appel au modele), et
      // debite de ce que le tour a reellement coute. C est ce qui relie le budget affiche a la consommation.
      soldeTenant: (t) => credits.solde(t),
      debiterTenant: async (t, montant, sessionId) => { await credits.debiter(t, montant, { sessionId }); },
      lireRun: async (t, runId) => {
        const run = await runStore.byId(t, runId);
        return run ? { status: run.status, currentNode: run.currentNode } : null;
      },
      lireFiche: (t, agentId) => agentStore.byId(t, agentId),
      // 🔴 La MÉMOIRE de l'agent : la conversation depuis l'ouverture de sa session. Sans elle il redemande
      // son nom au contact à chaque message. Lue et non reçue : `advance` ne porte pas le texte du message.
      lireConversation: async (t, waId, depuis) => {
        const messages = await inboxStore.messagesDepuis(t, waId, depuis, MESSAGES_DE_CONTEXTE);
        return messages.map((m) => ({ role: m.direction === 'in' ? 'contact' : 'agent', texte: m.body }));
      },
      // Écriture CONDITIONNELLE de l'échéance d'inactivité : rien n'est écrit si le run a bougé pendant le
      // tour. Sans cette garde, un run tué en cours de tour ressusciterait avec une échéance, et le balayeur
      // déclencherait plus tard la branche « pas de réponse » d'un parcours fermé exprès.
      majRun: async (t, runId, nodeId, state) => { await runStore.setStateSiEncoreSur(t, runId, nodeId, state); },
      // Le fil est-il encore à nous ? Relu par le tour JUSTE avant l'envoi, pas seulement à son entrée.
      mayAct: async (t, waId) => (await inboxStore.getControlOwner(t, waId)) === 'app_workflow',
      /**
       * 🔴 LA GARDE D OPT-OUT DE L AGENT IA, QUI MANQUAIT. Elle a ete posee le 2026-09-13 sur
       * `WorkflowExecutor.apply`, avec la justification « scenario, automation et agent IA passent par cet
       * executeur ». C etait FAUX pour l agent : sa reponse part par `envoyerTexteAgent`, qui appelle
       * `client.sendText` directement. Un contact desabonne recevait donc encore les reponses de l agent,
       * pendant que l ecran Consentement affirmait le contraire au client. Trouve en revue du chantier
       * complet, le 2026-09-14.
       *
       * ⚠️ LA MEME dependance que l executeur de scenario, sur le MEME depot : deux lectures differentes du
       * meme fait finiraient par ne plus dire la meme chose.
       */
      estDesabonne: (t, waId) => contactStore.estDesabonneParWaId(t, waId),
      envoyer: (t, waId, texte) => envoyerTexteAgent(t, waId, texte),
      mesurer: ({ tenantId, workflowId, nodeId, waId, kind }) =>
        nodeEventStore.record({ tenantId, workflowId, nodeId, waId, kind }),
      sortir: async ({ tenantId, waId, sessionId, sortie }) => {
        await workflowExecutor.sortirDuBlocAgent(tenantId, waId, sessionId, sortie);
      },
    };

    await queue.work(AGENT_TURN_QUEUE, async (data) => {
      const job = parseAgentTurnJob(data);
      if (!job) {
        // Un payload inexploitable est ignoré PROPREMENT plutôt que de faire boucler la file jusqu'à la DLQ.
        // Même doctrine que `automation-event`.
        // eslint-disable-next-line no-console
        console.error('agent-turn: payload inexploitable, ignoré');
        return;
      }
      // `runTurn` ne LÈVE JAMAIS sur un cas métier : il rend ce qu'il a fait. Une exception ici serait donc
      // une panne d'infrastructure, et c'est le seul cas où pg-boss doit rejouer le job.
      const res = await runTurn(job, agentTurnDeps);
      if (res.fait === 'erreur') {
        alert('agent-turn', `tour d'agent en échec (session ${job.sessionId}, sortie ${res.sortie ?? '?'})`);
      }
      // 🔴 LA FILE QUI COMPTE (lot 6 du plan post-audit). Elle traitait UN tour à la fois pour la flotte
      // entière, avec un plafond de 120 s par appel au modèle : à 25 clients, cela faisait 30 tours par heure
      // POUR TOUT LE MONDE. Le groupe est l'espace, et le plafond par espace garantit qu'un client bavard
      // n'occupe pas les douze places à lui seul.
    }, { concurrency: config.AGENT_TURN_CONCURRENCY, groupConcurrency: config.AGENT_TURN_GROUP_CONCURRENCY });
  } else {
    // eslint-disable-next-line no-console
    console.warn('agent-turn: file NON consommée (AI_GATEWAY_API_KEY absente). Les blocs agent resteront muets.');
  }

  installGracefulShutdown(async () => {
    // UNE ligne, et plus une par minuterie : c'est ce qui rend l'oubli impossible. Trois tâches avaient
    // échappé à l'ancienne liste, dont les deux rétentions ajoutées le jour même de ce refactor.
    taches.arreterTout();
    await queue.stop();
    await pool.end();
  }, undefined, () => {
    // Levé AVANT toute fermeture : le run en cours a ainsi le temps de sortir proprement pendant qu'on ferme
    // le reste, au lieu de se faire couper la file sous les pieds.
    arretDemande = true;
  });

  // 🔴 DÉRIVÉ des files réellement consommées, jamais recopié. Cette liste était écrite à la main, avec ses
  // propres conditions (« si le Gateway est configuré »...), c'est-à-dire une SECONDE vérité à tenir alignée
  // avec les `queue.work`. Elle a menti le jour même de l'ajout de `webhook-status` : le worker annonçait
  // sept files pour huit consommées, et personne ne l'aurait vu.
  const files = queue.filesTravaillees();
  // eslint-disable-next-line no-console
  console.log(`messagingme-mba worker démarré (files: ${files.join(', ')})${dryRun ? ' [DRY_RUN]' : ''}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
