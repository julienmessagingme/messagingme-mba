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
  const tplVarCache = new Map<string, { at: number; count: number; examples: string[] }>();
  const TPL_CACHE_MS = 5 * 60_000;
  const VAR_RE = /\{\{\s*\d+\s*\}\}/g;
  const templateVarInfo = async (tenant: string, name: string, language: string): Promise<{ count: number; examples: string[] } | null> => {
    const waba = await repo.getTenantWabaId(tenant);
    if (!waba) return null;
    const key = `${waba}|${name}|${language}`;
    const cached = tplVarCache.get(key);
    if (cached && Date.now() - cached.at < TPL_CACHE_MS) return { count: cached.count, examples: cached.examples };
    const tplClient = new MetaTemplateClient(config.META_ACCESS_TOKEN, config.META_GRAPH_VERSION);
    const list = await tplClient.list(waba);
    // Exact (nom + langue), sinon repli sur le nom seul (langue par défaut d'un template mono-langue).
    const tpl = list.find((t) => t.name === name && t.language === language) ?? list.find((t) => t.name === name);
    if (!tpl) return null;
    const count = new Set(tpl.body.match(VAR_RE) ?? []).size;
    const examples = tpl.example ?? [];
    tplVarCache.set(key, { at: Date.now(), count, examples });
    return { count, examples };
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
    sendTemplate: async (tenant, waId, name, language, buttons) => {
      if (dryRun) return; // DRY_RUN : aucun appel Meta
      const pn = await repo.getTenantPhoneNumberId(tenant);
      if (!pn) {
        // eslint-disable-next-line no-console
        console.error(`workflow sendTemplate: aucun numéro pour le tenant ${tenant}, template « ${name} » non envoyé`);
        return;
      }
      const client = new MetaClient({ transport, token: config.META_ACCESS_TOKEN, phoneNumberId: pn, version: config.META_GRAPH_VERSION });
      // Variables du corps : on résout les {{n}} avec les attributs du contact (indices template_param_hints ->
      // champ, ex. {{1}}=prenom), repli sur les exemples du template. On fournit EXACTEMENT N params -> plus de 132000.
      let varCount = 0;
      let examples: string[] = [];
      let hints: Awaited<ReturnType<typeof hintStore.get>> = [];
      let contact = null as Awaited<ReturnType<typeof contactStore.getResolvableByPhone>>;
      try {
        const info = await templateVarInfo(tenant, name, language);
        if (info && info.count > 0) {
          varCount = info.count;
          examples = info.examples;
          [hints, contact] = await Promise.all([
            hintStore.get(tenant, name, language),
            contactStore.getResolvableByPhone(tenant, waId),
          ]);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`workflow sendTemplate: résolution des variables échouée pour « ${name} »:`, err instanceof Error ? err.message : err);
      }
      // Payload CONTRÔLÉ sur chaque bouton quick-reply -> au tap, le webhook renvoie `btn:<index>`, qui sélectionne
      // la branche (sourceHandle) de façon déterministe. Body avant boutons (ordre attendu par l'API Cloud).
      const components = buildWorkflowTemplateComponents({ hints, varCount, contact: contact ?? {}, examples, buttons });
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
      startWorkflow: async (tenant, workflowId, waId, contactId) => {
        const wf = await workflowStore.getById(workflowId, tenant);
        if (wf) await workflowExecutor.start(tenant, workflowId, wf.graph, { waId, contactId });
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
      await queue.work('push-analysis', (data) =>
        pushAnalysisJob(data, {
          getEnrichment: (id) => getEnrichment(pool, id),
          post: (event) => postAnalysis(event, { url: config.CONNECTOR_PUSH_URL, secret: config.CONNECTOR_PUSH_SECRET, transport }),
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
