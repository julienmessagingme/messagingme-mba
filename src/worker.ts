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
import { PgFlowStore } from './flow/store.pg';
import { PgContactStore } from './crm/contact-store.pg';
import { PgWorkflowStore } from './workflow/store.pg';
import { PgWorkflowRunStore } from './workflow/run-store.pg';
import { WorkflowExecutor } from './workflow/executor';
import { MetaClient } from './meta/client';
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
  const workflowExecutor = new WorkflowExecutor({
    runs: runStore,
    getGraph: async (id, tenant) => (await workflowStore.getById(id, tenant))?.graph ?? null,
    applyTag: async (tenant, waId, tag) => { await contactStore.addTagsByPhone(tenant, waId, [tag]); },
    setField: async (tenant, waId, key, value) => { await contactStore.mergeFieldsByPhone(tenant, waId, { [key]: value }); },
    sendTemplate: async (tenant, waId, name, language) => {
      if (dryRun) return; // DRY_RUN : aucun appel Meta
      const pn = await repo.getTenantPhoneNumberId(tenant);
      if (!pn) {
        // eslint-disable-next-line no-console
        console.error(`workflow sendTemplate: aucun numéro pour le tenant ${tenant}, template « ${name} » non envoyé`);
        return;
      }
      const client = new MetaClient({ transport, token: config.META_ACCESS_TOKEN, phoneNumberId: pn, version: config.META_GRAPH_VERSION });
      await client.sendTemplate(waId, { name, language });
    },
  });

  await queue.work('webhook', async (data) => {
    await handleWebhookJob(
      data, eventStore, recipientStore, inboxStore,
      { lookup: flowStore, writer: contactStore },
      { phoneNumberTenant: (pnid) => inboxStore.phoneNumberTenant(pnid), advance: (t, w, m) => workflowExecutor.advance(t, w, m) },
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
    });
  });

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
    await queue.stop();
    await pool.end();
  });

  // eslint-disable-next-line no-console
  console.log(`messagingme-mba worker démarré (files: webhook, campaign-run)${dryRun ? ' [DRY_RUN]' : ''}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
