import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PgBossQueue } from '../../src/queue/pgboss';
import { BATTEMENT_SECONDES } from '../../src/queue/names';
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
    await handleWebhookJob(payload, { store });
    await handleWebhookJob(payload, { store });
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

  /**
   * 🔴 LE BATTEMENT DE CŒUR ATTEINT LA FILE ET SES TÂCHES (banc des trente espaces, 2026-10-03). Sans lui, une tâche
   * dont le worker meurt attend 15 min avant d'être rejouée. Lu en base, parce que tout le piège est là : posé sur
   * `createQueue` (un ON CONFLICT DO NOTHING), il n'atteindrait aucune file existante ; et la tâche ne le recopie de
   * sa file qu'à sa création.
   */
  it('pg-boss : la file porte son battement de cœur, et une tâche créée le recopie', async () => {
    await queue.enqueue('itest-battement', { ping: 'battement' });
    const file = await pool.query<{ heartbeat_seconds: number | null }>(
      'select heartbeat_seconds from pgboss_test.queue where name = $1', ['itest-battement'],
    );
    expect(file.rows[0]?.heartbeat_seconds).toBe(BATTEMENT_SECONDES);
    const tache = await pool.query<{ heartbeat_seconds: number | null }>(
      `select heartbeat_seconds from pgboss_test.job where name = $1 and data->>'ping' = 'battement'`, ['itest-battement'],
    );
    expect(tache.rows[0]?.heartbeat_seconds).toBe(BATTEMENT_SECONDES);
  });

  /**
   * Lot C du plan `2026-09-28-api-multi-instances.md` : l'API empile par son pool APPLICATIF prêté à pg-boss, le
   * worker dépile avec le sien, sur le même schéma, comme en production. La création de la file passe aussi par
   * le prêt : c'est le bloc `BEGIN; ...; COMMIT;` à plusieurs instructions, que `pg` n'accepte que sans valeurs.
   */
  it('pg-boss : une instance sur un pool PRÊTÉ empile, l’instance qui a son pool dépile', async () => {
    const productrice = new PgBossQueue(pool, 'pgboss_test');
    await productrice.start();
    try {
      const recu = new Promise<unknown>((resolve) => {
        void queue.work('itest-pool-prete', async (data) => resolve(data));
      });
      await productrice.enqueue('itest-pool-prete', { de: 'api' });
      const data = (await Promise.race([
        recu,
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000)),
      ])) as { de?: string };
      expect(data.de).toBe('api');
    } finally {
      await productrice.stop();
    }
    // L'arrêt de la file ne ferme pas le pool prêté : c'est l'API qui le ferme, APRÈS elle (`arreterApi`).
    const r = await pool.query<{ n: number }>('select 1 as n');
    expect(r.rows[0]?.n).toBe(1);
  });

  it('pg-boss : une instance sur un pool PRÊTÉ ne crée ni ne migre JAMAIS le schéma', async () => {
    // Un schéma à part, remis à zéro : c'est le worker qui l'installe, et ce test n'en démarre aucun dessus.
    await pool.query('drop schema if exists pgboss_test_prete cascade');
    const productrice = new PgBossQueue(pool, 'pgboss_test_prete');
    await expect(productrice.start()).rejects.toThrow(/not installed.*WORKER/);
    const r = await pool.query<{ t: string | null }>("select to_regclass('pgboss_test_prete.version')::text as t");
    expect(r.rows[0]?.t).toBeNull();
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

      // Attendre que le job atterrisse dans la DLQ (poll, max 20s). Lecture SQL directe plutôt qu'un
      // `fetch` : compter ne doit pas CONSOMMER les jobs comptés (l'ancien helper les passait `active`),
      // et cette plomberie de test n'a rien à faire dans la classe de production.
      let inDlq = 0;
      for (let i = 0; i < 40 && inDlq === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 500));
        const res = await pool.query<{ n: string }>(
          "select count(*) as n from pgboss_test.job where name = $1 and state = 'created'",
          ['itest-dlq-src-dlq'],
        );
        inDlq = Number(res.rows[0]?.n ?? 0);
      }
      expect(inDlq).toBeGreaterThanOrEqual(1);
      expect(attempts).toBe(1); // une seule tentative (retryLimit:0), pas de rejeu infini
    } finally {
      await dlqQueue.stop();
    }
  });
});
