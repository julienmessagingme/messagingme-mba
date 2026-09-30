import './charger-env';
import { config } from './config';
import { PgBossQueue } from './queue/pgboss';
import { pool, mesureAttentePool } from './db/pool';
import { construireSocle } from './socle';
import { fabriquerJeton } from './links/jeton-contact';
import { RETENTION_ESSAIS_JOURS } from './agent/test-runs';
import { PgConversationStatsStore } from './stats/conversation-stats.pg';
import { todayParis, addDays } from './stats/range';
import { handleWebhookJob } from './webhooks/handler';
import { PgEventStore } from './webhooks/store';
import { PgCampaignStore, PgQualityProvider } from './campaign/store.pg';
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
import { DUREE_CLE_IDEMPOTENCE_MS } from './api/idempotence';
import { PgArriveesPubStore } from './pubs/arrivees.pg';
import { PgTarifsMetaStore } from './pubs/tarifs-meta.pg';
import { balayerLesPubs } from './pubs/suivi';
import { estJetonRefuse } from './meta/graph';
import { runControlSweep } from './inbox/control-sweep';
import { runHandoffSweep } from './mba/handoff-sweep';
import { lireHandoffEnabled, ecrireHandoffEnabled } from './mba/handoff';
import { SOURCE_STOP_WHATSAPP } from './crm/consentement';
import {
  ensureFieldByKey,
  CTWA_AD_ID_FIELD_KEY, CTWA_AD_ID_FIELD_LABEL, CTWA_AD_TITLE_FIELD_KEY, CTWA_AD_TITLE_FIELD_LABEL,
} from './crm/fields';
import { grapheEditable } from './workflow/store.pg';
import { blocDesigne } from './workflow/test-token';
import { runAutomations } from './automation/runner';
import { runDateSweep } from './automation/date-sweep';
import { balayerRisque, jourABalayer } from './engagement/balayage';
import { depsBalayageRisque } from './engagement/cablage';
import { AUTOMATION_EVENT_QUEUE, enfilerEvenementAutomation, parseAutomationEventJob, type AutomationEventJob } from './automation/event-job';
import { AGENT_TURN_QUEUE, parseAgentTurnJob } from './agent/turn-job';

/** Messages de conversation donnés au cerveau à chaque tour. Borné : le contexte se paie à chaque appel de
 *  modèle, et un fil bavard ferait payer au client une conversation qu'il a déjà réglée. */
const MESSAGES_DE_CONTEXTE = 30;
import { runTurn, type RunTurnDeps } from './agent/run-turn';
import { balayerVectorisation } from './agent/recherche';
import { GatewayChatClient } from './agent/llm/chat-client';
import { creerCerveauGateway } from './agent/brain.gateway';
import { lireContexteAvecReglages } from './agent/contexte';
import { creerTravailPousseeOptOut, FILE_POUSSEE_OPTOUT } from './crm/poussee-optout';
import { cacheCourt } from './lib/cache-court';
import { PgSignauxStore } from './signaux/store.pg';
import { completerSignal } from './signaux/completer';
import { creerPuitsSignauxMeta, signalAnalyse } from './signaux/emetteur';
import { FILE_SIGNAUX_BATCH, pousserVersBatch } from './signaux/batch';
import { creerTravailSignauxBatch } from './signaux/travail-batch';
import { creerResolveurHttp } from './agent/resolvers/http';
import { creerResolveurMcp } from './agent/resolvers/mcp';
import { creerResolveurMba } from './agent/resolvers/mba';
import { creerEscaladeVersHumain } from './agent/escalade';
import { automatique } from './inbox/evenements';
import { PgConversationAnalysisStore } from './analysis/store.pg';
import { analyzeConversationJob } from './analysis/job';
import { runAnalysisSweep } from './analysis/sweep';
import { AnthropicClient } from './analysis/llm-client';
import { getEnrichment } from './analysis/enrichment';
import { pushAnalysisJob } from './analysis/push-job';
import { hubspotCatchupJob } from './analysis/catchup-job';
import { makeOnAnalyzed, postAnalysis } from './analysis/connector-push';
import { pullFromInfo, pullFromError } from './account/pull';
import { creerNoteDeQualite } from './campaign/note-qualite';
import { runPhoneStatusSweep, type PhoneProblem } from './account/status-sweep';
import { viderVersLaBase } from './ops/pool-attentes.pg';
import { creerDlqSweep } from './ops/dlq-sweep';
import { creerWebhooksMuetsSweep } from './ops/webhooks-muets-sweep';
import { decryptSecret } from './crypto/secretbox';
import { DryRunSender } from './campaign/dry-run-sender';
import type { MessageSender } from './campaign/engine';
import type { Campaign } from './campaign/types';
import { sendTelegram } from './ops/telegram';
import { installGracefulShutdown } from './shutdown';
import { registreDeTaches } from './worker/taches';
import { tenter } from './lib/tenter';
import { messageDe, texteDe } from './lib/erreur';

async function main(): Promise<void> {
  // Le worker est la seule instance qui supervise (défaut pg-boss) et qui dépile : c'est lui qui récupère les
  // jobs expirés et qui écoute les notifications (sans réveil, une rafale d'entrants se viderait à la cadence
  // de l'horloge). L'API ne fait qu'empiler. `flowIntervalSeconds: 60` espace la maintenance « flow » (défaut
  // 5 s), inutile ici (aucun job bloquant ou parent) : ~16 000 requêtes/jour de moins sur une base facturée à
  // l'egress.
  const queue = new PgBossQueue(config.DATABASE_URL, config.PGBOSS_SCHEMA, {
    max: config.PGBOSS_MAX,
    connectionTimeoutMillis: config.DB_CONN_TIMEOUT_MS,
    flowIntervalSeconds: 60,
    ecouteNotifications: true,
  });
  // L'enfilement d'un run de campagne au débit résolu, partagé par les relances du worker qui ne résolvent pas
  // le débit elles-mêmes.
  const relancerCampagne = relanceurDeCampagnes(queue, config);

  // Alerte Telegram throttlée (mémoire process) sur les erreurs d'un worker vivant. Un worker mort (crash-loop
  // au boot) n'est pas auto-alerté : sa map en mémoire est perdue à chaque restart et il spammerait le chat.
  // Ce cas est couvert par l'âge du heartbeat, lu par /ops et le cron watcher (qui déduplique).
  const ALERT_THROTTLE_MS = 5 * 60_000;
  const lastAlertAt = new Map<string, number>();
  const alert = (key: string, text: string): void => {
    const now = Date.now();
    const prev = lastAlertAt.get(key);
    if (prev !== undefined && now - prev < ALERT_THROTTLE_MS) return;
    lastAlertAt.set(key, now);
    void sendTelegram(`[mba-worker] ${text}`); // no-op si TELEGRAM_* absent, ne throw jamais
  };

  // Le worker est le seul composant qui envoie les messages : un event `error` non capté le tuerait pendant
  // que l'API répond 200 sur /health.
  queue.onError((err) => {
    const msg = texteDe(err);
    // eslint-disable-next-line no-console
    console.error('[pg-boss:worker]', msg);
    alert('pgboss', `erreur pg-boss : ${msg}`);
  });

  // L'écouteur de notifications peut ne pas s'établir (connexion coupée, pooler en mode transaction) :
  // pg-boss avertit et retombe sur le sondage seul, correct mais plus lent. On alerte : un repli muet ferait
  // croire l'écouteur actif.
  queue.onWarning((avertissement) => {
    const msg = avertissement instanceof Error ? avertissement.message : JSON.stringify(avertissement);
    // eslint-disable-next-line no-console
    console.warn('[pg-boss:worker] avertissement', msg);
    alert('pgboss-avertissement', `avertissement pg-boss : ${msg}`);
  });
  await queue.start();

  /**
   * Le socle commun avec l'API (`src/socle.ts`) : les dépôts, le dépôt de contacts qui annonce chaque opt-out (le
   * STOP d'un message entrant est écrit ici), l'émetteur de signaux, la pile d'envoi Meta et ses freins, le
   * résolveur e-mail et le runtime de scénario. Appelé une fois : ses caches sont ceux de ce processus. Tout ce
   * qui suit ne vit que dans le worker : ses files, ses balayages et ce qu'ils sont seuls à lire.
   */
  const {
    dryRun, transport, repo, recipientStore, integrationBatch, espacesBatch, emetteur, contactStore, fieldStore,
    inboxStore, settingsStore, flowStore, idempotencyStore, auditStore, erreursLivraison, echecsMessages,
    poolAttentesStore, nodeEventStore, trackedLinkStore, webhookStore, verrousCourts, compteurDebit, phoneStatusStore, numeroDelieStore, opsStore,
    heartbeatStore, workflowStore, automationStore, agentStore, knowledgeStore, rechercheSemantique, toolCatalog,
    journalAppels, credits, agentSources, agentRequetes, lecturesAnalyse, essaisStore, depotAide, metaFactory, connexionsPub,
    publicites, clientPubs, clientCreationPubs, workflowRuntime, clesGateway, fil, listeDeLAgent,
  } = construireSocle({ pool, queue, config });

  // Heartbeat : le worker écrit un signal de vie best-effort, dont /ops/overview lit l'âge. Il prouve que le
  // process tourne (event loop non bloquée), pas que pg-boss dépile : pour des files gelées, c'est le backlog
  // de /ops qui sert.
  const instanceId = `${process.env.HOSTNAME ?? 'host'}:${process.pid}`;
  const beat = async (boot: boolean): Promise<void> => {
    try {
      await heartbeatStore.beat(instanceId, boot);
    } catch (err) {
      // Best-effort : une écriture heartbeat qui throw tuerait le worker.
      // eslint-disable-next-line no-console
      console.error('heartbeat erreur (best-effort):', messageDe(err));
    }
  };
  await beat(true);
  // Registre des tâches périodiques : programmer et arrêter sont le même geste (voir `worker/taches.ts`).
  const taches = registreDeTaches();
  taches.programmer('heartbeat', config.HEARTBEAT_INTERVAL_MS, () => beat(false));
  /**
   * L'échec d'un balayage, au format commun : `<journal> erreur: <message>` dans les journaux, puis l'alerte
   * throttlée `<texte> en échec : <message>` sous sa clé. Passé à `programmer` (`enEchec`).
   */
  const echecDeBalayage = (journal: string, cle: string, texte = journal) => (err: unknown): void => {
    // eslint-disable-next-line no-console
    console.error(`${journal} erreur:`, messageDe(err));
    alert(cle, `${texte} en échec : ${messageDe(err)}`);
  };

  /**
   * L'attente du pool, versée en base une fois par minute. C'est le seul canal par lequel ce process se
   * montre : `/ops` est servi par l'API, qui ne voit que son propre pool. Best-effort : une mesure ne doit
   * jamais faire tomber ce qu'elle mesure.
   */
  taches.programmer('pool-attentes', 60_000, async () => {
    await viderVersLaBase(poolAttentesStore, mesureAttentePool, 'worker', new Date(), (err) => {
      // eslint-disable-next-line no-console
      console.error('pool-attentes: écriture impossible:', messageDe(err));
    });
  });

  // File webhook : le PgRecipientStore applique les statuts de livraison, le PgInboxStore enregistre les
  // entrants en conversations ; le report Flow -> champs du contact est isolé dans handleWebhookJob (il ne
  // fait jamais échouer le job partagé avec les statuts).
  const eventStore = new PgEventStore(pool);
  // Publicités Click-to-WhatsApp : ce qui se perd si on ne le garde pas à la réception.
  const arriveesPubStore = new PgArriveesPubStore(pool);
  const tarifsMetaStore = new PgTarifsMetaStore(pool);
  /**
   * La cadence du suivi des publicités : quinze minutes, la cadence à laquelle Meta rafraîchit lui-même la
   * dépense d'une campagne. Interroger plus souvent relirait le même chiffre en consommant du quota sur un
   * compte en niveau « Limited ». Pas de variable d'environnement : elle décrit le comportement d'un tiers.
   */
  const SUIVI_PUBS_INTERVALLE_MS = 15 * 60 * 1000;
  /**
   * Le numéro Meta -> son espace, pour les accusés, qui ne portent que le numéro. Consulté seulement quand un
   * espace au moins a branché un outil. Seules les réponses positives restent en cache : une réponse nulle
   * deviendrait fausse dès qu'un client branche son premier numéro (voir `src/meta/numero-espace.ts`).
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
  const qualiteStore = new PgQualityProvider(pool);
  const noteDeQualite = creerNoteDeQualite((pn) => qualiteStore.getRating(pn));

  // Exécuteur de scénarios et ce qui l'accompagne, construit par le socle : l'API lance un scénario depuis
  // l'Inbox avec la même sémantique.
  const {
    executor: workflowExecutor, runStore, templateVarInfo, prepareCarouselMedia, prepareHeaderMedia, buildEvalContext, rcsStack,
    agentSessions, envoyerTexteAgent, poserTagDepuisAgent,
  } = workflowRuntime;

  /**
   * La mémoire de joignabilité WhatsApp d'un contact, écrite par ses deux sources avec un seul noteur : le
   * moteur de campagne pose le « oui » sur un envoi accepté, le balayage de relance le « non » au second
   * échec 131026. La péremption suppose une date posée de la même façon des deux côtés.
   */
  const noterJoignabiliteContact = creerNoteurJoignabilite(pool);
  const noterEnvoiCampagne = creerNoteurEnvois(pool);

  /**
   * Campagnes au fil de l'eau : un contact arrive par un webhook entrant et devient destinataire des
   * campagnes vivantes qui s'en nourrissent. Aucun chemin d'envoi propre : on inscrit, puis `runCampaign` fait
   * le reste avec sa cadence et ses garde-fous.
   */
  const webhookFeedDeps: WebhookFeedDeps = {
    repo,
    // Un seul arrivant : `pendingCount` à 1 dimensionne l'expiration du job, et le débit est le même que celui
    // du run réel (sinon pg-boss rejouerait le job en parallèle).
    enqueueRun: (c) => relancerCampagne({ campaignId: c.id, tenantId: c.tenantId, pendingCount: 1, ratePerMinute: c.ratePerMinute }),
  };

  // Automations : un événement (message entrant) démarre un scénario, via l'exécuteur ci-dessus, dont il
  // hérite des gardes (fil détenu par un humain/MBA, ouverture hors fenêtre 24 h).
  const automationRunnerDeps = {
    // Contact bloqué : son message est enregistré et lisible, mais il ne déclenche plus aucun scénario.
    contacts: contactStore,
    automations: automationStore,
    maxFiresPerHour: config.AUTOMATION_MAX_FIRES_PER_HOUR,
    evalContext: buildEvalContext,
    startWorkflow: async (tenant: string, workflowId: string, waId: string, opts: {
      startNodeId: string | null; windowOpen: boolean; reprendLaMain: boolean; saufOperateur?: boolean;
    }) => {
      const wf = await workflowStore.getById(workflowId, tenant);
      if (!wf) return false;
      // Le contact existe déjà (l'upsert d'inbound a tourné juste avant) : on relie le run à sa fiche.
      const contactId = await contactStore.findIdByWaId(tenant, waId);
      const contact = { waId, contactId };
      // Démarrage unitaire : les tags posés par ce parcours publient à leur tour (l'anti-rebond du runner borne
      // l'enchaînement). `ignoreHumanControl` seulement pour les automations nées d'un geste explicite du contact
      // (bouton de chaîne, clic sur une publicité), déjà tranché par le runner (`reprendLaMain`) : partout
      // ailleurs, un mot-clé écrirait dans le fil pendant qu'un opérateur répond. Gardé dans les deux sens par
      // `tests/campagne-controle-humain.test.ts`. `saufOperateur` (clic sur une publicité) : la reprise prend le fil
      // à l'agent de Meta, jamais à un opérateur qui le tient.
      const unitaire = { emitEvents: true, ignoreHumanControl: opts.reprendLaMain, saufOperateur: opts.saufOperateur === true };
      if (opts.startNodeId) return workflowExecutor.startFromNode(tenant, workflowId, wf.graph, contact, opts.startNodeId, unitaire);
      // Fenêtre prouvée ouverte (le contact vient d'écrire) : le scénario peut ouvrir par un message rapide ou
      // un formulaire. Sinon, garde normale.
      return opts.windowOpen
        ? workflowExecutor.startInWindow(tenant, workflowId, wf.graph, contact, unitaire)
        : workflowExecutor.start(tenant, workflowId, wf.graph, contact, undefined, unitaire);
    },
    defaultCooldownSeconds: config.AUTOMATION_COOLDOWN_SECONDS,
  };

  // File `automation-event` : les événements qui ne viennent pas du webhook (tag posé depuis l'API, analyse
  // terminée). L'API publie, le worker exécute. Un payload inexploitable est ignoré plutôt que de faire
  // boucler la file jusqu'à la DLQ. Un seul job en vol, donc des événements ordonnés : lui donner de la
  // concurrence exigera une clé de groupe `tenant:waId` à l'enfilement, sur tous les sites qui publient,
  // sinon deux événements du même contact démarreraient deux scénarios en parallèle.
  await queue.work(AUTOMATION_EVENT_QUEUE, async (data) => {
    const job = parseAutomationEventJob(data);
    if (!job) {
      // eslint-disable-next-line no-console
      console.error('automation-event: payload inexploitable, ignoré');
      return;
    }
    await runAutomations(job.tenantId, job.event, automationRunnerDeps);

    // Les campagnes au fil de l'eau (plus bas) sont un autre consommateur du même événement, indépendant du
    // scénario, d'où un appel séparé plutôt qu'une branche dans `runAutomations`. Isolé dans son propre try :
    // un souci de campagne ne doit pas faire rejouer le scénario déjà démarré (une campagne se rattrape au
    // balayage, un scénario démarré deux fois non).
    /**
     * Autre consommateur du même événement : la qualification d'un lead publicitaire. Hors de
     * `runAutomations`, qui ne sait rien des publicités. Isolée dans son propre `try` : un compteur d'entonnoir
     * en retard se rattrape, un scénario parti deux fois non. Ne voit que les chemins unitaires : les chemins de
     * masse (action en masse, import CSV, MCP) n'émettent jamais `tag_added`, donc ne qualifient personne.
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
    // Groupe = l'espace : une rafale d'automations d'un client ne gèle pas les autres. Les deux options vont
    // ensemble (`groupConcurrency` est un no-op tant que `concurrency` vaut 1).
  }, { concurrency: config.AUTOMATION_EVENT_CONCURRENCY, groupConcurrency: 1 });

  await queue.work('webhook', async (data) => {
    await handleWebhookJob(data, {
      store: eventStore,
      delivery: recipientStore,
      /**
       * Les deux files qui voient des statuts reçoivent la remise du fil, celle-ci et `webhook-status` : un
       * accusé arrive par l'une ou l'autre selon le découpage des lots par Meta, qui ne nous appartient pas.
       */
      remiseMba: fil.remettreSurAccuse,
      // Sur les deux files qui voient des accusés, même raison : le tarif est la seule source de « Meta ne
      // facture pas ce message ».
      tarifsMeta: tarifsMetaStore,
      // Sur les deux files qui voient des accusés, comme le tarif : un échec arrive par l'une ou par l'autre.
      echecsLibres: echecsMessages,
      // Les signaux d'accusé sur les deux files aussi ; la réponse, elle, n'arrive que par celle-ci.
      signauxAccuse: puitsSignaux.accuse,
      signalReponse: puitsSignaux.reponse,
      /**
       * Sur cette file seulement : un message entrant n'arrive jamais par `webhook-status`, où le receveur ne
       * route que les lots d'accusés purs.
       */
      remiseMbaEntrant: {
        remettre: fil.remettreSiPersonneNeSuit,
      },
      inbox: inboxStore,
      // Les entrants d'un numéro délié sont écartés avant tout, sur cette file seulement (celle des accusés n'en
      // reçoit jamais, et les accusés sont gardés). Sans cache : une lecture par clé primaire par lot, et
      // « Relier » prend effet au message suivant.
      numerosDelies: (ids) => numeroDelieStore.numerosDelies(ids),
      // L'arrivée publicitaire (`ctwa_clid` compris) : un message entrant n'arrive que par cette file.
      arriveesPub: {
        enregistrer: (t, w, a) => arriveesPubStore.enregistrer(t, w, a),
      },
      /**
       * Où va ce lead, sur cette file seulement (comme l'arrivée qu'il annote). Les deux moitiés vont ensemble,
       * et le type l'impose (`WebhookJobDeps`) : écrire l'arrivée sans router le lead enverrait chaque lead dans
       * les automations ordinaires, y compris ceux d'une pub qui les confie à l'agent de Meta.
       */
      routagePub: {
        campagneConnue: (t, adId) => publicites.campagneConnue(t, adId),
        resoudreChezMeta: async (t, adId) => {
          // Sans connexion publicitaire, rien à demander (pas de jeton, un appel anonyme serait refusé) : la
          // campagne reste inconnue, donc le chemin ordinaire.
          const chiffre = await connexionsPub.lireJetonChiffre(t);
          if (chiffre === null) return null;
          const campagneId = await clientPubs.campagneDeLaPub(adId, decryptSecret(chiffre, config.ENCRYPTION_KEY));
          // On ne mémorise que les succès : écrire un échec figerait une panne réseau en verdict permanent pour tous
          // les leads suivants de la même publicité.
          if (campagneId !== null) await publicites.memoriserPub(t, adId, campagneId);
          return campagneId;
        },
        publiciteDeLaCampagne: (t, campagneId) => publicites.pubDeLaCampagne(t, campagneId),
        contactBloque: (t, waId) => contactStore.isBlockedByWaId(t, waId),
        // La même lecture que l'exécuteur de scénario et que l'agent, sur le même dépôt.
        estDesabonne: (t, waId) => contactStore.estDesabonneParWaId(t, waId),
        // Le contact quitte la liste de l'agent (un seul rejeu), puis `app_workflow` ; jamais sur un fil qu'un
        // opérateur tient : c'est le client qui déclenche, pas l'équipe (`saufOperateur`).
        reprendreLeFil: (t, waId) => fil.reprendrePourLApp(t, waId, { saufOperateur: true }),
        // Filet du fil pris pour rien : on prend le fil avant de savoir si l'automation démarre ; si elle ne démarre
        // pas, ce geste le rend, avec ses gardes (agent éteint, parcours en attente, opérateur).
        rendreLeFil: fil.remettreSiPersonneNeSuit,
        noterIssue: (t, messageId, v) => arriveesPubStore.noterIssue(t, messageId, v),
      },
      // Acteur `null` : c'est le contact lui-même qui a coché, via WhatsApp. Aucun humain de l'équipe n'a agi, et
      // le journal doit le dire plutôt que d'attribuer le geste à personne en silence.
      flowMapping: { lookup: flowStore, writer: contactStore, audit: (tenant, actor, action, target, detail) => auditStore.record(tenant, actor, action, target, detail) },
      workflowAdvance: {
        advance: (t, w, m, bp) => workflowExecutor.advance(t, w, m, bp),
        // Une avance qui échoue atterrit dans le journal des erreurs que l'écran montre : sinon le job finirait en
        // succès, sans rejeu ni trace, et le contact resterait bloqué sur son bloc.
        journaliserEchec: (e) => erreursLivraison.enregistrerEchecAvance(e),
      },
      // Auto-création de fiche depuis l'inbound (par numéro ou BSUID) : les clients qui écrivent sans partager
      // leur numéro atterrissent dans le CRM. Le résultat ('created') signale le 1er message d'un contact inconnu,
      // pour le déclencheur `new_contact` : ne pas le jeter.
      inboundContactUpsert: async (tenant, m) => {
        const issue = await contactStore.upsertFromInbound(tenant, m.waId, m.profileName);
        // L'origine publicitaire, posée sur la fiche au passage : Meta ne l'envoie que sur le premier message après
        // le clic. Isolé dans son propre try : une fiche créée vaut mieux qu'une fiche perdue pour un champ.
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
      // Ce que Meta dit du détenteur à travers le `field` d'un entrant : un `standby` rend le fil à l'agent de Meta.
      detenteur: fil,
      /**
       * Un `standby` d'un contact absent de la liste de l'agent de Meta est pour nous : réécrit en `messages` avant
       * tout le reste (`src/webhooks/standby-hors-liste.ts`). La liste, et les réglages de l'espace sans cache.
       */
      listeALArrivee: {
        agentAllume: async (t) => (await settingsStore.get(t)).mbaEnabled,
        presents: (t, waIds) => listeDeLAgent.presents(t, waIds),
      },
      // Bascules de contrôle et messages de l'agent de Meta.
      handover: {
        marquerEscalade: fil.agentDeMetaPasseLaMain,
        // `origine: 'mba'` et pas `'ia'` : les deux valeurs restent distinctes en base pour dire laquelle a parlé ;
        // le regroupement en un thème « IA » se fait à l'affichage (`THEME_DE_ORIGINE`).
        recordAgentMessage: (t, w, body, messageId) =>
          inboxStore.recordOutboundByWaId(t, w, { body, messageId, type: 'mba', origine: 'mba' }),
      },
      // Automations : un message entrant peut démarrer un scénario (mot-clé, 1er message d'un nouveau contact).
      // `isNewContact` est injecté par le handler. La garde de contrôle du fil est celle de l'executor.
      triggers: {
        // `opts` vient de l'appelant, jamais d'un littéral posé ici : c'est le routage publicitaire qui décide
        // « seule celle-là ». En dur, un lead de publicité redeviendrait ramassable par n'importe quel mot-clé, sans
        // qu'aucun type ne bouge.
        run: (tenant, ev, opts) => runAutomations(tenant, ev, automationRunnerDeps, opts),
      },
      // Jetons de test d'un scénario : le testeur envoie le mot de son lien wa.me / QR depuis son téléphone, et
      // ouvre ainsi lui-même la fenêtre 24 h.
      testTokens: {
        findByTestToken: async (token) => {
          const wf = await workflowStore.findByTestToken(token);
          return wf ? { workflowId: wf.id, tenantId: wf.tenantId } : null;
        },
        markConversationTest: (tenant, waId) => inboxStore.markConversationTest(tenant, waId),
        // Un testeur qui relance son lien repart du début : le parcours resté en attente est clos, sinon il resterait
        // orphelin (l'avance ne retrouve qu'un run à la fois par contact).
        startTestRun: async (tenant, workflowId, waId, nodeId) => {
          const wf = await workflowStore.getById(workflowId, tenant);
          if (!wf) return false;
          const contactId = await contactStore.findIdByWaId(tenant, waId);
          // Le test joue le brouillon, seul chemin d'exécution à le faire (tester avant de publier est la raison
          // d'être du brouillon), et le fige dans le parcours, sinon les points de reprise reliraient le publié. Seul
          // appelant qui fige : figer pour chaque destinataire d'une campagne recopierait le graphe autant de fois.
          const graphe = grapheEditable(wf);
          // `ignoreHumanControl` : un jeton de test reprend le fil quel que soit son détenteur, sinon l'agent de Meta
          // répondrait au testeur à la place du scénario. Le déclencheur est un humain qui tient le téléphone ; la
          // prise échoue lisiblement si Meta la refuse.
          const options = { emitEvents: true, figerLeGraphe: true, ignoreHumanControl: true };
          // Pas de garde « ce bloc existe-t-il ? » ici : `runFrom` la porte déjà, journalise et rend une raison
          // lisible.
          return nodeId === null
            ? workflowExecutor.startInWindow(tenant, workflowId, graphe, { waId, contactId }, options)
            // `blocDesigne` rend l'identifiant exact du bloc, en tolérant la casse ; sinon le suffixe tel quel, que
            // `runFrom` refuse lisiblement.
            : workflowExecutor.startFromNode(tenant, workflowId, graphe, { waId, contactId }, blocDesigne(graphe, nodeId), options);
        },
      },
      // Mesure par bloc : les accusés Meta (délivré / lu / échec) retrouvent ici le bloc qui a envoyé le message.
      // Un identifiant hors scénario ne crée rien.
      nodeEvents: nodeEventStore,
      // 🔴 Opt-out par mot-clé sur WhatsApp (STOP, désabonner...) : sans lui, un contact qui répond STOP
      // resterait `opted_in` et recevrait la campagne suivante. La source `whatsapp_stop` le distingue d'un refus
      // posé à la main. Le wamid du STOP suit jusqu'au signal : un STOP redélivré garde le même `em_event_id`.
      inboundOptOut: (tenant, waId, messageId) => contactStore.setOptInByWaId(tenant, waId, 'opted_out', SOURCE_STOP_WHATSAPP, messageId),
      /**
       * Répartition d'une réponse de campagne (`campaigns.assignation`). Le tour de rôle se joue à l'arrivée de
       * la réponse, pas au lancement : répartir d'avance attribuerait des conversations qui n'existeront jamais.
       * La règle vit dans `src/inbox/assignation-campagne.ts`, éprouvée sans base.
       */
      inboundAssignation: (tenant, waId) => assignerReponse(tenant, waId, {
        campagneDeLaReponse: (t, w) => repo.campagneAssignanteDuContact(t, w),
        membres: (t) => inboxStore.membresAffectables(t),
        prendreUnRang: (t, campaignId) => repo.prendreUnRangDeTourDeRole(t, campaignId),
        assigner: (t, w, userId, cause) => inboxStore.assignerSiLibre(t, w, userId, cause),
        /**
         * Ce qui rend « la conversation arrive dans l'Inbox » vrai : l'agent de Meta, répondeur primaire du
         * numéro, répondrait sinon avant que l'équipe ne voie quoi que ce soit. Le fil va à l'équipe (`app_human`) :
         * ni l'agent, ni une automation ne répondent, et la remise « personne ne suit » du même job le respecte.
         */
        prendreLeFil: fil.prendrePourLEquipe,
      }),
    });
    // Concurrence des entrants : les deux options vont ensemble. `concurrency` seul remettrait le désordre entre
    // deux messages d'un même contact ; `groupConcurrency` seul serait un no-op. Le groupe est le couple numéro +
    // contact, posé à l'enfilement par le receveur (`cleDeContact`). Garantie locale au process : avec un second
    // worker, deux jobs du même contact pourraient repartir en parallèle.
  }, { concurrency: config.WEBHOOK_CONCURRENCY, groupConcurrency: 1 });

  /**
   * File des accusés de livraison : le receveur y aiguille tout payload qui ne contient que des `statuses`.
   * Une campagne en produit trois par destinataire : sur une file unique, cette rafale passerait devant la
   * réponse d'un vrai client. Même fonction de traitement, avec les seules dépendances de livraison.
   *
   * L'ordre relatif entre un accusé et un entrant n'est plus garanti : ils touchent des lignes différentes,
   * aucun invariant n'en dépend. Pas de concurrence : deux accusés du même message (sent puis delivered)
   * doivent s'appliquer dans l'ordre.
   */
  await queue.work('webhook-status', async (data) => {
    // Trois dépendances nommées : ce qui est absent l'est volontairement (aucune conversation, aucune
    // automation, aucun scénario ne se déclenche sur un accusé).
    await handleWebhookJob(data, { store: eventStore, delivery: recipientStore, nodeEvents: nodeEventStore, remiseMba: fil.remettreSurAccuse, tarifsMeta: tarifsMetaStore, echecsLibres: echecsMessages, signauxAccuse: puitsSignaux.accuse });
  });

  // File campaign-run. DRY_RUN=true : sender de démo (aucun appel Meta). Sinon : token résolu par tenant,
  // avec intercepteur d'auth (un token révoqué invalide le WABA au lieu de brûler des appels).
  const dryRunSender = new DryRunSender();
  // Le numéro est celui que le run a résolu, pas `campaign.phoneNumberId` : une campagne RCS a la colonne
  // vide, et son repli WhatsApp part du numéro de l'espace.
  const senderFor = async (campaign: Campaign, phoneNumberId: string): Promise<MessageSender> =>
    dryRun ? dryRunSender : metaFactory.senderForTenant(campaign.tenantId, phoneNumberId);

  // Drapeau d'arrêt, levé par SIGTERM et lu par le moteur à chaque destinataire : le run s'arrête entre deux
  // envois, rend son verrou et laisse la campagne `running` ; le balayage de reprise la relance au redémarrage.
  let arretDemande = false;

  // Concurrence de la file de campagnes : plusieurs runs en parallèle, mais un seul par espace
  // (`localGroupConcurrency: 1`, groupe = tenant posé à l'enfilement). Deux campagnes d'un même client
  // restent sérialisées : elles partagent un seul numéro, donc un seul budget d'envoi. Sûr seulement grâce au
  // frein par numéro : sans lui, deux runs doubleraient le débit réel du numéro, que Meta observe et sanctionne.
  await queue.work('campaign-run', async (data) => {
    await campaignRunJob(data, {
      // Le dépôt porte aussi deux gardes que les tests laissent absentes : 🔴 la revalidation de l'appartenance
      // du numéro juste avant d'envoyer (défense contre une réaffectation), et le numéro de l'espace pour un étage
      // WhatsApp de repli sur une campagne qui n'en porte pas (RCS), le premier par `created_at`.
      repo,
      senderFor,
      recipients: recipientStore,
      campaigns: new PgCampaignStore(pool),
      // La note de qualité du numéro, lue une fois par process et non par destinataire (elle commande une mise
      // en pause ; la colonne n'est rafraîchie que toutes les 20 minutes par le balayage `statut-numeros`).
      quality: { getRating: noteDeQualite },
      // Frein par défaut des campagnes sans ratePerMinute (0 = opt-out). Injecté ici seulement : les tests de
      // câblage de run-job ne le passent pas, une campagne à rate null y reste sans frein.
      defaultRatePerMinute: config.CAMPAIGN_DEFAULT_RATE_PER_MINUTE,
      // Le plafond du canal : le seul câblage qui bride vraiment un envoi (les enfileurs n'estiment qu'une durée).
      // `plafondDuCanal` lit le canal de la campagne, donc une campagne RCS n'hérite pas du plafond WhatsApp.
      plafondDeDebit: (canal) => plafondDuCanal(canal, config),
      // Canal RCS : sender construit à partir de l'agent et du message figés sur la campagne. null -> campagne
      // mise en pause avec sa raison, jamais repartie sur le chemin WhatsApp.
      rcs: rcsStack,
      // Le store, pas la garde : la pause `numero_delie` relit la base, parce que la garde met sa réponse en cache
      // 5 s et peut dire « délié » juste après « Relier » (cf. `RunJobDeps.numerosDelies`).
      numerosDelies: numeroDelieStore,
      // Sérialisation des runs : un seul run vivant par campagne. Injectée ici seulement, comme les gardes
      // voisines : absente en test/e2e.
      serialisation: {
        verrou: new PgCampaignRunLock(pool),
        enAttente: async (id) => (await repo.getRunSizing(id))?.pendingCount ?? 0,
        // On ne relance que s'il reste du travail : un doublon d'enfilement (double clic sur « Lancer ») ferait
        // sinon clignoter le statut de la campagne (completed -> running -> completed).
        relancer: async (id) => {
          const sizing = await repo.getRunSizing(id);
          if (!sizing || sizing.pendingCount === 0) return;
          await relancerCampagne({ campaignId: id, ...sizing });
        },
      },
      /**
       * Les capacités du moteur, en un seul bloc transmis d'un geste : deux listes à tenir alignées à la main
       * finissent par diverger sans erreur (toutes les campagnes à lien tracé ont échoué en 131008 ainsi).
       *
       * Le contrôle des propriétés en trop ne traverse pas un spread : une propriété en trop écrite directement
       * dans ce littéral est refusée (TS2353), la même introduite par un spread passe, et un `satisfies` sur le
       * littéral extérieur n'y change rien. D'où le `satisfies` sur l'objet intérieur du bloc
       * `...(dryRun ? {} : (...))` ci-dessous.
       */
      moteur: {
      arretDemande: () => arretDemande,
      // Horaires d'ouverture de l'espace, pour une campagne « uniquement pendant les heures ouvrées ». Demandés
      // seulement si la campagne porte le drapeau, une fois par run.
      horairesOuvres: async (tenant: string) => {
        const s = await settingsStore.get(tenant);
        return { timeZone: s.timezone, businessHours: s.businessHours };
      },
      // Le run rend la main au bout de ce délai et se réenfile : la file reste équitable entre clients.
      dureeMaxMs: config.CAMPAIGN_RUN_MAX_MS,
      // Campagne workflow : démarre le workflow pour chaque destinataire, avec les variables du 1er template déjà
      // résolues (paramMapping). Un démarrage refusé (scénario supprimé, fil tenu, graphe non lançable) marque le
      // destinataire en échec au lieu de le compter envoyé.
      startWorkflow: async (tenant, workflowId, waId, contactId, firstTemplateParams) => {
        const wf = await workflowStore.getById(workflowId, tenant);
        if (!wf) return false;
        // Envoi voulu par un opérateur : un fil tenu ne le bloque pas (l'opérateur est celui qui a la main), et le
        // scénario reprend la conduite du fil pour pouvoir avancer.
        return workflowExecutor.start(tenant, workflowId, wf.graph, { waId, contactId }, firstTemplateParams, { ignoreHumanControl: true });
      },
      // Campagne node (/v1/sends) : démarre au bloc ciblé, sans garde de fenêtre dans l'executor. La fenêtre a
      // été vérifiée destinataire par destinataire à la création de l'envoi quand le bloc ouvre par un message de
      // session (`ouvertureApi`).
      startWorkflowFromNode: async (tenant, workflowId, startNodeId, waId, contactId) => {
        const wf = await workflowStore.getById(workflowId, tenant);
        if (!wf) return false;
        return workflowExecutor.startFromNode(tenant, workflowId, wf.graph, { waId, contactId }, startNodeId, { ignoreHumanControl: true });
      },
      // Cartes du carousel du template, relues une fois par run via le même cache court que les variables. null =
      // pas de carousel. Absente en DRY_RUN : ce mode ne doit déclencher aucun appel Meta.
      ...(dryRun ? {} : ({
        getTemplateCarousel: async (tenant: string, name: string, language: string) => {
          const lu = (await templateVarInfo(tenant, name, language))?.carousel;
          // Visuels préparés une fois par run : identiques pour tous les destinataires.
          return lu ? { cards: await prepareCarouselMedia(tenant, lu.cards) } : null;
        },
        // `getTemplateHeaderMedia` (plus bas) : Meta exige l'en-tête média à chaque envoi. Même cache, préparation
        // une fois par run. `mediaId: null` = préparation échouée -> le moteur refuse la campagne entière avec une
        // raison lisible, plutôt que des 132012 un par un.
        /**
         * Attribution des clics : quels boutons de ce template portent un suffixe variable. Seuls les liens
         * confirmés et marqués `avec_jeton` comptent : un lien refusé par Meta ou sans variable dans son URL ferait
         * échouer l'appel en 132000.
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
         * Ce contact est joignable en WhatsApp. Dans le bloc non-DRY_RUN exprès : en DRY_RUN le faux sender réussit
         * toujours, et on écrirait « joignable » sur des numéros jamais sollicités (une mesure inventée est pire
         * qu'une mesure absente).
         */
        noterJoignabilite: noterJoignabiliteContact,
      } satisfies Partial<CapacitesMoteur>)),
      // Journalise le template envoyé (campagne directe) dans le fil de conversation.
      inbox: inboxStore,
      /**
       * Journalise chaque tentative d'envoi, hors du bloc `dryRun` (à l'inverse de `noterJoignabilite`) : ce
       * journal enregistre ce que le produit a fait, et en DRY_RUN les destinataires sont réellement résolus
       * (`campaign_recipients` est écrite). Le couper ferait diverger les deux tables.
       */
      noterEnvoi: noterEnvoiCampagne,
      },
    });
  }, { concurrency: config.CAMPAIGN_RUN_CONCURRENCY, groupConcurrency: 1 });

  /**
   * File optout-poussee : prévenir le système du client qu'une personne a refusé. Consommée sans condition :
   * l'API et le worker l'enfilent dès qu'un opt-out est écrit, et c'est le handler qui relit le branchement.
   * Ne pas consommer quand personne n'est branché laisserait s'empiler des jobs jamais dépilés. Concurrence
   * 1 : un client peut désabonner des milliers de personnes d'un geste, sans frapper son système en parallèle.
   */
  await queue.work(FILE_POUSSEE_OPTOUT, creerTravailPousseeOptOut({
    sources: agentSources,
    requetes: agentRequetes,
    requeteConfiguree: async (tenant) => (await settingsStore.get(tenant)).optoutRequestId,
    /**
     * 🔴 Le journal : un refus non poussé est invisible du client, qui croit son CRM prévenu. Les réessais de
     * pg-boss puis la DLQ sont notre filet, pas le sien.
     */
    journalAppels,
    libelleRequete: async (t, id) => (await agentRequetes.parId(t, id))?.label ?? null,
    inbox: inboxStore,
    analyses: lecturesAnalyse,
    fuseau: async (t) => (await settingsStore.get(t)).timezone,
    // Relue à chaque appel : la fiche a pu bouger entre le refus et la reprise du job.
    contacts: contactStore,
    // eslint-disable-next-line no-console
    log: (m) => console.warn(m),
  }));

  /**
   * File signaux-batch : pousser les signaux vers Batch, un job (1 à `SIGNAUX_PAR_JOB` signaux d'un même
   * espace) à la fois par espace. Consommée sans condition, comme `optout-poussee` : le travail relit le
   * réglage. Groupée par espace (`groupId` posé par l'émetteur) ; dans un espace, la priorité
   * (`PRIORITE_SIGNAL`) fait passer réponses, clics, désabonnements et analyses devant un arriéré d'accusés.
   * Les deux options de concurrence vont ensemble ; deux en vol restent loin des 300 mises à jour par seconde
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
    batch: integrationBatch,
    suspendre: async (t) => {
      await integrationBatch.suspendre(t);
      espacesBatch.invalider('actifs');
    },
    journal: journalAppels,
    // eslint-disable-next-line no-console
    log: (m) => console.warn(m),
  }), { concurrency: 2, groupConcurrency: 1 });

  // File analyze-conversation : inerte tant que CONVERSATION_ANALYSIS_ENABLED != 'true' (aucun worker, aucun
  // balayage, aucun appel LLM).
  if (config.CONVERSATION_ANALYSIS_ENABLED === 'true') {
    const analysisStore = new PgConversationAnalysisStore(pool);
    const llmClient = new AnthropicClient(config.LLM_API_KEY, config.LLM_MODEL, config.LLM_MAX_TOKENS, transport);
    // Point de sortie : pousser l'analyse au connecteur mm-hubspot via un job séparé `push-analysis` (durable +
    // DLQ). Inerte si CONNECTOR_PUSH_URL est vide.
    const pushEnabled = config.CONNECTOR_PUSH_URL !== '';
    if (pushEnabled) {
      await queue.work('push-analysis', (data) =>
        pushAnalysisJob(data, {
          // Relecture fraîche : le payload ne porte qu'une référence, on relit l'analyse courante ici. Skip en pause
          // -> marque à rattraper (décision prise par le job sur le snapshot) ; post réussi -> efface la marque.
          analyses: analysisStore,
          getEnrichment: (id) => getEnrichment(pool, id),
          // Porte + décision de rattrapage en un seul snapshot : connected (pousse ou non) + pausedAt (marque ou non).
          numeros: phoneStatusStore,
          post: (event) => postAnalysis(event, { url: config.CONNECTOR_PUSH_URL, secret: config.CONNECTOR_PUSH_SECRET, transport }),
          // eslint-disable-next-line no-console
          log: (m) => console.log(m),
        }),
      );
      // Rattrapage : à la reprise après pause, ré-enfile un push (référence seule) par conversation marquée. Même
      // inertie que push-analysis : push off, catch-up non consommé.
      await queue.work('hubspot-catchup', (data) =>
        hubspotCatchupJob(data, {
          analyses: analysisStore,
          enqueuePush: (ref) => queue.enqueue('push-analysis', ref),
          // eslint-disable-next-line no-console
          log: (m) => console.log(m),
        }),
      );
      // Filet : relance périodiquement le rattrapage pour tout tenant dont un numéro est reconnecté mais garde
      // des marques pending_catchup (enfilement de reprise raté, ou marque posée juste après le listage), sans
      // dépendre d'un futur clic de reprise.
      const catchupSweep = async (): Promise<void> => {
        const tenants = await analysisStore.listTenantsReadyForCatchup();
        // Aucune dédup de file (cf. `Queue.enqueue`) : un tenant peut recevoir un second rattrapage en vol. Sans
        // dommage (le job relit l'état et re-pousse ce qui reste marqué), mais pas gratuit (appels redondants).
        for (const tenantId of tenants) await queue.enqueue('hubspot-catchup', { tenantId });
        // eslint-disable-next-line no-console
        if (tenants.length > 0) console.log(`hubspot-catchup-sweep: ${tenants.length} tenant(s) relancé(s)`);
      };
      taches.programmer('hubspot-rattrapage', config.HUBSPOT_CATCHUP_SWEEP_INTERVAL_MS, catchupSweep, { immediat: true, enEchec: echecDeBalayage('hubspot-catchup-sweep', 'sweeper:hubspot-catchup') });
    }
    const pushAnalyzed = makeOnAnalyzed({
      enabled: pushEnabled,
      // Enfile une référence (pas le snapshot) : le handler push-analysis relit l'état frais.
      enqueue: (stored) => queue.enqueue('push-analysis', { conversationId: stored.conversationId, tenantId: stored.tenantId }),
      // eslint-disable-next-line no-console
      onError: (err) => console.error('push-analysis enqueue échoué (best-effort):', messageDe(err)),
    });

    // Trois consommateurs du même point de sortie : le push connecteur, les signaux et les automations
    // « conversation analysée ». Chacun est isolé : un échec de l'un ne prive pas les autres, et aucun ne fait
    // échouer le job d'analyse.
    const onAnalyzed: typeof pushAnalyzed = async (stored) => {
      // Chaque consommateur a son try/catch ici : l'isolation est une propriété de cette composition, pas un pari
      // sur l'appelé. Sinon un push qui lève sauterait l'automation et ferait rejouer le job d'analyse, donc
      // re-facturer l'appel LLM.
      await tenter('push connecteur ignoré (best-effort):', () => pushAnalyzed(stored));
      try {
        // Avant l'automation, qui sort de la fonction (`if (!ctx) return;`) sans contexte : placé après, le signal
        // disparaîtrait dans ce cas. La fiche et l'analyse se relisent au moment de pousser.
        await emetteur.emettreSignal(stored.tenantId, signalAnalyse(stored.conversationId));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('signal « conversation analysée » ignoré (best-effort):', messageDe(err));
      }
      try {
        // L'analyse identifie une conversation ; le moteur de scénario raisonne par wa_id.
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

    // Groupe = l'espace : sur cette file, l'équité compte plus que le débit. Un client qui importe dix mille
    // contacts déclenche dix mille analyses, qui sinon passeraient avant celles de tous les autres.
    const onConversationReady = (conversationId: string, tenantId: string): Promise<void> =>
      queue.enqueue('analyze-conversation', { conversationId, tenantId }, { groupId: tenantId });
    await queue.work('analyze-conversation', (data) =>
      analyzeConversationJob(data, {
        store: analysisStore,
        llm: llmClient,
        onAnalyzed, // push connecteur, signaux et automations (voir ci-dessus)
        model: { provider: 'anthropic', model: config.LLM_MODEL },
      }),
      // Les deux options vont ensemble : `groupConcurrency` seul est un no-op tant que `concurrency` vaut 1.
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
          // Comme tous les balayages : un échec qui ne vit que dans les logs, personne ne le lit. L'alerte est
          // throttlée à cinq minutes par clé.
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

  // Balayage de planification : enfile les campagnes programmées dues (scheduled_at <= maintenant), toutes
  // les 60 s. Seul `markRunning` (garde sur le statut) empêche de re-lister la campagne au tour suivant :
  // l'enfilement ne déduplique rien (cf. `Queue.enqueue`), donc une seconde instance worker enfilerait un
  // second run entre les deux. Sans objet tant que le compose fige une seule instance.
  const scheduleSweep = async (): Promise<void> => {
    const n = await runCampaignScheduleSweep({
      repo,
      enqueueRun: (id, tenantId, expireInSeconds) => queue.enqueue('campaign-run', { campaignId: id }, { expireInSeconds, groupId: tenantId }),
      defaultRatePerMinute: config.CAMPAIGN_DEFAULT_RATE_PER_MINUTE,
      plafondLePlusBas: plafondLePlusBas(config),
      onError: (m, err) => {
        // eslint-disable-next-line no-console
        console.error(`${m}:`, messageDe(err));
        // Même clé que l'échec global : le throttle de 5 min est partagé, dix campagnes en échec font une alerte.
        // Le détail par campagne reste au log.
        alert('sweeper:schedule', `${m} : ${messageDe(err)}`);
      },
    });
    // eslint-disable-next-line no-console
    if (n > 0) console.log(`schedule-sweep: ${n} campagne(s) programmée(s) lancée(s)`);
  };
  taches.programmer('campagnes-programmees', 60_000, scheduleSweep, { immediat: true, enEchec: echecDeBalayage('schedule-sweep', 'sweeper:schedule') });

  /**
   * Balayage de reprise après un plafond de débit : une campagne qui touche un plafond de cadence Meta se
   * met en pause sans perdre personne, et repart ici automatiquement, comme l'annonce l'écran.
   *
   * Seulement les pauses de débit : une pause de qualité n'a pas d'échéance et n'est jamais reprise par une
   * machine (Meta juge alors le numéro, et relancer sans rien changer peut coûter le numéro).
   */
  const plafondSweep = async (): Promise<void> => {
    const n = await runCampaignRepriseSweep({
      repo,
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
   * Balayage de reprise des campagnes gelées : `running`, des destinataires en attente, et aucun run qui
   * tourne. C'est ce qui arrive à chaque déploiement (worker tué en plein envoi) ; sans reprise, les rejeux
   * pg-boss s'épuisent et la campagne se fige pour toujours, sans erreur visible.
   *
   * « Aucun run ne tourne » se lit sur le verrou d'exécution, dont le bail court expire en deux minutes après
   * la mort d'un process. Il couvre aussi les campagnes au fil de l'eau, et ne relance que ce qui est
   * réellement à l'arrêt. Coût : une requête indexée par minute.
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

  // Balayage de réveil des parcours endormis sur un bloc Attente arrivé à échéance. La granularité du délai
  // vaut cet intervalle (une attente de 5 min repart entre 5 et 6 min, ce que l'UI annonce comme « environ »).
  // La garde de ré-entrance du registre évite qu'une passe lente voie la suivante re-réclamer des runs dont
  // le bail a expiré.
  const wakeSweep = async (): Promise<void> => {
    const n = await runWorkflowWakeSweep({
      // Le dépôt porte aussi les blocs Question restés sans réponse, dont l'échéance vit sur un run `waiting`,
      // invisible du claim des dormants : sans eux, la sortie « pas de réponse » ne partirait jamais.
      runs: runStore,
      executor: workflowExecutor,
    });
    // eslint-disable-next-line no-console
    if (n > 0) console.log(`wake-sweep: ${n} parcours repris après attente`);
  };
  taches.programmer('reveil-parcours', config.WORKFLOW_WAKE_SWEEP_INTERVAL_MS, wakeSweep, { immediat: true, enEchec: echecDeBalayage('wake-sweep', 'sweeper:wake') });

  /**
   * Balayage des tours d'agent morts en vol. Monté hors du bloc `if (gatewayAgent)` exprès : il nettoie quand
   * le chemin de l'agent est cassé, et le suspendre à la clé de Gateway éteindrait le filet le jour d'une
   * rotation de clé ratée. Inerte sans agent (aucune session ne porte de tour en vol).
   */
  const toursBloquesSweep = async (): Promise<void> => {
    await runTourBloqueSweep({
      reclamer: (age, limite) => agentSessions.reclamerToursBloques(age, limite, SORTIE_ECHEC),
      // Le parcours reprend par la branche réellement due, portée par la ligne réclamée : `sortie:echec` pour
      // une session encore `en_cours`, la sortie déjà décidée pour une session close dont l'application a échoué.
      // La session est déjà close : `sortirDuBlocAgent` ne fait qu'avancer le run, et rien s'il a déjà avancé.
      sortir: (t) => workflowExecutor.sortirDuBlocAgent(t.tenantId, t.waId, t.sessionId, t.sortie).then(() => {}),
      // La sortie est passée : la marque tombe et la ligne cesse d'être réclamable. Sinon la même session
      // reviendrait à chaque passage, et le compte annoncerait des parcours remis en route qui l'étaient déjà.
      sortieAppliquee: (t) => agentSessions.sortieAppliquee(t.tenantId, t.sessionId),
      // eslint-disable-next-line no-console
      log: (m) => console.warn(m),
    });
  };
  taches.programmer('tours-agent-bloques', 60_000, toursBloquesSweep, { immediat: true, enEchec: echecDeBalayage('tours-bloques-sweep', 'sweeper:tours-bloques') });

  // Auto-relance des échecs : 131049 (fenêtre matinale Europe/Paris, 1 relance) + 131026 (1 relance puis
  // injoignable au 2e échec). Ne touche que ce que la campagne autorise (sa case « Réessayer »), ou, pour une
  // campagne ancienne, le réglage d'espace `auto_retry_enabled` (`listAutoRetry`, `src/campaign/store.pg.ts`).
  // Monté sans condition : ces relances n'ont rien à voir avec un CRM, seul l'appel HubSpot est conditionnel.
  const isMorningParis = (nowMs: number): boolean => {
    const h = Number(new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false }).format(new Date(nowMs)));
    return h >= 8 && h < 12; // « début de journée »
  };
  {
    // L'ordre « flag puis clôture » de `runRetrySweep` suppose un flag qui peut échouer. Sans HubSpot, il
    // devient un no-op qui réussit (rien à flaguer), jamais un no-op qui lève, qui bloquerait la clôture des
    // injoignables de tous les espaces sans CRM.
    const flagUnreachable = config.HUBSPOT_SERVICE_URL
      ? async (tenantId: string, e164: string): Promise<void> => {
          await flagContactUnreachable({ baseUrl: config.HUBSPOT_SERVICE_URL, secret: config.HUBSPOT_SERVICE_SECRET, transport }, tenantId, e164);
        }
      : async (): Promise<void> => {};
    const retrySweep = async (): Promise<void> => {
      const res = await runRetrySweep({
        isMorningWindow: () => isMorningParis(Date.now()),
        list131049: () => repo.listRetry131049(Date.now()),
        // La bascule d'étage y passe aussi : seules les campagnes à repli sont candidates.
        repo,
        // L'expiration est dimensionnée, comme pour les autres enfileurs de cette file : au défaut de 15 min, une
        // relance de plus de ~450 destinataires (à 30/min) expirerait en plein envoi, pg-boss la rejouerait, et le
        // run parallèle doublerait le débit réel.
        enqueueRun: async (id) => {
          const sizing = await repo.getRunSizing(id);
          // Campagne introuvable (supprimée entre la liste et la relance) : rien à réenfiler.
          if (!sizing) return;
          await relancerCampagne({ campaignId: id, ...sizing });
        },
        flagUnreachable,
        noterJoignabilite: noterJoignabiliteContact,
        // L'horaire du rattrapage, distinct de celui de l'envoi initial (`business_hours_only`, lu par le moteur) :
        // ici c'est l'espace qui parle ; la campagne dit seulement si elle s'en affranchit
        // (`rattrapage_hors_horaires`), réponse qui voyage avec le destinataire.
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

  // Balayage de contrôle : rend la main quand plus personne ne s'occupe d'une conversation. Meta n'a aucun
  // release automatique : sans lui, un opérateur qui ferme son onglet (ou un worker qui meurt) gèlerait la
  // conversation indéfiniment.
  const controlSweep = async (): Promise<void> => {
    const rendues = await runControlSweep({
      inbox: inboxStore,
      // Défauts du serveur, appliqués aux clients qui n'ont rien réglé.
      timeouts: { app_human: config.CONTROL_HUMAN_TIMEOUT_MS, mba: config.CONTROL_MBA_TIMEOUT_MS, app_workflow: config.CONTROL_WORKFLOW_TIMEOUT_MS },
      // Le réglage par client du gel humain (combien de temps on laisse un opérateur travailler tranquille), et
      // la destination : l'agent de Meta chez les clients qui l'ont allumé, le scénario chez les autres.
      reglages: settingsStore,
      // Le geste qui rend le fil : Meta d'abord, et un refus, une absence de numéro ou un fil de test n'écrivent
      // rien (la conversation reste visible dans « À traiter », et le balayage repasse).
      fil,
    });
    // eslint-disable-next-line no-console
    if (rendues > 0) console.log(`control-sweep: ${rendues} conversation(s) rendue(s) au scénario`);
  };
  taches.programmer('reprise-controle', config.CONTROL_SWEEP_INTERVAL_MS, controlSweep, { immediat: true, enEchec: echecDeBalayage('control-sweep', 'sweeper:control') });

  // Passage de main de l'agent selon les heures d'ouverture. Meta n'a aucune notion d'horaires : sans ce
  // balayage, un agent qui passe la main la passe aussi à 3 h du matin (« un conseiller arrive » quand
  // personne n'est là). Ne concerne que les tenants ayant choisi ce mode.
  const cibleHandoff = { numeros: repo, meta: metaFactory };
  const handoffSweep = async (): Promise<void> => {
    const bascules = await runHandoffSweep({
      reglages: settingsStore,
      lireHandoffEnabled: (tenant) => lireHandoffEnabled(cibleHandoff, tenant),
      ecrireHandoffEnabled: (tenant, enabled) => ecrireHandoffEnabled(cibleHandoff, tenant, enabled),
    });
    // eslint-disable-next-line no-console
    if (bascules > 0) console.log(`handoff-sweep: ${bascules} tenant(s) basculé(s) sur les heures d'ouverture`);
  };
  taches.programmer('handoff-mba', config.CONTROL_SWEEP_INTERVAL_MS, handoffSweep, { immediat: true, enEchec: echecDeBalayage('handoff-sweep', 'sweeper:handoff') });

  // Purge des clés d'idempotence API plus vieilles que leur durée de vie (`DUREE_CLE_IDEMPOTENCE_MS`), la
  // même que celle du claim : une purge plus courte ferait envoyer deux fois.
  const idempotencySweep = async (): Promise<void> => {
    const n = await idempotencyStore.sweepOlderThan(DUREE_CLE_IDEMPOTENCE_MS);
    // eslint-disable-next-line no-console
    if (n > 0) console.log(`idempotency-sweep: ${n} clé(s) d'idempotence purgée(s)`);
  };
  taches.programmer('idempotence-api', 60 * 60 * 1000, idempotencySweep, { immediat: true, enEchec: echecDeBalayage('idempotency-sweep', 'sweeper:idempotency') });

  // RGPD : le dernier payload d'un webhook entrant est du JSON tiers, potentiellement personnel. Il ne sert
  // qu'au mapping dans l'écran et au débogage ; après une semaine sans appel, il est effacé.
  const webhookPayloadSweep = async (): Promise<void> => {
    const n = await webhookStore.purgeStalePayloads(config.WEBHOOK_PAYLOAD_RETENTION_DAYS);
    // eslint-disable-next-line no-console
    if (n > 0) console.log(`webhook-payload-sweep: ${n} payload(s) dormant(s) effacé(s)`);
  };
  taches.programmer('retention-payloads-webhooks', 6 * 60 * 60 * 1000, webhookPayloadSweep, { immediat: true, enEchec: echecDeBalayage('webhook-payload-sweep', 'sweeper:webhook-payload') });

  // RGPD et croissance : `webhook_events` garde le payload complet de chaque événement Meta (texte des
  // messages, numéros). Elle ne sert qu'à l'idempotence (quelques minutes) et au débogage ; passé la
  // rétention, elle ne garde plus que des données personnelles. Toutes les heures : la purge est bornée par
  // passage (ni verrou long ni WAL gonflé), une première purge s'étale donc sur plusieurs passages.
  const webhookEventsSweep = async (): Promise<void> => {
    const n = await eventStore.purgeOlderThan(config.WEBHOOK_EVENTS_RETENTION_DAYS);
    // eslint-disable-next-line no-console
    if (n > 0) console.log(`webhook-events-sweep: ${n} événement(s) Meta effacé(s) (rétention ${config.WEBHOOK_EVENTS_RETENTION_DAYS} j)`);
  };
  taches.programmer('retention-evenements-meta', 60 * 60 * 1000, webhookEventsSweep, { immediat: true, enEchec: echecDeBalayage('webhook-events-sweep', 'sweeper:webhook-events') });

  /**
   * Les agrégats journaliers, écrits avant que la purge n'efface ce qui les produit.
   *
   * 🔴 L'ordre est mécanique : supprimer une conversation supprime son analyse en cascade, et une analyse non
   * agrégée est perdue pour toujours. Le balayage est donc attendu ici, et la purge ne part pas s'il a
   * échoué. Un seul passage recalcule chaque journée encore présente, de tous les espaces, en
   * `on conflict do update` : idempotent et rejouable.
   *
   * Une tâche programmée, pas une file pg-boss (l'inscrire dans `BASE_QUEUES` ferait chercher à `/ops` une
   * file inexistante). Fenêtre : 400 jours au minimum (au-delà de la plage maximale d'un écran, 366), et
   * jusqu'au plus ancien jour encore présent s'il est plus vieux (rétention réglée jusqu'à 3650 jours, ou
   * purge suspendue) : sinon ces analyses seraient effacées sans avoir été agrégées. Le coût ne grandit que
   * quand le risque existe.
   */
  const conversationStatsStore = new PgConversationStatsStore(pool, true, config.CONVERSATION_RETENTION_DAYS);
  const agregatsSweep = async (): Promise<number> => {
    const jusqua = todayParis();
    const plancher = addDays(jusqua, -400);
    // `null` = aucune analyse en base, rien à agréger plus loin que le plancher.
    const plusAncien = await conversationStatsStore.plusAncienJourAnalyse();
    const depuis = plusAncien !== null && plusAncien < plancher ? plusAncien : plancher;
    return conversationStatsStore.ecrireAgregats({ from: depuis, to: jusqua });
  };

  /**
   * Ce drapeau est la garde : l'échec du balayage empêche réellement la purge (un `catch` qui l'affirmerait
   * en commentaire la laisserait partir). Le worker démarre quand même : seule l'opération irréversible est
   * suspendue.
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
      // Le drapeau retombe : un balayage en échec suspend la purge à tout moment, pas seulement au démarrage.
      agregatsAJour = false;
      // eslint-disable-next-line no-console
      console.error('agregats-analyse erreur:', messageDe(err));
      alert('sweeper:agregats-analyse', `agregats-analyse en echec, la purge des conversations est SUSPENDUE : ${messageDe(err)}`);
    }
  });
  // RGPD : les conversations et, par cascade, leurs messages et leur analyse. La rétention la plus lourde de
  // conséquence du dépôt (elle efface du contenu que le client voit dans son inbox) : d'où une durée quatre
  // fois supérieure au plancher demandé, et un journal du nombre effacé à chaque passage. Toutes les 6 heures :
  // la rétention se compte en mois, et l'effacement est borné par passage.
  const conversationSweep = async (): Promise<void> => {
    /**
     * La seule opération irréversible du dépôt ne part pas sans sa contrepartie : si les agrégats n'ont pas été
     * écrits, effacer une conversation détruirait son analyse en cascade, sans trace. On saute ce passage : six
     * heures de retard ne coûtent rien, un effacement ne se rattrape pas.
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
   * Les dernières tables qui grossissaient sans fin, en un balayage à étapes indépendantes (chacune son
   * `try` : une purge refusée n'empêche pas les autres). Les événements de blocs sont anonymisés, jamais
   * supprimés (ils sont la mesure des tableaux, sans statistique rétroactive) ; les parcours terminés, les
   * clics et le journal sont supprimés, personne ne les relit.
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
    // Les échecs d'avance sont de l'exploitation, pas une preuve : ils se purgent sur leur propre rétention.
    await etape('avances', `échec(s) d’avance effacé(s) (au-delà de ${config.AVANCE_ECHECS_RETENTION_DAYS} j)`,
      () => erreursLivraison.purgeEchecsAvanceOlderThan(config.AVANCE_ECHECS_RETENTION_DAYS));
    // Les échecs de messages libres : même nature, même rétention que les échecs d'avance.
    await etape('messages', `échec(s) de message libre effacé(s) (au-delà de ${config.AVANCE_ECHECS_RETENTION_DAYS} j)`,
      () => echecsMessages.purgerAvant(config.AVANCE_ECHECS_RETENTION_DAYS));
    await etape('pool', `minute(s) d’attente du pool effacée(s) (au-delà de ${config.POOL_ATTENTES_RETENTION_DAYS} j)`,
      () => poolAttentesStore.purgeOlderThan(config.POOL_ATTENTES_RETENTION_DAYS));
    // Les essais du bac à sable : rétention courte et en dur (14 j), ce ne sont pas des conversations de
    // clients (ni contact ni `wa_id`, seulement ce que l'administrateur a tapé).
    await etape('essais', `essai(s) d’agent effacé(s) (au-delà de ${RETENTION_ESSAIS_JOURS} j)`,
      () => essaisStore.purger(RETENTION_ESSAIS_JOURS));
    // Les verrous courts échus : ils ne tiennent plus rien, la prise suivante les reprendrait. Sans cette étape, la
    // table garderait une ligne par message de client ayant déclenché un envoi de l'agent de Meta.
    await etape('verrous', 'verrou(s) court(s) échu(s) effacé(s)', () => verrousCourts.purgerEchues());
  };
  taches.programmer('retention-generale', 6 * 60 * 60 * 1000, retentionSweep, { immediat: true });

  /**
   * Les fenêtres échues des plafonds de débit partagés (`compteurs_debit`, migration 0186), toutes les cinq minutes
   * et non avec la rétention générale : un robot qui invente une adresse par tentative de connexion écrit une ligne
   * par tentative, et six heures d'une telle rafale rempliraient la table de millions de lignes que plus rien ne lit.
   * Une ligne échue ne décide plus rien : l'effacer est sans effet sur aucun plafond. Idempotente, donc sans danger le
   * jour où ce rôle aura deux exemplaires.
   */
  taches.programmer('compteurs-debit', 5 * 60_000, async () => {
    const n = await compteurDebit.purgerEchues();
    // eslint-disable-next-line no-console
    if (n > 0) console.log(`compteurs-debit: ${n} fenêtre(s) échue(s) effacée(s)`);
  }, { immediat: true, enEchec: echecDeBalayage('compteurs-debit', 'sweeper:compteurs-debit') });

  // Déclencheur « X avant la date d'un champ », le seul qui répond à l'écoulement du temps. Il publie dans la
  // file sans rien démarrer : le scénario part par le chemin commun, avec les mêmes garde-fous.
  const dateSweep = async (): Promise<void> => {
    const n = await runDateSweep({
      declencheurs: automationStore,
      automations: (tenant) => automationStore.listEnabled(tenant, ['avant_date']),
      timeZone: async (tenant) => (await settingsStore.get(tenant)).timezone,
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
   * Le risque de désengagement, une fois par nuit et par espace : la tâche passe tous les quarts d'heure et
   * ne balaye qu'entre 3 h et 6 h (Paris), une fois par jour (`jourABalayer`). Chaque espace est isolé
   * (`balayerRisque`). Câblage partagé avec `/ops` (`src/engagement/cablage.ts`).
   *
   * 🔴 Seul chemin de masse qui émet un événement d'automation (`risque_eleve`), par exception : ses trois
   * bornes sont écrites au point d'émission (`src/engagement/balayage.ts`).
   */
  const depsRisque = depsBalayageRisque({
    pool,
    file: queue,
    emetteur,
    automations: automationStore,
    // eslint-disable-next-line no-console
    journal: (m) => console.warn(m),
  });
  let dernierJourRisque: string | null = null;
  const risqueSweep = async (): Promise<void> => {
    const jour = jourABalayer(new Date(), dernierJourRisque);
    if (jour === null) return;
    const bilans = await balayerRisque(depsRisque);
    // Après le tour des espaces : une liste d'espaces illisible sera retentée au quart d'heure suivant, tant
    // que la fenêtre de nuit est ouverte.
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

  // Les deux sondes qui suivent restent hors de la garde META_ACCESS_TOKEN ci-dessous : la surveillance des
  // files ne touche pas Meta, et un déploiement sans token Meta ne doit pas devenir aveugle aux messages perdus.

  // Surveillance des dead letter queues : un job qui épuise ses rejeux y atterrit et rien ne les consomme,
  // donc sans alerte la perte est silencieuse. Cadence 5 min, alignée sur le throttle ; alerte seulement sur
  // une hausse (cf. `dlq-sweep.ts`), sinon une condition permanente alerterait toutes les 5 minutes.
  const dlqSweep = creerDlqSweep({
    ops: opsStore,
    // Clé d'alerte par file : deux DLQ qui se remplissent ensemble produisent deux messages (le throttle en
    // masquerait une). La dédup sur la répétition est faite par le balayage.
    alert: (queue, m) => alert(`dlq:${queue}`, m),
  });
  // `creerDlqSweep` porte aussi sa propre garde de ré-entrance, indissociable du compteur qu'elle protège
  // et testable là-bas.
  const dlqSweepGarde = async (): Promise<void> => {
    const n = await dlqSweep();
    // Une alerte qui part sans trace est indiagnosticable (si le Telegram n'arrive pas, rien ne dit qu'elle a
    // été émise) : on logue l'effet.
    // eslint-disable-next-line no-console
    if (n > 0) console.log(`dlq-sweep: ${n} file(s) d'échec en hausse, alerte émise`);
  };
  taches.programmer('files-echec', 5 * 60_000, dlqSweepGarde, { immediat: true, enEchec: echecDeBalayage('dlq-sweep', 'sweeper:dlq') });

  /**
   * « Les webhooks arrivent, mais plus rien ne s'écrit. » La seule sonde qui vérifie un effet et pas une
   * réponse : l'agent de Meta peut répondre aux clients sans que rien ne s'enregistre, avec `/health` à 200
   * et des jobs « terminés avec succès » (un extracteur qui ne trouve rien rend un tableau vide, pas une
   * erreur). Raisonnement dans `ops/webhooks-muets-sweep.ts`. Cadence 5 min sur une fenêtre de 60 min : le
   * silence se constate sur la durée.
   */
  const webhooksMuets = creerWebhooksMuetsSweep({
    ops: opsStore,
    alert: (msg) => alert('webhooks-muets', msg),
  });
  taches.programmer('webhooks-muets', 5 * 60_000, async () => { await webhooksMuets(); }, {
    immediat: true,
    // eslint-disable-next-line no-console
    enEchec: (err) => console.error('webhooks-muets-sweep erreur:', messageDe(err)),
  });

  // Balayage du statut et de la qualité des numéros : les rafraîchit tous (cross-tenant, lecture Graph
  // seule) et alerte sur jeton invalide, numéro non connecté ou qualité rouge. Palliatif par polling (le
  // webhook quality n'est pas câblé). Sans token Meta global, aucun pull possible (mêmes conditions que la
  // route) : pas de balayage. `alertedPhones` déduplique par transition (perdu au restart).
  if (config.META_ACCESS_TOKEN) {
    const alertedPhones = new Map<string, PhoneProblem>();
    const statusSweep = async (): Promise<void> => {
      const n = await runPhoneStatusSweep({
        ops: opsStore,
        // Pull par tenant + waba_id de la ligne (bon WABA en multi-WABA). Un échec devient un PullResult
        // (pullFromError -> authError), jamais un throw.
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
        statuts: phoneStatusStore,
        alert: (msg) => { void sendTelegram(`[mba-worker] ${msg}`); },
        alertedState: alertedPhones,
      });
      // eslint-disable-next-line no-console
      if (n > 0) console.log(`phone-status-sweep: ${n} alerte(s) de statut numéro`);
    };
    taches.programmer('statut-numeros', config.PHONE_STATUS_SWEEP_INTERVAL_MS, statusSweep, { immediat: true, enEchec: echecDeBalayage('phone-status-sweep', 'sweeper:phone-status') });
  }

  /**
   * Le suivi des publicités : deux appels par compte connecté, tous les quarts d'heure (cadence de Meta, voir
   * `SUIVI_PUBS_INTERVALLE_MS`), pour relire statuts, motifs de refus, dépense et clics. Monté seulement si
   * les publicités sont configurées (`META_ADS_CONFIG_ID`) : sinon aucun espace ne peut être connecté.
   */
  if (config.META_ADS_CONFIG_ID) {
    const suivrePubs = async (): Promise<void> => {
      const bilan = await balayerLesPubs({
        publicites,
        jeton: async (t) => {
          const chiffre = await connexionsPub.lireJetonChiffre(t);
          return chiffre === null ? null : decryptSecret(chiffre, config.ENCRYPTION_KEY);
        },
        meta: clientCreationPubs,
        noterSuivi: (t, campagneId, v) => publicites.noterSuivi(t, campagneId, {
          statutMeta: v.etat?.statut ?? null,
          motifRefus: v.etat?.motifRefus ?? null,
          debut: v.etat?.debut ?? null,
          fin: v.etat?.fin ?? null,
          budgetTotal: v.etat?.budgetTotal ?? null,
          depense: v.depense?.depense ?? null,
          clics: v.depense?.clics ?? null,
        }),
        connexions: connexionsPub,
        // Sur le code de Meta, jamais sur la phrase : une garde qui lit une phrase casse en silence le jour où
        // Meta la réécrit.
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


  // ---------- File `agent-turn` : le tour d'agent ----------
  //
  // Les résolveurs réels sont câblés ici (pas ceux du bac à sable) : poser un tag écrit vraiment, envoyer un
  // bloc part vraiment chez le contact. Sans clé de Gateway, la file n'est pas consommée : un consommateur qui
  // échouerait enverrait les tours en DLQ, alors qu'un job qui attend repart dès que la clé est posée.
  //
  // 🔴 Même résolveur de clé par espace que dans l'API (`clesGateway`, construit par le socle) : les tours des
  // vrais clients (l'essentiel de la dépense) passent ici, et le câbler d'un seul côté laisserait la production
  // dans le pot commun.
  const gatewayAgent = config.AI_GATEWAY_API_KEY
    ? new GatewayChatClient(config.AI_GATEWAY_API_KEY, undefined, async (tenant) => (await clesGateway.lire(tenant))?.cle ?? null)
    : null;
  if (gatewayAgent) {
    /**
     * Le balayage qui vectorise, seul endroit du dépôt qui calcule un vecteur de fiche : fiches neuves, texte
     * modifié (vecteur effacé à l'édition), ancien modèle. Cadence courte : une fiche créée est trouvable par
     * les mots tout de suite, par le sens au passage suivant. Il vectorise aussi les fiches du mode d'emploi de
     * la console (`depotAide`).
     */
    if (rechercheSemantique) {
      const vectoriser = async (): Promise<void> => {
        try {
          const n = await balayerVectorisation(knowledgeStore, rechercheSemantique, config.AGENT_EMBED_MODEL);
          // eslint-disable-next-line no-console
          if (n > 0) console.log(`vectorisation: ${n} fiche(s) vectorisee(s)`);
          /**
           * Les fiches du mode d'emploi aussi : sinon `aide_fiches.embedding` resterait nul, et le bot d'aide perdrait
           * sa moitié sémantique en continuant de répondre (le client qui ne dit pas « campagne » mais « envoyer un
           * message à toute ma liste »). Même modèle (`AGENT_EMBED_MODEL`) que la connaissance des agents : un autre
           * rendrait les deux bases incomparables sans erreur.
           */
          const na = await balayerVectorisation(depotAide, rechercheSemantique, config.AGENT_EMBED_MODEL);
          // eslint-disable-next-line no-console
          if (na > 0) console.log(`vectorisation: ${na} fiche(s) d aide vectorisee(s)`);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('vectorisation: lot ignore :', messageDe(err));
          // Alerte, comme les autres balayages : un échec veut dire que la base de connaissance cesse d'être
          // vectorisée, et l'agent retombe sur la recherche par mots en silence. Throttlée à cinq minutes.
          alert('sweeper:vectorisation', `vectorisation en echec : ${messageDe(err)}`);
        }
      };
      taches.programmer('vectorisation', 60_000, vectoriser, { immediat: true });
    }

    // L'escalade vers un humain : trois effets dans un ordre contre-intuitif, que `escalade.ts` explique.
    const escaladerVersHumain = creerEscaladeVersHumain({
      sessions: agentSessions,
      parcours: workflowExecutor,
      // Escalade de l'agent IA (`src/agent/escalade.ts`) : aucun affectataire, personne n'a désigné de membre
      // (le bloc « passer à un humain » d'un scénario, lui, affecte via `src/workflow/wiring.ts`).
      // Le booléen de la bascule est rendu, pas avalé : `true` seulement si le fil a vraiment basculé de
      // `app_workflow` à `app_human`, ce qui dit au tour que sa garde de détenteur est fausse à cause de lui
      // (sinon la dernière phrase de l'agent serait muette quand l'équipe est fermée). `escalade: true` : un agent
      // IA qui passe la main promet une réponse, la conversation entre dans « À traiter » tout de suite.
      // La cause nomme l'agent (l'événement `escaladee`, migration 0194, ouvre une demande du Quantitatif >
      // Performance et la frise du panneau Détail le raconte) : son libellé, lu seulement au moment d'escalader ;
      // un agent introuvable est dit par son identifiant plutôt que de retarder la bascule d'une erreur.
      escalateToHuman: async (t, waId, agentId) => fil.passerAUnHumain(t, waId, {
        escalade: true,
        cause: automatique(`agent IA ${(await agentStore.complet(t, agentId).catch(() => null))?.label ?? agentId}`),
      }),
    });

    // Les vrais outils maison, à comparer à `resolvers/simulation.ts` (bac à sable) : ici chaque dépendance
    // touche le monde réel.
    const resolveurMba = creerResolveurMba({
      envoyerBloc: ({ tenantId, waId, runId, workflowId, code }) =>
        workflowExecutor.envoyerBlocDepuisAgent(tenantId, waId, { runId, workflowId, code }),
      escaladerVersHumain,
      // Trois effets, pas un : le contact, le référentiel Tags et la file d'automations. L'outil promet de
      // pouvoir « déclencher une automation », un appel direct au store le ferait mentir.
      poserTag: poserTagDepuisAgent,
      // 🔴 La clé vient du modèle : portée bornée aux champs libres du contact courant (jamais l'opt-in, jamais
      // un autre contact), et l'énumération fermée proposée par la console sur ce paramètre pare une injection.
      ecrireChamp: async (t, waId, cle, valeur) => { await contactStore.mergeFieldsByPhone(t, waId, { [cle]: valeur }); },
      connaissance: knowledgeStore,
      // Le rappel vectoriel et le verdict du reranker. `null` sans clé du Gateway : la recherche retombe sur le
      // plein texte.
      ...(rechercheSemantique ? { recherche: rechercheSemantique } : {}),
    });

    // UN seul cerveau pour toutes les conversations de tous les clients : le contexte du tour est passé à
    // l'appel, jamais figé ici (`creerCerveauGateway`).
    const cerveau = creerCerveauGateway({
      client: gatewayAgent,
      // Point de lecture partagé avec le bac à sable de la console : un champ ajouté d'un seul côté ferait
      // diverger ce que le modèle voit selon qu'on teste ou qu'on est en production.
      contexte: (t, agentId) => lireContexteAvecReglages({ agents: agentStore, outils: toolCatalog, reglages: settingsStore }, t, agentId),
      // Le Gateway facture en dollars, nos compteurs sont en micro-euros : conversion à l'entrée, une seule fois,
      // au taux commercial de la configuration, majorée de la commission que la liste des modèles annonce.
      tauxEurParDollar: config.EUR_PER_USD,
      commissionPct: config.COMMISSION_MODELE_PCT,
      outils: {
        catalogue: toolCatalog,
        /**
         * Les gestes du moment, exécutés par nous et pas par le modèle, avec les mêmes implémentations que les
         * actions `poser_tag` et `ecrire_variable` : deux chemins d'écriture vers `contacts` finiraient par
         * diverger sur la borne, la normalisation ou l'isolation.
         */
        executerGeste: async (t, waId, geste) => {
          if (geste.type === 'tag') await poserTagDepuisAgent(t, waId, geste.valeur);
          else await contactStore.mergeFieldsByPhone(t, waId, { [geste.champ]: geste.valeur });
        },
        // Le vrai journal, contrairement au bac à sable : cette table est le grand livre de facturation autant que
        // la trace d'audit.
        journal: journalAppels,
        // Un résolveur par origine d'outil. Celui de `http` relit sa source à chaque appel : une source désactivée
        // cesse d'être appelée tout de suite.
        resolveurs: {
          mba: resolveurMba,
          http: creerResolveurHttp({
            sources: agentSources,
            requetes: agentRequetes,
            // Chargées paresseusement : appelées seulement si la requête déclare une variable qui les réclame.
            inbox: inboxStore,
            analyses: lecturesAnalyse,
            fuseau: async (t) => (await settingsStore.get(t)).timezone,
          }),
          /**
           * Sans cette ligne, un outil `origin = 'mcp'` arrête le tour : l'exécuteur dispatche sur
           * `resolveurs[outil.origin]` et rend `erreur_protocole` fatal quand il n'en trouve pas. Chaque origine de
           * `OrigineOutil` doit avoir son résolveur.
           */
          mcp: creerResolveurMcp({ sources: agentSources }),
        },
        sessions: agentSessions,
      },
      // 🔴 Projection, jamais la ligne brute : `mba_lire_contact` la rend telle quelle au modèle, donc au
      // fournisseur (`projectionPourTiers`, seule méthode de la tranche).
      contacts: contactStore,
      alerter: (m) => { alert('agent', m); },
    });

    const agentTurnDeps: RunTurnDeps = {
      sessions: agentSessions,
      brain: cerveau,
      // 🔴 Le solde prépayé de l'espace : lu avec les autres plafonds (avant l'appel au modèle), et débité de ce
      // que le tour a réellement coûté.
      credits,
      debiterTenant: async (t, montant, sessionId) => { await credits.debiter(t, montant, { sessionId }); },
      lireRun: async (t, runId) => {
        const run = await runStore.byId(t, runId);
        return run ? { status: run.status, currentNode: run.currentNode } : null;
      },
      agents: agentStore,
      // La mémoire de l'agent : la conversation depuis l'ouverture de sa session (sinon il redemande son nom au
      // contact à chaque message). Lue et non reçue : `advance` ne porte pas le texte du message.
      lireConversation: async (t, waId, depuis) => {
        const messages = await inboxStore.messagesDepuis(t, waId, depuis, MESSAGES_DE_CONTEXTE);
        return messages.map((m) => ({ role: m.direction === 'in' ? 'contact' : 'agent', texte: m.body }));
      },
      // Écriture conditionnelle de l'échéance d'inactivité : un run tué en cours de tour ressusciterait sinon
      // avec une échéance, et le balayeur déclencherait la branche « pas de réponse » d'un parcours fermé exprès.
      majRun: async (t, runId, nodeId, state) => { await runStore.setStateSiEncoreSur(t, runId, nodeId, state); },
      // Le fil est-il encore à nous ? Relu par le tour juste avant l'envoi, pas seulement à son entrée.
      mayAct: fil.peutAgir,
      /**
       * 🔴 La garde d'opt-out de l'agent IA : sa réponse part par `envoyerTexteAgent`, qui appelle
       * `client.sendText` directement, sans passer par `WorkflowExecutor.apply`. Même dépendance que l'exécuteur
       * de scénario, sur le même dépôt : deux lectures du même fait finiraient par diverger.
       */
      estDesabonne: (t, waId) => contactStore.estDesabonneParWaId(t, waId),
      envoyer: (t, waId, texte) => envoyerTexteAgent(t, waId, texte),
      mesures: nodeEventStore,
      sortir: async ({ tenantId, waId, sessionId, sortie }) => {
        await workflowExecutor.sortirDuBlocAgent(tenantId, waId, sessionId, sortie);
      },
    };

    await queue.work(AGENT_TURN_QUEUE, async (data) => {
      const job = parseAgentTurnJob(data);
      if (!job) {
        // Un payload inexploitable est ignoré plutôt que de faire boucler la file jusqu'à la DLQ.
        // eslint-disable-next-line no-console
        console.error('agent-turn: payload inexploitable, ignoré');
        return;
      }
      // `runTurn` ne lève jamais sur un cas métier : une exception ici est une panne d'infrastructure, seul cas
      // où pg-boss doit rejouer le job.
      const res = await runTurn(job, agentTurnDeps);
      if (res.fait === 'erreur') {
        alert('agent-turn', `tour d'agent en échec (session ${job.sessionId}, sortie ${res.sortie ?? '?'})`);
      }
      // Groupe = l'espace, avec un plafond par espace : un client bavard n'occupe pas toutes les places de la
      // file (un tour peut attendre le modèle jusqu'à 120 s).
    }, { concurrency: config.AGENT_TURN_CONCURRENCY, groupConcurrency: config.AGENT_TURN_GROUP_CONCURRENCY });
  } else {
    // eslint-disable-next-line no-console
    console.warn('agent-turn: file NON consommée (AI_GATEWAY_API_KEY absente). Les blocs agent resteront muets.');
  }

  installGracefulShutdown(async () => {
    // Une ligne pour toutes les tâches : c'est ce qui rend l'oubli impossible.
    taches.arreterTout();
    await queue.stop();
    await pool.end();
  }, undefined, () => {
    // Levé avant toute fermeture : le run en cours a le temps de sortir proprement pendant qu'on ferme le
    // reste.
    arretDemande = true;
  });

  // Dérivé des files réellement consommées, jamais recopié : une liste écrite à la main serait une seconde
  // vérité à tenir alignée avec les `queue.work`.
  const files = queue.filesTravaillees();
  // eslint-disable-next-line no-console
  console.log(`messagingme-mba worker démarré (files: ${files.join(', ')})${dryRun ? ' [DRY_RUN]' : ''}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
