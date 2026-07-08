import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PgBossQueue } from '../../src/queue/pgboss';
import { PgEventStore } from '../../src/webhooks/store';
import { handleWebhookJob } from '../../src/webhooks/handler';
import { pgSsl } from '../../src/db/ssl';

const url = process.env.DATABASE_URL ?? '';
const KEY = 'msg:wamid.INTEG';
const payload = {
  entry: [{ changes: [{ field: 'messages', value: { messages: [{ id: 'wamid.INTEG' }] } }] }],
};

// N'exécute que si une DB est configurée. Schéma pg-boss isolé : pgboss_test.
describe.skipIf(!url)('intégration pg-boss + PgEventStore (Supabase)', () => {
  let pool: Pool;
  // Pools bornés : le pooler Supabase en session mode plafonne à 15 connexions ; ce test
  // ouvre plusieurs instances pg-boss (dont la DLQ) -> garder la somme sous la limite.
  const queue = new PgBossQueue(url, 'pgboss_test', { max: 4 });

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 3 });
    await pool.query('delete from webhook_events where meta_message_id = $1', [KEY]);
    await queue.start();
  });

  afterAll(async () => {
    await pool.query('delete from webhook_events where meta_message_id = $1', [KEY]);
    await queue.stop();
    await pool.end();
  });

  it('PgEventStore : insert idempotent (2x -> 1 ligne)', async () => {
    const store = new PgEventStore(pool);
    await handleWebhookJob(payload, store);
    await handleWebhookJob(payload, store);
    const res = await pool.query('select count(*)::int as n from webhook_events where meta_message_id = $1', [KEY]);
    expect(res.rows[0]?.n).toBe(1);
  });

  it('pg-boss : enqueue -> work délivre le job', async () => {
    const received = new Promise<unknown>((resolve) => {
      void queue.work('itest-webhook', async (data) => resolve(data));
    });
    await queue.enqueue('itest-webhook', { ping: 'pong' });
    const data = (await Promise.race([
      received,
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000)),
    ])) as { ping?: string };
    expect(data.ping).toBe('pong');
  });

  it('pg-boss : un job qui throw finit en DLQ après épuisement des retries', async () => {
    // retryLimit:0 -> une seule tentative, puis dead-letter immédiat vers itest-dlq-src-dlq.
    const dlqQueue = new PgBossQueue(url, 'pgboss_test', { retryLimit: 0, max: 3 });
    await dlqQueue.start();
    try {
      let attempts = 0;
      await dlqQueue.work('itest-dlq-src', async () => {
        attempts += 1;
        throw new Error('échec volontaire');
      });
      await dlqQueue.enqueue('itest-dlq-src', { boom: true });

      // Attendre que le job atterrisse dans la DLQ (poll, max 20s).
      let inDlq = 0;
      for (let i = 0; i < 40 && inDlq === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 500));
        inDlq = await dlqQueue.pullPending('itest-dlq-src-dlq');
      }
      expect(inDlq).toBeGreaterThanOrEqual(1);
      expect(attempts).toBe(1); // une seule tentative (retryLimit:0), pas de rejeu infini
    } finally {
      await dlqQueue.stop();
    }
  });
});
