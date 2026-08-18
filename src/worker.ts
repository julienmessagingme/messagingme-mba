import 'dotenv/config';
import { config } from './config';
import { PgBossQueue } from './queue/pgboss';
import { pool } from './db/pool';
import { handleWebhookJob } from './webhooks/handler';
import { PgEventStore } from './webhooks/store';
import {
  PgCampaignRepo,
  PgCampaignStore,
  PgRecipientStore,
  PgFrequencyStore,
  PgQualityProvider,
} from './campaign/store.pg';
import { campaignRunJob } from './campaign/run-job';
import { runCampaignScheduleSweep } from './campaign/schedule-sweep';
import { runWorkflowWakeSweep } from './workflow/wake-sweep';
import { runRetrySweep } from './campaign/retry-sweep';
import { flagContactUnreachable } from './crm/hubspot-service';
import { PgApiIdempotencyStore } from './api/idempotency-store.pg';
import { PgInboxStore } from './inbox/store.pg';
import { PgTenantSettingsStore } from './settings/store.pg';
import { runControlSweep } from './inbox/control-sweep';
import { PgFlowStore } from './flow/store.pg';
import { PgContactStore } from './crm/contact-store.pg';
import { PgWorkflowStore } from './workflow/store.pg';
import { PgAutomationStore } from './automation/store.pg';
import { runAutomations } from './automation/runner';
import { AUTOMATION_EVENT_QUEUE, parseAutomationEventJob } from './automation/event-job';
import type { AutomationTriggerKind } from './automation/match';
import { buildWorkflowRuntime } from './workflow/wiring';
import { PgConversationAnalysisStore } from './analysis/store.pg';
import { analyzeConversationJob } from './analysis/job';
import { runAnalysisSweep } from './analysis/sweep';
import { createLlmClient } from './analysis/llm-client';
import { getEnrichment } from './analysis/enrichment';
import { pushAnalysisJob } from './analysis/push-job';
import { hubspotCatchupJob } from './analysis/catchup-job';
import { makeOnAnalyzed, postAnalysis } from './analysis/connector-push';
import { PgPhoneStatusStore } from './account/store.pg';
import { pullFromInfo, pullFromError } from './account/pull';
import { runPhoneStatusSweep, type PhoneProblem } from './account/status-sweep';
import { PgOpsStore } from './ops/store.pg';
import { MetaClientFactory } from './meta/factory';
import { MetaCredentialsResolver } from './meta/credentials';
import { PgEmbeddedSignupStore } from './account/es-store.pg';
import { decryptSecret } from './crypto/secretbox';
import { FetchTransport } from './meta/http';
import { DryRunSender } from './campaign/dry-run-sender';
import type { MessageSender } from './campaign/engine';
import type { Campaign } from './campaign/types';
import { PgWorkerHeartbeatStore } from './ops/heartbeat-store.pg';
import { sendTelegram } from './ops/telegram';
import { installGracefulShutdown } from './shutdown';

async function main(): Promise<void> {
  // Le worker est la SEULE instance qui supervise (défaut pg-boss conservé) : c'est lui qui dépile, donc lui qui
  // doit récupérer les jobs expirés. `flowIntervalSeconds: 60` espace la maintenance « flow » (défaut 5 s), qui ne
  // sert ici aucun chemin sensible : ce projet n'utilise pas de jobs bloquants/parents. Gain mesuré : ~16 000
  // requêtes/jour de moins sur une base Supabase facturée à l'egress.
  const queue = new PgBossQueue(config.DATABASE_URL, config.PGBOSS_SCHEMA, {
    max: config.PGBOSS_MAX,
    connectionTimeoutMillis: config.DB_CONN_TIMEOUT_MS,
    flowIntervalSeconds: 60,
  });

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
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error('[pg-boss:worker]', msg);
    alert('pgboss', `erreur pg-boss : ${msg}`);
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
      console.error('heartbeat erreur (best-effort):', err instanceof Error ? err.message : err);
    }
  };
  await beat(true);
  const heartbeat = setInterval(() => void beat(false), config.HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  // File webhook (Loop 1). Le PgRecipientStore applique les statuts de livraison ; le
  // PgInboxStore enregistre les messages entrants (réponses / taps de boutons) en conversations ;
  // le report Flow -> user fields (flowStore.findByRef + contactStore.mergeFieldsByPhone) est ISOLÉ
  // dans handleWebhookJob (ne fait jamais échouer le job partagé avec les statuts).
  const eventStore = new PgEventStore(pool);
  const recipientStore = new PgRecipientStore(pool);
  const inboxStore = new PgInboxStore(pool);
  const settingsStore = new PgTenantSettingsStore(pool);
  const flowStore = new PgFlowStore(pool);
  const contactStore = new PgContactStore(pool);
  const repo = new PgCampaignRepo(pool);
  const transport = new FetchTransport();
  const dryRun = config.DRY_RUN === 'true';

  // Résolution du token Meta PAR TENANT (B1). En SOMMEIL tant qu'aucun WABA n'a de credentials propres : le
  // résolveur retombe alors sur config.META_ACCESS_TOKEN -> comportement identique au token global d'avant.
  const esStore = new PgEmbeddedSignupStore(pool);
  const phoneStatusStore = new PgPhoneStatusStore(pool);
  const metaCredentials = new MetaCredentialsResolver({
    getWabaIdForTenant: (t) => repo.getTenantWabaId(t),
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
  });

  // Exécuteur de workflows : quand un contact répond, on avance son run (blocs tag/field/template -> inbox).
  const workflowStore = new PgWorkflowStore(pool);
  const automationStore = new PgAutomationStore(pool);

  // Exécuteur de scénarios + ce qui l'accompagne. Câblage PARTAGÉ avec l'API (`workflow/wiring.ts`) : elle
  // doit lancer un scénario depuis l'Inbox avec exactement la même sémantique. Un second câblage recopié
  // serait le troisième doublon de cette famille, après le constructeur de composants Meta et la préparation
  // des visuels de carousel, qui ont chacun cassé la prod le 2026-08-15.
  const {
    executor: workflowExecutor, runStore, templateVarInfo, prepareCarouselMedia, prepareHeaderMedia, buildEvalContext, rcsStack,
  } = buildWorkflowRuntime({
    pool, queue, dryRun, repo, contactStore, inboxStore, settingsStore, workflowStore, metaCredentials, metaFactory,
    rcsProvider: config.RCS_PROVIDER,
  });

  // Automations (Lot E) : un événement (message entrant) démarre un scénario. Réutilise TEL QUEL l'exécuteur
  // ci-dessus, donc hérite gratuitement de ses gardes (fil détenu par un humain/MBA, ouverture hors fenêtre 24 h).
  const automationRunnerDeps = {
    listEnabled: (tenant: string, kinds: readonly AutomationTriggerKind[]) => automationStore.listEnabled(tenant, kinds),
    lastFiredAt: (id: string, waId: string) => automationStore.lastFiredAt(id, waId),
    markFired: (id: string, waId: string) => automationStore.markFired(id, waId),
    clearFired: (id: string, waId: string) => automationStore.clearFired(id, waId),
    // Un seul parcours actif par contact : sinon un message qui répond à un scénario EN COURS et contient le
    // mot-clé enverrait deux messages, et laisserait le run précédent orphelin (l'avance n'en retrouve qu'un).
    hasWaitingRun: (tenant: string, waId: string) => runStore.hasRecentWaitingRun(tenant, waId, config.AUTOMATION_WAITING_RUN_MAX_AGE_MS),
    firedSince: (id: string, since: Date) => automationStore.firedSince(id, since),
    maxFiresPerHour: config.AUTOMATION_MAX_FIRES_PER_HOUR,
    evalContext: buildEvalContext,
    startWorkflow: async (tenant: string, workflowId: string, waId: string, startNodeId: string | null, windowOpen: boolean) => {
      const wf = await workflowStore.getById(workflowId, tenant);
      if (!wf) return false;
      // Le contact existe déjà (l'upsert d'inbound a tourné juste avant) : on relie le run à sa fiche si on la trouve.
      const contactId = await contactStore.findIdByWaId(tenant, waId);
      const contact = { waId, contactId };
      // Démarrage UNITAIRE (un contact, sur un événement) : les tags posés par ce parcours publient à leur
      // tour, contrairement à une campagne. L'anti-rebond du runner borne l'enchaînement.
      const unitaire = { emitEvents: true };
      if (startNodeId) return workflowExecutor.startFromNode(tenant, workflowId, wf.graph, contact, startNodeId, unitaire);
      // Fenêtre PROUVÉE ouverte (le contact vient d'écrire) -> le scénario peut ouvrir par un message rapide ou
      // un formulaire, ce que le Lot D a rendu possible et que l'écran Automation annonce. Sinon, garde normale.
      return windowOpen
        ? workflowExecutor.startInWindow(tenant, workflowId, wf.graph, contact, unitaire)
        : workflowExecutor.start(tenant, workflowId, wf.graph, contact, undefined, unitaire);
    },
    defaultCooldownSeconds: config.AUTOMATION_COOLDOWN_SECONDS,
  };

  // File `automation-event` (E.2) : les événements qui ne viennent PAS du webhook (tag posé depuis l'API,
  // analyse de conversation terminée). L'API ne sait pas démarrer un scénario, elle publie ; le worker exécute.
  // Un payload inexploitable est ignoré proprement plutôt que de faire boucler la file jusqu'à la DLQ.
  await queue.work(AUTOMATION_EVENT_QUEUE, async (data) => {
    const job = parseAutomationEventJob(data);
    if (!job) {
      // eslint-disable-next-line no-console
      console.error('automation-event: payload inexploitable, ignoré');
      return;
    }
    await runAutomations(job.tenantId, job.event, automationRunnerDeps);
  });

  await queue.work('webhook', async (data) => {
    await handleWebhookJob(
      data, eventStore, recipientStore, inboxStore,
      { lookup: flowStore, writer: contactStore },
      { phoneNumberTenant: (pnid) => inboxStore.phoneNumberTenant(pnid), advance: (t, w, m, bp) => workflowExecutor.advance(t, w, m, bp) },
      // Auto-création de fiche depuis l'inbound (par numéro OU BSUID) : les clients qui écrivent sans
      // partager leur numéro (post-octobre) atterrissent quand même dans le CRM. Isolé dans processInbound.
      // Le résultat ('created') est le signal « 1er message d'un contact inconnu » : le handler le capture
      // pour le déclencheur d'automation `new_contact`. Ne PAS le jeter.
      (tenant, m) => contactStore.upsertFromInbound(tenant, m.waId, m.profileName),
      // Pré-câblage MBA : bascules de contrôle et messages de l'agent Meta. Inerte tant que MBA n'est
      // activé nulle part, mais déjà branché pour que le premier test réel soit OBSERVABLE.
      {
        phoneNumberTenant: (pnid) => inboxStore.phoneNumberTenant(pnid),
        // Sans `only` : Meta fait autorité sur qui détient le fil, notre état ne fait que refléter le sien.
        setControlOwner: (t, w, o) => inboxStore.setControlOwner(t, w, o),
        recordAgentMessage: (t, w, body, messageId) =>
          inboxStore.recordOutboundByWaId(t, w, { body, messageId, type: 'mba' }),
      },
      // Automations (Lot E) : un message entrant peut DÉMARRER un scénario (mot-clé, 1er message d'un nouveau
      // contact). `isNewContact` est injecté par le handler (il vient de l'upsert ci-dessus). La garde de
      // contrôle du fil est celle de l'executor : un scénario déclenché n'écrit pas dans un fil tenu par un humain.
      {
        phoneNumberTenant: (pnid) => inboxStore.phoneNumberTenant(pnid),
        run: (tenant, ev) => runAutomations(tenant, ev, automationRunnerDeps),
      },
      // Jetons de test d'un scénario (Lot F) : le testeur envoie le mot de son lien wa.me / QR depuis son
      // propre téléphone. C'est LUI qui ouvre la fenêtre 24 h, donc le scénario peut démarrer en session.
      {
        phoneNumberTenant: (pnid) => inboxStore.phoneNumberTenant(pnid),
        findByTestToken: async (token) => {
          const wf = await workflowStore.findByTestToken(token);
          return wf ? { workflowId: wf.id, tenantId: wf.tenantId } : null;
        },
        // Même garde que l'exécuteur, mais vérifiée AVANT les écritures : un opérateur (ou MBA) qui tient le
        // fil garde la priorité, et on ne casse pas l'état du contact pour un test qui ne partira pas.
        mayStart: async (tenant, waId) => (await inboxStore.getControlOwner(tenant, waId)) === 'app_workflow',
        markConversationTest: (tenant, waId) => inboxStore.markConversationTest(tenant, waId),
        // Un testeur qui relance son lien veut repartir du DÉBUT : on clôt le parcours resté en attente,
        // sinon il resterait orphelin (l'avance ne retrouve qu'un run à la fois par contact).
        endWaitingRun: async (tenant, waId) => {
          const run = await runStore.findWaitingByWaId(tenant, waId);
          if (run) await runStore.setState(run.id, { currentNode: run.currentNode, status: 'done' });
        },
        startTestRun: async (tenant, workflowId, waId) => {
          const wf = await workflowStore.getById(workflowId, tenant);
          if (!wf) return false;
          const contactId = await contactStore.findIdByWaId(tenant, waId);
          return workflowExecutor.startInWindow(tenant, workflowId, wf.graph, { waId, contactId }, { emitEvents: true });
        },
      },
    );
  });

  // File campaign-run (Loop 5). DRY_RUN=true : sender de démo (aucun appel Meta). Sinon : token résolu PAR TENANT
  // (B1), avec intercepteur d'auth (un token révoqué invalide le WABA au lieu de brûler des appels).
  const dryRunSender = new DryRunSender();
  const senderFor = async (campaign: Campaign): Promise<MessageSender> =>
    dryRun ? dryRunSender : metaFactory.senderForTenant(campaign.tenantId, campaign.phoneNumberId);

  await queue.work('campaign-run', async (data) => {
    await campaignRunJob(data, {
      getCampaign: (id) => repo.getCampaign(id),
      senderFor,
      recipients: recipientStore,
      campaigns: new PgCampaignStore(pool),
      frequency: new PgFrequencyStore(pool),
      quality: new PgQualityProvider(pool),
      // Frein par défaut des campagnes sans ratePerMinute (0 = opt-out). Injecté ICI seulement : les tests de
      // câblage de run-job ne le passent pas, donc une campagne à rate null y reste en opt-out (aucun frein).
      defaultRatePerMinute: config.CAMPAIGN_DEFAULT_RATE_PER_MINUTE,
      // Revalide l'appartenance du numéro juste avant d'envoyer (défense contre une réaffectation). Injecté ICI
      // seulement : absent en test/e2e, la garde est sautée (pas de rupture des fixtures sans ligne phone_numbers).
      phoneNumberBelongsToTenant: (pn, tenant) => repo.phoneNumberBelongsToTenant(pn, tenant),
      // Canal RCS : sender construit à partir de l'agent et du message FIGÉS sur la campagne. null -> la
      // campagne est mise en pause avec sa raison, elle ne repart jamais sur le chemin WhatsApp.
      rcsSenderFor: (campaign) => rcsStack.senderForCampaign(campaign),
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
      // Campagne NODE (/v1/sends) : démarre le workflow au bloc ciblé. Fenêtre 24 h déjà vérifiée à la création
      // de l'envoi -> l'executor n'applique pas la garde (startFromNode).
      startWorkflowFromNode: async (tenant, workflowId, startNodeId, waId, contactId) => {
        const wf = await workflowStore.getById(workflowId, tenant);
        if (!wf) return false;
        return workflowExecutor.startFromNode(tenant, workflowId, wf.graph, { waId, contactId }, startNodeId, { ignoreHumanControl: true });
      },
      // Cartes du carousel du template (image + boutons de chaque carte), relues UNE fois par run et servies
      // par le même cache court que les variables. null = template sans carousel -> envoi inchangé.
      // Absente en DRY_RUN : la dep est optionnelle et ce mode ne doit déclencher AUCUN appel Meta.
      ...(dryRun ? {} : {
        getTemplateCarousel: async (tenant: string, name: string, language: string) => {
          const lu = (await templateVarInfo(tenant, name, language))?.carousel;
          // Visuels préparés UNE fois par run : ils sont identiques pour tous les destinataires.
          return lu ? { cards: await prepareCarouselMedia(tenant, lu.cards) } : null;
        },
        // En-tête média : Meta l'exige à CHAQUE envoi, l'image du template ne servant qu'à sa validation. Même
        // cache, même préparation UNE fois par run. `mediaId: null` = préparation échouée -> le moteur refuse
        // la campagne entière avec une raison lisible, au lieu de collectionner les 132012 un par un.
        getTemplateHeaderMedia: async (tenant: string, name: string, language: string) => {
          const info = await templateVarInfo(tenant, name, language);
          if (!info?.headerFormat) return null;
          const mediaId = info.headerMediaUrl ? await prepareHeaderMedia(tenant, info.headerMediaUrl) : null;
          return { headerFormat: info.headerFormat, mediaId };
        },
      }),
      // Journalise le template envoyé (campagne DIRECTE) dans le fil de conversation.
      recordOutbound: (tenant, waId, msg) => inboxStore.recordOutboundByWaId(tenant, waId, msg),
    });
  });

  // File analyze-conversation (Pièce 1). INERTE tant que CONVERSATION_ANALYSIS_ENABLED != 'true' : aucun worker,
  // aucun balayage, aucun appel LLM, zéro coût. Le déclencheur (balayage d'inactivité) est REMPLAÇABLE (temps réel plus tard).
  let analysisSweeper: NodeJS.Timeout | null = null;
  let catchupSweeper: NodeJS.Timeout | null = null;
  if (config.CONVERSATION_ANALYSIS_ENABLED === 'true') {
    const analysisStore = new PgConversationAnalysisStore(pool);
    const llmClient = createLlmClient(
      { provider: config.LLM_PROVIDER, apiKey: config.LLM_API_KEY, model: config.LLM_MODEL, maxTokens: config.LLM_MAX_TOKENS },
      transport,
    );
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
        try {
          const tenants = await analysisStore.listTenantsReadyForCatchup();
          for (const tenantId of tenants) await queue.enqueue('hubspot-catchup', { tenantId }, { singletonKey: `catchup:${tenantId}` });
          // eslint-disable-next-line no-console
          if (tenants.length > 0) console.log(`hubspot-catchup-sweep: ${tenants.length} tenant(s) relancé(s)`);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('hubspot-catchup-sweep erreur:', err instanceof Error ? err.message : err);
          alert('sweeper:hubspot-catchup', `hubspot-catchup-sweep en échec : ${err instanceof Error ? err.message : err}`);
        }
      };
      void catchupSweep();
      catchupSweeper = setInterval(() => void catchupSweep(), config.HUBSPOT_CATCHUP_SWEEP_INTERVAL_MS);
      catchupSweeper.unref();
    }
    const pushAnalyzed = makeOnAnalyzed({
      enabled: pushEnabled,
      // Enfile une RÉFÉRENCE (pas le snapshot) : le handler push-analysis refetch l'état frais (F3-a).
      enqueue: (stored) => queue.enqueue('push-analysis', { conversationId: stored.conversationId, tenantId: stored.tenantId }),
      // eslint-disable-next-line no-console
      onError: (err) => console.error('push-analysis enqueue échoué (best-effort):', err instanceof Error ? err.message : err),
    });

    // DEUX consommateurs du même point de sortie : le push connecteur (Pièce 2) et, depuis E.2, les
    // automations « conversation analysée » (relancer un client mécontent, par exemple). Chacun est isolé :
    // un échec de l'un ne prive pas l'autre, et aucun ne fait échouer le job d'analyse lui-même.
    const onAnalyzed: typeof pushAnalyzed = async (stored) => {
      // Chaque consommateur a SON try/catch ici : l'isolation devient une propriété de cette composition, et
      // non un pari sur le fait que l'appelé avale ses erreurs. Sans ça, un push qui lèverait sauterait
      // l'automation ET ferait rejouer le job d'analyse, donc re-facturerait l'appel LLM.
      try {
        await pushAnalyzed(stored);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('push connecteur ignoré (best-effort):', err instanceof Error ? err.message : err);
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
        console.error('automation « conversation analysée » ignorée (best-effort):', err instanceof Error ? err.message : err);
      }
    };

    const onConversationReady = (conversationId: string, tenantId: string): Promise<void> =>
      queue.enqueue('analyze-conversation', { conversationId, tenantId }, { singletonKey: conversationId });
    await queue.work('analyze-conversation', (data) =>
      analyzeConversationJob(data, {
        store: analysisStore,
        llm: llmClient,
        onAnalyzed, // Pièce 2 : push connecteur (inerte si URL vide) ; consommé aussi par la pièce 3 plus tard
        model: { provider: config.LLM_PROVIDER, model: config.LLM_MODEL },
      }),
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
        // eslint-disable-next-line no-console
        onError: (m, err) => console.error(`${m}:`, err instanceof Error ? err.message : err),
      });
    void analysisSweep();
    analysisSweeper = setInterval(() => void analysisSweep(), config.CONVERSATION_ANALYSIS_SWEEP_INTERVAL_MS);
    analysisSweeper.unref();
  }

  // Sweeper : récupère périodiquement les destinataires bloqués en 'sending'.
  const sweep = async (): Promise<void> => {
    try {
      const n = await recipientStore.reclaimStale(config.STALE_SENDING_MS);
      // eslint-disable-next-line no-console
      if (n > 0) console.log(`sweeper: ${n} destinataire(s) 'sending' bloqué(s) -> 'pending'`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('sweeper erreur:', err instanceof Error ? err.message : err);
      alert('sweeper:reclaim', `sweeper reclaim en échec : ${err instanceof Error ? err.message : err}`);
    }
  };
  void sweep();
  const sweeper = setInterval(() => void sweep(), config.RECLAIM_INTERVAL_MS);
  sweeper.unref();

  // Sweeper de PLANIFICATION : enfile les campagnes programmées dues (scheduled_at <= maintenant). Miroir du
  // sweeper d'analyse. Toutes les 60 s (granularité suffisante pour un lancement programmé). singletonKey +
  // markRunning garantissent un enqueue exactement-une-fois même avec deux instances worker.
  const scheduleSweep = async (): Promise<void> => {
    try {
      const n = await runCampaignScheduleSweep({
        listDue: () => repo.listDueScheduled(),
        enqueueRun: (id, expireInSeconds) => queue.enqueue('campaign-run', { campaignId: id }, { singletonKey: id, expireInSeconds }),
        markRunning: (id) => repo.markScheduledRunning(id),
        defaultRatePerMinute: config.CAMPAIGN_DEFAULT_RATE_PER_MINUTE,
      });
      // eslint-disable-next-line no-console
      if (n > 0) console.log(`schedule-sweep: ${n} campagne(s) programmée(s) lancée(s)`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('schedule-sweep erreur:', err instanceof Error ? err.message : err);
      alert('sweeper:schedule', `schedule-sweep en échec : ${err instanceof Error ? err.message : err}`);
    }
  };
  void scheduleSweep();
  const scheduleSweeper = setInterval(() => void scheduleSweep(), 60_000);
  scheduleSweeper.unref();

  // Sweeper de RÉVEIL : reprend les parcours endormis sur un bloc « Attente » arrivé à échéance. Même patron
  // que le sweeper de planification. La granularité du délai vaut cet intervalle : une attente de 5 min repart
  // entre 5 et 6 min, ce que l'UI annonce comme « environ ».
  // Garde de RÉ-ENTRANCE : `setInterval` n'attend pas la passe précédente. Sans elle, une passe lente (lot de
  // 50 reprises + relances Meta) verrait la suivante démarrer et re-claimer des runs dont le bail a expiré.
  let wakeEnCours = false;
  const wakeSweep = async (): Promise<void> => {
    if (wakeEnCours) return;
    wakeEnCours = true;
    try {
      const n = await runWorkflowWakeSweep({
        claimDue: (limit) => runStore.claimDueSleeping(limit),
        resume: (run) => workflowExecutor.resume(run),
        closeStale: () => runStore.closeStaleSleeping(),
      });
      // eslint-disable-next-line no-console
      if (n > 0) console.log(`wake-sweep: ${n} parcours repris après attente`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('wake-sweep erreur:', err instanceof Error ? err.message : err);
      alert('sweeper:wake', `wake-sweep en échec : ${err instanceof Error ? err.message : err}`);
    } finally {
      wakeEnCours = false;
    }
  };
  void wakeSweep();
  const wakeSweeper = setInterval(() => void wakeSweep(), config.WORKFLOW_WAKE_SWEEP_INTERVAL_MS);
  wakeSweeper.unref();

  // Auto-relance des échecs (F6) : 131049 (fenêtre matinale Europe/Paris, 1 relance) + 131026 (1 relance puis
  // injoignable dans HubSpot au 2e échec). Gaté par le canal service (le flag injoignable en dépend) : monté seulement
  // si le connecteur est configuré. Le sweep lui-même ne touche QUE les tenants ayant activé le toggle auto_retry.
  const isMorningParis = (nowMs: number): boolean => {
    const h = Number(new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false }).format(new Date(nowMs)));
    return h >= 8 && h < 12; // « début de journée »
  };
  let retrySweeper: NodeJS.Timeout | undefined;
  if (config.HUBSPOT_SERVICE_URL) {
    const retrySweep = async (): Promise<void> => {
      try {
        const res = await runRetrySweep({
          isMorningWindow: () => isMorningParis(Date.now()),
          list131049: () => repo.listRetry131049(Date.now()),
          list131026: () => repo.listRetry131026(),
          list131026SecondFail: () => repo.listRetry131026SecondFail(),
          resetForRetry: (id) => repo.resetForRetry(id),
          markUnreachableDone: (id) => repo.markUnreachableDone(id),
          enqueueRun: (id) => queue.enqueue('campaign-run', { campaignId: id }, { singletonKey: id }),
          flagUnreachable: async (tenantId, e164) => {
            await flagContactUnreachable({ baseUrl: config.HUBSPOT_SERVICE_URL, secret: config.HUBSPOT_SERVICE_SECRET, transport }, tenantId, e164);
          },
        });
        // eslint-disable-next-line no-console
        if (res.retried > 0 || res.flagged > 0) console.log(`retry-sweep: ${res.retried} relancé(s), ${res.flagged} injoignable(s)`);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('retry-sweep erreur:', err instanceof Error ? err.message : err);
        alert('sweeper:retry', `retry-sweep en échec : ${err instanceof Error ? err.message : err}`);
      }
    };
    void retrySweep();
    retrySweeper = setInterval(() => void retrySweep(), config.AUTO_RETRY_SWEEP_INTERVAL_MS);
    retrySweeper.unref();
  }

  // Sweeper de CONTRÔLE : rend la main au scénario quand plus personne ne s'occupe d'une conversation.
  // Il n'existe AUCUN release automatique côté Meta : sans ce balayage, un opérateur qui ferme son onglet
  // (ou un worker qui meurt) gèlerait la conversation indéfiniment, scénario muet et client sans réponse.
  // C'est la soupape de la capacité de gel, elle part donc dans le même déploiement qu'elle.
  const controlSweep = async (): Promise<void> => {
    try {
      const rendues = await runControlSweep({
        listHeldControl: (limit) => inboxStore.listHeldControl(limit),
        setControlOwner: (t, w, o, opts) => inboxStore.setControlOwner(t, w, o, opts),
        // Défauts du serveur, appliqués aux clients qui n'ont rien réglé.
        timeouts: { app_human: config.CONTROL_HUMAN_TIMEOUT_MS, mba: config.CONTROL_MBA_TIMEOUT_MS },
        // Réglage par client du gel humain : c'est lui qui décide combien de temps on laisse un
        // opérateur travailler tranquille avant que la conversation reparte.
        handbackMsByTenant: (ids) => settingsStore.handbackMsByTenant(ids),
        // Destination de reprise par client (C.4) : rendre au scénario (`resume`) ou laisser à l'humain
        // (`inbox`). Une surcharge par conversation (portée par `listHeldControl`) prime sur ce défaut.
        returnBehaviorByTenant: (ids) => settingsStore.returnBehaviorByTenant(ids),
      });
      // eslint-disable-next-line no-console
      if (rendues > 0) console.log(`control-sweep: ${rendues} conversation(s) rendue(s) au scénario`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('control-sweep erreur:', err instanceof Error ? err.message : err);
      alert('sweeper:control', `control-sweep en échec : ${err instanceof Error ? err.message : err}`);
    }
  };
  void controlSweep();
  const controlSweeper = setInterval(() => void controlSweep(), config.CONTROL_SWEEP_INTERVAL_MS);
  controlSweeper.unref();

  // Sweeper d'idempotence API : purge les clés Idempotency-Key plus vieilles que 24h (fenêtre de dédup).
  const idempotencyStore = new PgApiIdempotencyStore(pool);
  const idempotencySweep = async (): Promise<void> => {
    try {
      const n = await idempotencyStore.sweepOlderThan(24 * 60 * 60 * 1000);
      // eslint-disable-next-line no-console
      if (n > 0) console.log(`idempotency-sweep: ${n} clé(s) d'idempotence purgée(s)`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('idempotency-sweep erreur:', err instanceof Error ? err.message : err);
      alert('sweeper:idempotency', `idempotency-sweep en échec : ${err instanceof Error ? err.message : err}`);
    }
  };
  void idempotencySweep();
  const idempotencySweeper = setInterval(() => void idempotencySweep(), 60 * 60 * 1000);
  idempotencySweeper.unref();

  // Sweeper de STATUT/QUALITÉ des numéros (item 4.10). Le pull live n'était branché QUE dans la route Accueil :
  // quality_rating/status ne se rafraîchissaient qu'à l'ouverture de la page par un admin. Ce balayage les
  // rafraîchit tous (cross-tenant, lecture Graph seule) et alerte sur jeton invalide / numéro non connecté /
  // qualité rouge. Palliatif par polling (le temps réel = webhook quality, non câblé, cf. migration 0004).
  // GATE : sans token Meta global, aucun pull possible (mêmes conditions que la route, index.ts) -> pas de sweep
  // (évite un faux « AUTH » sur un client vide en dev/test). alertedPhones dédup par TRANSITION (perdu au restart).
  let statusSweeper: NodeJS.Timeout | null = null;
  if (config.META_ACCESS_TOKEN) {
    const opsStore = new PgOpsStore(pool, config.PGBOSS_SCHEMA);
    const alertedPhones = new Map<string, PhoneProblem>();
    const statusSweep = async (): Promise<void> => {
      try {
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
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('phone-status-sweep erreur:', err instanceof Error ? err.message : err);
        alert('sweeper:phone-status', `phone-status-sweep en échec : ${err instanceof Error ? err.message : err}`);
      }
    };
    void statusSweep();
    statusSweeper = setInterval(() => void statusSweep(), config.PHONE_STATUS_SWEEP_INTERVAL_MS);
    statusSweeper.unref();
  }

  installGracefulShutdown(async () => {
    clearInterval(heartbeat);
    clearInterval(sweeper);
    clearInterval(scheduleSweeper);
    if (retrySweeper) clearInterval(retrySweeper);
    clearInterval(controlSweeper);
    clearInterval(idempotencySweeper);
    if (analysisSweeper) clearInterval(analysisSweeper);
    if (catchupSweeper) clearInterval(catchupSweeper);
    if (statusSweeper) clearInterval(statusSweeper);
    await queue.stop();
    await pool.end();
  });

  const files = [
    'webhook',
    'campaign-run',
    AUTOMATION_EVENT_QUEUE,
    ...(config.CONVERSATION_ANALYSIS_ENABLED === 'true' ? ['analyze-conversation'] : []),
    ...(config.CONVERSATION_ANALYSIS_ENABLED === 'true' && config.CONNECTOR_PUSH_URL !== '' ? ['push-analysis', 'hubspot-catchup'] : []),
  ];
  // eslint-disable-next-line no-console
  console.log(`messagingme-mba worker démarré (files: ${files.join(', ')})${dryRun ? ' [DRY_RUN]' : ''}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
