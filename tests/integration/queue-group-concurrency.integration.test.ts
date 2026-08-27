import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PgBossQueue } from '../../src/queue/pgboss';

const url = process.env.DATABASE_URL ?? '';

// N'exécute que si une DB est configurée (CI : Postgres jetable). JAMAIS lancé par `npm test` (vitest.config.ts
// exclut tests/integration/**), et JAMAIS en local (le DATABASE_URL local pointe la prod). Schéma isolé pgboss_test.
describe.skipIf(!url)('intégration pg-boss : concurrence par groupe (tenant)', () => {
  // Pool borné : le pooler Supabase en session mode plafonne à 15 connexions, cette instance ouvre son pool
  // (plus la DLQ) -> garder `max` sous la limite.
  const queue = new PgBossQueue(url, 'pgboss_test', { max: 4 });

  beforeAll(async () => {
    await queue.start();
  });
  afterAll(async () => {
    await queue.stop();
  });

  it('borne la concurrence par tenant (groupConcurrency) sans affamer les autres tenants', async () => {
    const name = 'itest-group-conc';
    const CONCURRENCY = 3; // 3 jobs en vol max, tous tenants confondus (localConcurrency)
    const PAR_TENANT = 2; // 2 max pour un même tenant (localGroupConcurrency)
    const A = 5;
    const B = 2;
    const total = A + B;

    let active = 0;
    let peakTotal = 0;
    const activeByGroup: Record<'a' | 'b', number> = { a: 0, b: 0 };
    const peakByGroup: Record<'a' | 'b', number> = { a: 0, b: 0 };
    let aDone = 0;
    let bStartedWhileAPending = false;
    let done = 0;

    const finished = new Promise<void>((resolve) => {
      void queue.work(
        name,
        async (data) => {
          const g = (data as { g: 'a' | 'b' }).g;
          active += 1;
          activeByGroup[g] += 1;
          peakTotal = Math.max(peakTotal, active);
          peakByGroup[g] = Math.max(peakByGroup[g], activeByGroup[g]);
          // un tenant-b qui démarre alors que tous les tenant-a ne sont pas traités = pas de famine
          if (g === 'b' && aDone < A) bStartedWhileAPending = true;
          await new Promise((r) => setTimeout(r, 250));
          if (g === 'a') aDone += 1;
          active -= 1;
          activeByGroup[g] -= 1;
          done += 1;
          if (done === total) resolve();
        },
        { concurrency: CONCURRENCY, groupConcurrency: PAR_TENANT },
      );
    });

    for (let i = 0; i < A; i += 1) await queue.enqueue(name, { g: 'a', i }, { groupId: 'tenant-a' });
    for (let i = 0; i < B; i += 1) await queue.enqueue(name, { g: 'b', i }, { groupId: 'tenant-b' });

    await Promise.race([
      finished,
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout : les jobs ne se sont pas vidés')), 25000)),
    ]);

    // Plafond PAR tenant : sans localGroupConcurrency, tenant-a monterait à 3 (le plafond global). Rouge si retiré.
    expect(peakByGroup.a).toBeLessThanOrEqual(PAR_TENANT);
    // Plafond global : sans localConcurrency, un seul job en vol. Rouge si retiré.
    expect(peakTotal).toBeLessThanOrEqual(CONCURRENCY);
    // Preuve que la concurrence est réellement > 1 (sinon les deux bornes ci-dessus seraient vraies pour rien).
    expect(peakByGroup.a).toBeGreaterThan(1);
    // Non-famine : tenant-b n'attend pas la fin de tenant-a. Rouge si localConcurrency retiré (FIFO strict).
    expect(bStartedWhileAPending).toBe(true);
  });
});
