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
  const queue = new PgBossQueue(url, 'pgboss_test');

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
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
});
