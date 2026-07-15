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
import { PgInboxStore } from './inbox/store.pg';
import { logTemplateSent } from './inbox/outbound-log';
import { PgFlowStore } from './flow/store.pg';
import { PgContactStore } from './crm/contact-store.pg';
import { PgTagStore } from './crm/tag-store.pg';
import { PgTemplateHintStore } from './crm/template-hints.pg';
import { countTemplateVariables } from './crm/template';
import { PgWorkflowStore } from './workflow/store.pg';
import { PgWorkflowRunStore } from './workflow/run-store.pg';
import { WorkflowExecutor } from './workflow/executor';
import { buildWorkflowTemplateComponents } from './workflow/template-send';
import { PgConversationAnalysisStore } from './analysis/store.pg';
import { analyzeConversationJob } from './analysis/job';
import { runAnalysisSweep } from './analysis/sweep';
import { createLlmClient } from './analysis/llm-client';
import { getEnrichment } from './analysis/enrichment';
import { pushAnalysisJob } from './analysis/push-job';
import { makeOnAnalyzed, postAnalysis } from './analysis/connector-push';
import { PgPhoneStatusStore } from './account/store.pg';
import { MetaClient } from './meta/client';
import { MetaTemplateClient } from './meta/templates';
import { FetchTransport } from './meta/http';
import { DryRunSender } from './campaign/dry-run-sender';
import type { MessageSender } from './campaign/engine';
import type { Campaign } from './campaign/types';
import { installGracefulShutdown } from './shutdown';

async function main(): Promise<void> {
  const queue = new PgBossQueue(config.DATABASE_URL, config.PGBOSS_SCHEMA);
  await queue.start();

  // File webhook (Loop 1). Le PgRecipientStore applique les statuts de livraison ; le
  // PgInboxStore enregistre les messages entrants (réponses / taps de boutons) en conversations ;
  // le report Flow -> user fields (flowStore.findByRef + contactStore.mergeFieldsByPhone) est ISOLÉ
  // dans handleWebhookJob (ne fait jamais échouer le job partagé avec les statuts).
  const eventStore = new PgEventStore(pool);
  const recipientStore = new PgRecipientStore(pool);
  const inboxStore = new PgInboxStore(pool);
  const flowStore = new PgFlowStore(pool);
  const contactStore = new PgContactStore(pool);
  const repo = new PgCampaignRepo(pool);
  const transport = new FetchTransport();
  const dryRun = config.DRY_RUN === 'true';

  // Exécuteur de workflows : quand un contact répond, on avance son run (blocs tag/field/template -> inbox).
  const workflowStore = new PgWorkflowStore(pool);
  const runStore = new PgWorkflowRunStore(pool);
  const tagStore = new PgTagStore(pool);
  const hintStore = new PgTemplateHintStore(pool);

  // Cache court du corps live d'un template (nb de variables N + exemples) par WABA|nom|langue : évite un appel
  // Meta list() par destinataire d'une campagne workflow. TTL court -> tolère un template édité en cours de route.
  const tplVarCache = new Map<string, { at: number; count: number }>();
  const TPL_CACHE_MS = 5 * 60_000;
  // `count` = MAX des positions {{n}} (cf. countTemplateVariables) : « {{1}} ... {{3}} » attend 3 params pour Meta,
  // pas 2. null = indéterminable (WABA absent / template introuvable / réseau) -> l'appelant NE PAS envoyer.
  const templateVarInfo = async (tenant: string, name: string, language: string): Promise<{ count: number } | null> => {
    const waba = await repo.getTenantWabaId(tenant);
    if (!waba) return null;
    const key = `${waba}|${name}|${language}`;
    const cached = tplVarCache.get(key);
    if (cached && Date.now() - cached.at < TPL_CACHE_MS) return { count: cached.count };
    const tplClient = new MetaTemplateClient(config.META_ACCESS_TOKEN, config.META_GRAPH_VERSION);
    const list = await tplClient.list(waba);
    // Exact (nom + langue), sinon repli sur le nom seul (langue par défaut d'un template mono-langue).
    const tpl = list.find((t) => t.name === name && t.language === language) ?? list.find((t) => t.name === name);
    if (!tpl) return null;
    const count = countTemplateVariables(tpl.body);
    tplVarCache.set(key, { at: Date.now(), count });
    return { count };
  };

  const workflowExecutor = new WorkflowExecutor({
    runs: runStore,
    getGraph: async (id, tenant) => (await workflowStore.getById(id, tenant))?.graph ?? null,
    // Applique le tag au contact ET le déclare dans le référentiel (défense : un tag posé au runtime — y compris par
    // un ancien workflow non re-sauvegardé — atterrit dans Contenus > Tags). Best-effort, n'échoue jamais l'action.
    applyTag: async (tenant, waId, tag) => {
      // Même valeur normalisée (trim + slice 64) posée SUR le contact ET déclarée dans le référentiel -> pas de
      // doublon 'vip ' vs 'vip' ni tag>64 tronqué d'un côté seulement (Contenus > Tags = union des deux sources).
      const clean = tag.trim().slice(0, 64);
      if (clean === '') return;
      await contactStore.addTagsByPhone(tenant, waId, [clean]);
      try { await tagStore.create(tenant, clean); } catch { /* déclaration best-effort */ }
    },
    setField: async (tenant, waId, key, value) => { await contactStore.mergeFieldsByPhone(tenant, waId, { [key]: value }); },
    sendTemplate: async (tenant, waId, name, language, buttons, explicitParams) => {
      if (dryRun) return; // DRY_RUN : aucun appel Meta
      const pn = await repo.getTenantPhoneNumberId(tenant);
      if (!pn) {
        // eslint-disable-next-line no-console
        console.error(`workflow sendTemplate: aucun numéro pour le tenant ${tenant}, template « ${name} » non envoyé`);
        return;
      }
      const client = new MetaClient({ transport, token: config.META_ACCESS_TOKEN, phoneNumberId: pn, version: config.META_GRAPH_VERSION });

      // Campagne workflow : les variables du 1er template sont DÉJÀ résolues par contact (paramMapping de la campagne,
      // via buildRecipients). On les utilise directement, sans relire le corps live du template ni les hints (chemin
      // identique aux campagnes template DIRECTES). `explicitParams` DÉFINI (même `[]` = template sans variable) ->
      // ce chemin ; `undefined` = envoi via `advance` (réponse webhook) -> chemin hints stockés ci-dessous.
      // Garde-fou : une valeur vide fait sauter l'envoi (jamais `text:''`).
      if (explicitParams !== undefined) {
        const { components, missing } = buildWorkflowTemplateComponents({ hints: [], varCount: explicitParams.length, contact: {}, buttons, explicitParams });
        if (missing.length > 0) {
          // eslint-disable-next-line no-console
          console.error(`workflow sendTemplate: « ${name} » non envoyé à ${waId} : variable(s) manquante(s) position(s) ${missing.join(',')}`);
          return;
        }
        const res = await client.sendTemplate(waId, { name, language, ...(components.length > 0 ? { components } : {}) });
        await logTemplateSent(inboxStore, tenant, waId, name, res.messageId);
        return;
      }

      // Variables du corps : on résout les {{n}} avec les attributs du contact (indices template_param_hints ->
      // champ, ex. {{1}}=prenom). On NE devine PAS : si les variables sont indéterminables (info null) ou si une
      // valeur manque, on NE PAS envoyer (évite 132000 « nb de variables » et 132012 « text:'' »).
      let info: { count: number } | null = null;
      try {
        info = await templateVarInfo(tenant, name, language);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`workflow sendTemplate: variables de « ${name} » indéterminables:`, err instanceof Error ? err.message : err);
      }
      if (info === null) {
        // eslint-disable-next-line no-console
        console.error(`workflow sendTemplate: variables de « ${name} » indéterminables (WABA/template/réseau) -> non envoyé à ${waId}`);
        return;
      }
      let hints: Awaited<ReturnType<typeof hintStore.get>> = [];
      let contact = null as Awaited<ReturnType<typeof contactStore.getResolvableByPhone>>;
      if (info.count > 0) {
        [hints, contact] = await Promise.all([
          hintStore.get(tenant, name, language),
          contactStore.getResolvableByPhone(tenant, waId),
        ]);
      }
      // Payload CONTRÔLÉ sur chaque bouton quick-reply -> au tap, le webhook renvoie `btn:<index>`, qui sélectionne
      // la branche (sourceHandle) de façon déterministe. Body avant boutons (ordre attendu par l'API Cloud).
      const { components, missing } = buildWorkflowTemplateComponents({ hints, varCount: info.count, contact: contact ?? {}, buttons });
      if (missing.length > 0) {
        // eslint-disable-next-line no-console
        console.error(`workflow sendTemplate: « ${name} » non envoyé à ${waId} : variable(s) manquante(s) position(s) ${missing.join(',')}`);
        return;
      }
      const res = await client.sendTemplate(waId, { name, language, ...(components.length > 0 ? { components } : {}) });
      // Journalise le template dans le fil de conversation (fil d'inbox complet + transcript d'analyse). Best-effort.
      await logTemplateSent(inboxStore, tenant, waId, name, res.messageId);
    },
  });

  await queue.work('webhook', async (data) => {
    await handleWebhookJob(
      data, eventStore, recipientStore, inboxStore,
      { lookup: flowStore, writer: contactStore },
      { phoneNumberTenant: (pnid) => inboxStore.phoneNumberTenant(pnid), advance: (t, w, m, bp) => workflowExecutor.advance(t, w, m, bp) },
      // Auto-création de fiche depuis l'inbound (par numéro OU BSUID) : les clients qui écrivent sans
      // partager leur numéro (post-octobre) atterrissent quand même dans le CRM. Isolé dans processInbound.
      (tenant, m) => contactStore.upsertFromInbound(tenant, m.waId, m.profileName).then(() => {}),
    );
  });

  // File campaign-run (Loop 5). DRY_RUN=true : sender de démo (aucun appel Meta).
  const dryRunSender = new DryRunSender();
  const senderFor = (campaign: Campaign): MessageSender =>
    dryRun
      ? dryRunSender
      : new MetaClient({
          transport,
          token: config.META_ACCESS_TOKEN,
          phoneNumberId: campaign.phoneNumberId,
          version: config.META_GRAPH_VERSION,
          marketingViaLite: config.META_MM_LITE === 'true',
        });

  await queue.work('campaign-run', async (data) => {
    await campaignRunJob(data, {
      getCampaign: (id) => repo.getCampaign(id),
      senderFor,
      recipients: new PgRecipientStore(pool),
      campaigns: new PgCampaignStore(pool),
      frequency: new PgFrequencyStore(pool),
      quality: new PgQualityProvider(pool),
      // Campagne workflow : démarre le workflow (blocs sync + 1er template) pour chaque destinataire.
      // firstTemplateParams = variables du 1er template déjà résolues par contact (paramMapping de la campagne).
      startWorkflow: async (tenant, workflowId, waId, contactId, firstTemplateParams) => {
        const wf = await workflowStore.getById(workflowId, tenant);
        if (wf) await workflowExecutor.start(tenant, workflowId, wf.graph, { waId, contactId }, firstTemplateParams);
      },
      // Journalise le template envoyé (campagne DIRECTE) dans le fil de conversation.
      recordOutbound: (tenant, waId, msg) => inboxStore.recordOutboundByWaId(tenant, waId, msg),
    });
  });

  // File analyze-conversation (Pièce 1). INERTE tant que CONVERSATION_ANALYSIS_ENABLED != 'true' : aucun worker,
  // aucun balayage, aucun appel LLM, zéro coût. Le déclencheur (balayage d'inactivité) est REMPLAÇABLE (temps réel plus tard).
  let analysisSweeper: NodeJS.Timeout | null = null;
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
      const phoneStatusStore = new PgPhoneStatusStore(pool);
      await queue.work('push-analysis', (data) =>
        pushAnalysisJob(data, {
          getEnrichment: (id) => getEnrichment(pool, id),
          // GATE par numéro : ne pousse au connecteur mm-hubspot QUE si la ligne du tenant est hubspot_connected=true.
          isHubspotConnected: (tenantId, line) => phoneStatusStore.isHubspotConnectedForNumber(tenantId, line),
          post: (event) => postAnalysis(event, { url: config.CONNECTOR_PUSH_URL, secret: config.CONNECTOR_PUSH_SECRET, transport }),
          // eslint-disable-next-line no-console
          log: (m) => console.log(m),
        }),
      );
    }
    const onAnalyzed = makeOnAnalyzed({
      enabled: pushEnabled,
      enqueue: (stored) => queue.enqueue('push-analysis', stored),
      // eslint-disable-next-line no-console
      onError: (err) => console.error('push-analysis enqueue échoué (best-effort):', err instanceof Error ? err.message : err),
    });

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
    }
  };
  void sweep();
  const sweeper = setInterval(() => void sweep(), config.RECLAIM_INTERVAL_MS);
  sweeper.unref();

  installGracefulShutdown(async () => {
    clearInterval(sweeper);
    if (analysisSweeper) clearInterval(analysisSweeper);
    await queue.stop();
    await pool.end();
  });

  const files = [
    'webhook',
    'campaign-run',
    ...(config.CONVERSATION_ANALYSIS_ENABLED === 'true' ? ['analyze-conversation'] : []),
    ...(config.CONVERSATION_ANALYSIS_ENABLED === 'true' && config.CONNECTOR_PUSH_URL !== '' ? ['push-analysis'] : []),
  ];
  // eslint-disable-next-line no-console
  console.log(`messagingme-mba worker démarré (files: ${files.join(', ')})${dryRun ? ' [DRY_RUN]' : ''}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
